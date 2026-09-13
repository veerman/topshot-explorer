import { applyEditionOverrides, attachMintTotals } from "./overrides.service";

const DB_NAME = "TopShotExplorerDB";
const DB_VERSION = 6; // 6: account_collections store (browsed-address moment cache)

// In-Memory RAM Caches
let playsCache = null;
let playsRawCache = null;
let setsCache = null;
let teamsCache = null;
let editionsCache = null;
let ipfsCache = null;

export function clearAllDBCaches() {
  playsCache = null;
  playsRawCache = null;
  setsCache = null;
  teamsCache = null;
  editionsCache = null;
  ipfsCache = null;
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
    playsCache = null;
    playsRawCache = null;
    return ok;
  });
}

export function getAllPlaysDB() {
  if (playsCache) {
    return Promise.resolve(playsCache);
  }
  // Each play carries its mint total (the debut rule needs it), joined
  // from the editions store on read so a plays record never goes stale
  // when mint counts refresh; saving editions drops this cache too
  return Promise.all([getAllRecords("plays"), getAllEditionsDB()]).then(([records, editions]) => {
    playsCache = attachMintTotals(records, editions);
    return playsCache;
  });
}

export function getAllPlaysRawDB() {
  // Cached like the other accessors: Home and Corrections both call this on
  // load and again on sync completion, and the map re-derived ~9,000
  // objects each time
  if (playsRawCache) {
    return Promise.resolve(playsRawCache);
  }
  return getAllPlaysDB().then((plays) => {
    playsRawCache = plays.map((play) => {
      if (play._raw) {
        return { playID: play.playID, ...play._raw };
      }
      return play;
    });
    return playsRawCache;
  });
}

// 7. Accessors for sets
export function saveSetsDB(setsArray) {
  return putRecordsBatch("sets", setsArray).then((ok) => {
    setsCache = null;
    return ok;
  });
}

export function getAllSetsDB() {
  if (setsCache) {
    return Promise.resolve(setsCache);
  }
  return getAllRecords("sets").then((records) => {
    setsCache = records;
    return records;
  });
}

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
    editionsCache = null;
    playsCache = null; // plays carry mint totals joined from editions
    playsRawCache = null;
    return ok;
  });
}

export function getAllEditionsDB() {
  if (editionsCache) {
    return Promise.resolve(editionsCache);
  }
  return getAllRecords("editions").then((records) => {
    editionsCache = records;
    return records;
  });
}

export function getSetEditionsDB(setID) {
  return getRecordsByKeyPrefix("editions", `${Number(setID)}_`);
}

// 9. Accessors for IPFS CIDs
export function saveIPFSCIDsDB(ipfsArray) {
  return putRecordsBatch("ipfs", ipfsArray).then((ok) => {
    ipfsCache = null;
    return ok;
  });
}

export function getAllIPFSDB() {
  if (ipfsCache) {
    return Promise.resolve(ipfsCache);
  }
  return getAllRecords("ipfs").then((records) => {
    ipfsCache = records;
    return records;
  });
}

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
          teamsCache = null;
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

export function getAllTeamsDB() {
  if (teamsCache) {
    return Promise.resolve(teamsCache);
  }
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
              teamsCache = results;
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
