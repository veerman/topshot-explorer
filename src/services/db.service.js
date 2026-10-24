import { applyEditionOverrides, attachMintTotals } from "./overrides.service";

const DB_NAME = "TopShotExplorerDB";
const DB_VERSION = 6; // 6: account_collections store (browsed-address moment cache)

// In-memory RAM caches, one per store. Callers asking at the same time
// share the read in flight: Home asked for plays and raw plays together,
// which read the plays store twice and editions and sets three times. A
// write clears its cache once it lands and bumps a generation, so a read
// begun before the write never refills the cache with the rows it replaced.
function cachedRead(load) {
  let value = null;
  let pending = null;
  let generation = 0;
  return {
    get() {
      if (value) return Promise.resolve(value);
      if (pending) return pending;
      const g = generation;
      const p = load().then((v) => {
        if (g === generation) value = v;
        if (pending === p) pending = null;
        return v;
      }, (err) => {
        if (pending === p) pending = null;
        throw err;
      });
      pending = p;
      return p;
    },
    clear() {
      value = null;
      pending = null;
      generation += 1;
    }
  };
}

// Each play carries its mint total and whether it sits in a Rookie
// Ultimate set (the debut rule needs both), joined from the editions and
// sets stores on read so a plays record never goes stale when mint
// counts refresh; saving editions drops this cache too
const playsCache = cachedRead(() => Promise.all([getAllRecords("plays"), getAllEditionsDB(), getAllSetsDB()])
  .then(([records, editions, sets]) => attachMintTotals(records, editions, sets)));
// Home and Corrections both read this on load and again on sync
// completion, and the map re-derived ~9,000 objects each time
const playsRawCache = cachedRead(() => getAllPlaysDB().then((plays) => plays.map((play) => (play._raw ? { playID: play.playID, ...play._raw } : play))));
const setsCache = cachedRead(() => getAllRecords("sets"));
const editionsCache = cachedRead(() => getAllRecords("editions"));
const ipfsCache = cachedRead(() => getAllRecords("ipfs"));
const teamsCache = cachedRead(() => readAllTeams());

export function clearAllDBCaches() {
  [playsCache, playsRawCache, setsCache, teamsCache, editionsCache, ipfsCache].forEach((c) => c.clear());
}

// 1. Establish and Open Database
export function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = (e) => reject(e.target.error);

      request.onblocked = () => {
        // Another tab holds an older connection; its onversionchange handler
        // closes it, after which this open request proceeds on its own.
        // Rejecting here made every read silently resolve empty in multi-tab
        // scenarios.
        console.warn("IndexedDB open blocked by another tab. Waiting for other connections to close...");
      };

      request.onsuccess = (e) => {
        const db = e.target.result;
        db.onversionchange = () => {
          db.close();
          resetSharedConnection();
          console.warn("Database version change requested. Connection closed to prevent deadlock.");
        };
        db.onclose = () => {
          resetSharedConnection();
        };
        resolve(db);
      };

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Store 1: plays - Key is playID (integer)
        if (!db.objectStoreNames.contains("plays")) {
          db.createObjectStore("plays", { keyPath: "playID" });
        }

        // Store 2: sets - Key is id (integer)
        if (!db.objectStoreNames.contains("sets")) {
          db.createObjectStore("sets", { keyPath: "id" });
        }

        // Store 3: editions - Key is a compound key (string: "setID_playID")
        if (!db.objectStoreNames.contains("editions")) {
          db.createObjectStore("editions", { keyPath: "id" });
        }

        // Store 4: ipfs - Key is a compound key (string: "setID_playID")
        if (!db.objectStoreNames.contains("ipfs")) {
          db.createObjectStore("ipfs", { keyPath: "id" });
        }

        // Store 5: sync_stats - Key is a static string ("current_stats")
        if (!db.objectStoreNames.contains("sync_stats")) {
          db.createObjectStore("sync_stats", { keyPath: "id" });
        }

        // Store 6: teams - Key is TeamAtMomentNBAID (out-of-line keys, recreate if keyPath was present)
        if (db.objectStoreNames.contains("teams")) {
          db.deleteObjectStore("teams");
        }
        db.createObjectStore("teams");

        // Store 7: account_collections - one record per browsed address:
        // { address, fetchedAt, moments: [[momentID, setID, playID, serial, subeditionID], ...] }
        if (!db.objectStoreNames.contains("account_collections")) {
          db.createObjectStore("account_collections", { keyPath: "address" });
        }
      };
    } catch (err) {
      reject(err);
    }
  });
}

// Shared connection: opening a fresh connection per operation added measurable
// latency to every read. All accessors reuse one connection; it is reset when
// the browser closes it or a version change is requested.
//
// Error contract: a failed database OPEN rejects out of every accessor, so
// pages surface their LoadError panels (and the sync coordinator its error
// status) instead of rendering silently empty when IndexedDB is broken or
// blocked. Per-request errors on a healthy connection still resolve
// empty/null: one bad read should degrade, not take down the page.
let sharedDBPromise = null;

function resetSharedConnection() {
  sharedDBPromise = null;
}

function getDB() {
  if (!sharedDBPromise) {
    sharedDBPromise = openDB().catch((err) => {
      resetSharedConnection();
      throw err;
    });
  }
  return sharedDBPromise;
}

// 2. Generic Single Record Get
export function getRecord(storeName, key) {
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => {
          // A throw inside this callback escapes the outer try/catch and
          // leaves the promise unresolved forever, so guard it separately
          try {
            let res = req.result;
            if (res) {
              if (storeName === "editions") {
                res = applyEditionOverrides(res);
              }
            }
            resolve(res);
          } catch (err) {
            console.warn(`IndexedDB getRecord post-processing error for "${storeName}":`, err);
            resolve(req.result ?? null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn(`IndexedDB getRecord error for store "${storeName}":`, err);
        resetSharedConnection();
        resolve(null);
      }
    });
  });
}

// 3. Generic Get All (optionally constrained to an IDBKeyRange)
export function getAllRecords(storeName, keyRange) {
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = keyRange ? store.getAll(keyRange) : store.getAll();
        req.onsuccess = () => {
          // A throw inside this callback escapes the outer try/catch and
          // leaves the promise unresolved forever, so guard it separately
          try {
            let results = req.result || [];
            if (storeName === "editions") {
              results = results.map(applyEditionOverrides);
            }
            resolve(results);
          } catch (err) {
            console.warn(`IndexedDB getAllRecords post-processing error for "${storeName}":`, err);
            resolve(req.result || []);
          }
        };
        req.onerror = () => resolve([]);
      } catch (err) {
        console.warn(`IndexedDB getAllRecords error for store "${storeName}":`, err);
        resetSharedConnection();
        resolve([]);
      }
    });
  });
}

// Compound-key prefix scan for the "setID_playID" keyed stores. Uses a key
// range instead of scanning and filtering the entire store. The upper bound
// appends U+FFFF, which sorts after every character that can follow the prefix.
function getRecordsByKeyPrefix(storeName, prefix) {
  const range = IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff));
  return getAllRecords(storeName, range);
}

// 4. Generic Put Single Record
export function putRecord(storeName, value) {
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const req = store.put(value);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn(`IndexedDB putRecord error for store "${storeName}":`, err);
        resetSharedConnection();
        resolve(null);
      }
    });
  });
}

// 5. Generic Put Records Batch (for fast bulk insertions)
export function putRecordsBatch(storeName, values) {
  if (!values || values.length === 0) return Promise.resolve(true);

  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);

        values.forEach((val) => {
          store.put(val);
        });

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (err) {
        console.warn(`IndexedDB putRecordsBatch error for store "${storeName}":`, err);
        resetSharedConnection();
        resolve(false);
      }
    });
  });
}

// 6. Accessors for plays
export function savePlaysDB(playsArray) {
  return putRecordsBatch("plays", playsArray).then((ok) => {
    // Invalidate the RAM cache only after the write lands; invalidating before
    // let a concurrent read repopulate the cache with pre-write data.
    playsCache.clear();
    playsRawCache.clear();
    return ok;
  });
}

export const getAllPlaysDB = () => playsCache.get();

export const getAllPlaysRawDB = () => playsRawCache.get();

// 7. Accessors for sets
export function saveSetsDB(setsArray) {
  return putRecordsBatch("sets", setsArray).then((ok) => {
    setsCache.clear();
    playsCache.clear(); // plays carry the Rookie Ultimate mark joined from sets
    return ok;
  });
}

export const getAllSetsDB = () => setsCache.get();

export function getAllSetsRawDB() {
  return getAllSetsDB().then((sets) => {
    return sets.map((set) => {
      if (set._raw) {
        return { id: set.id, ...set._raw };
      }
      return set;
    });
  });
}

// 8. Accessors for editions
export function saveEditionsDB(editionsArray) {
  return putRecordsBatch("editions", editionsArray).then((ok) => {
    editionsCache.clear();
    playsCache.clear(); // plays carry mint totals joined from editions
    playsRawCache.clear();
    return ok;
  });
}

export const getAllEditionsDB = () => editionsCache.get();

export function getSetEditionsDB(setID) {
  return getRecordsByKeyPrefix("editions", `${Number(setID)}_`);
}

// 9. Accessors for IPFS CIDs
export function saveIPFSCIDsDB(ipfsArray) {
  return putRecordsBatch("ipfs", ipfsArray).then((ok) => {
    ipfsCache.clear();
    return ok;
  });
}

export const getAllIPFSDB = () => ipfsCache.get();

export function getSetIPFSDB(setID) {
  return getRecordsByKeyPrefix("ipfs", `${Number(setID)}_`);
}

// 10. Accessors for Sync Stats
export function saveSyncStatsDB(stats) {
  return putRecord("sync_stats", {
    id: "current_stats",
    ...stats,
    lastSyncTime: new Date().toISOString()
  });
}

export function getSyncStatsDB() {
  return getRecord("sync_stats", "current_stats");
}

// 11. Clear Data Wipes
export function clearStoresDB(stores) {
  clearAllDBCaches();
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(stores, "readwrite");

        stores.forEach((s) => {
          try {
            tx.objectStore(s).clear();
          } catch (e) {
            console.warn(`IndexedDB clear error for store "${s}":`, e);
          }
        });

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (err) {
        console.warn("IndexedDB clearStoresDB error:", err);
        resetSharedConnection();
        resolve(false);
      }
    });
  });
}

export function clearAllStoresDB() {
  return clearStoresDB(["plays", "sets", "editions", "ipfs", "sync_stats", "teams"]);
}

// Cached collection for a browsed account address (see account.context.js)
export function getAccountCollectionDB(address) {
  return getRecord("account_collections", String(address).toLowerCase());
}

export function saveAccountCollectionDB(record) {
  return putRecord("account_collections", { ...record, address: String(record.address).toLowerCase() });
}

// 12. Accessors for teams
export function saveTeamsDB(teamsArray) {
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("teams", "readwrite");
        const store = tx.objectStore("teams");

        teamsArray.forEach((team) => {
          const { key, ...rest } = team;
          store.put(rest, key);
        });

        tx.oncomplete = () => {
          teamsCache.clear();
          resolve(true);
        };
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (err) {
        console.warn("saveTeamsDB error:", err);
        resetSharedConnection();
        resolve(false);
      }
    });
  });
}

export const getAllTeamsDB = () => teamsCache.get();

function readAllTeams() {
  return getDB().then((db) => {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("teams", "readonly");
        const store = tx.objectStore("teams");
        const results = [];

        const req = store.openCursor();
        req.onsuccess = (e) => {
          // Guarded separately: a throw here escapes the outer try/catch and
          // leaves the promise unresolved forever
          try {
            const cursor = e.target.result;
            if (cursor) {
              results.push({
                TeamAtMomentNBAID: cursor.key,
                ...cursor.value
              });
              cursor.continue();
            } else {
              resolve(results);
            }
          } catch (err) {
            console.warn("getAllTeamsDB cursor error:", err);
            resolve(results);
          }
        };
        req.onerror = () => resolve([]);
      } catch (err) {
        console.warn("getAllTeamsDB error:", err);
        resetSharedConnection();
        resolve([]);
      }
    });
  });
}
