import {
  getTopshotStats,
  getSetsOverview,
  getSetDetails,
  getMintCounts,
  getSetCIDs,
  fetchPlayBatch
} from "./fcl.service";
import { compilePlayMetadata, compileSetMetadata, buildNameAliases, standardizePlayKeys } from "./overrides.service";
import {
  saveSyncStatsDB,
  getSyncStatsDB,
  savePlaysDB,
  saveSetsDB,
  saveEditionsDB,
  saveIPFSCIDsDB,
  clearAllStoresDB,
  clearStoresDB,
  clearAllDBCaches,
  getAllSetsDB,
  getAllEditionsDB,
  getAllIPFSDB,
  getAllPlaysRawDB,
  getAllSetsRawDB,
  saveTeamsDB,
  getAllPlaysDB,
  getAllTeamsDB
} from "./db.service";

import playsOverrides from "../../data/overrides/plays.json";
import playsAdditions from "../../data/additions/plays.json";
import setsOverrides from "../../data/overrides/sets.json";
import setsAdditions from "../../data/additions/sets.json";
import seriesOverrides from "../../data/overrides/series.json";
import seriesAdditions from "../../data/additions/series.json";
import editionsAdditions from "../../data/additions/editions.json";

// Central Sync Status State
let currentStatus = {
  syncedPlays: 0,
  totalPlays: 0,
  isSyncing: false,
  stage: "Idle", // Idle, Checking, Phase 1, Phase 2, Phase 3, Phase 4, Complete, Error
  progressPercent: 0
};

const listeners = new Set();

function notifyListeners() {
  listeners.forEach((listener) => listener({ ...currentStatus }));
}

export function subscribeSyncStatus(listener) {
  listeners.add(listener);
  listener({ ...currentStatus });
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncStatus() {
  return { ...currentStatus };
}

function updateStatus(newStatus) {
  currentStatus = { ...currentStatus, ...newStatus };
  notifyListeners();
}

// Cyrb128 fast non-cryptographic string hashing algorithm
export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3024733165, h3 = 3362453659, h4 = 50249325;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1^h2^h3^h4)>>>0, (h2^h1)>>>0, (h3^h1)>>>0, (h4^h1)>>>0].join("-");
}

// Bump when normalization logic changes (e.g. date formatting) so cached
// databases recompile their plays/sets from the stored _raw backups once.
const NORMALIZATION_VERSION = "3"; // 3: birthplace house format + canonical-name aliases

// The inputs are static imports, so the hash cannot change within a session;
// computing it once avoids re-serializing over a megabyte of JSON per call.
let cachedOverridesHash = null;

export function getCurrentOverridesHash() {
  if (cachedOverridesHash === null) {
    cachedOverridesHash = cyrb128(
      JSON.stringify(playsOverrides) +
      JSON.stringify(playsAdditions) +
      JSON.stringify(setsOverrides) +
      JSON.stringify(setsAdditions) +
      JSON.stringify(seriesOverrides) +
      JSON.stringify(seriesAdditions) +
      JSON.stringify(editionsAdditions) +
      NORMALIZATION_VERSION
    );
  }
  return cachedOverridesHash;
}

// Maps a getSetDetails() response into the editions and IPFS records persisted
// in IndexedDB. Shared by full sync, incremental sync, the IPFS-only refresh,
// and SetDetail's live-fallback path (exported so that page cannot drift
// from the sync writer's shape). Note: edition overrides are NOT applied
// here; the DB read path applies them, so a caller bypassing the DB must.
export function mapSetDetailsToRecords(setDetails) {
  const editions = setDetails.editions.map((ed) => ({
    id: `${setDetails.id}_${ed.playID}`,
    setID: setDetails.id,
    playID: ed.playID,
    momentCount: ed.momentCount,
    retired: ed.retired,
    playOrder: ed.playOrder
  }));

  const ipfsRecords = setDetails.editions
    .filter((ed) => ed.ipfsCIDs && Object.keys(ed.ipfsCIDs).length > 0)
    .map((ed) => ({
      id: `${setDetails.id}_${ed.playID}`,
      setID: setDetails.id,
      playID: ed.playID,
      cids: ed.ipfsCIDs
    }));

  return { editions, ipfsRecords };
}

/**
 * Fetches detailed editions and IPFS records for every set in the local DB.
 * Progress scales from progressStart to progressEnd while it runs. Used by the
 * IPFS-only refresh and by the empty-editions self-heal in runSmartSync.
 */
async function fetchAllSetDetails(progressStart, progressEnd) {
  const sets = await getAllSetsDB();
  const detailedEditions = [];
  const detailedIPFS = [];
  let failedSets = 0;

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    try {
      const details = await getSetDetails(set.id);
      const { editions, ipfsRecords } = mapSetDetailsToRecords(details);
      detailedEditions.push(...editions);
      detailedIPFS.push(...ipfsRecords);
    } catch (err) {
      failedSets++;
      console.warn(`Failed to sync detailed set details for set #${set.id}:`, err);
    }

    const progress = progressStart + Math.round(((i + 1) / sets.length) * (progressEnd - progressStart));
    updateStatus({ progressPercent: progress });
    await wait(10);
  }

  return { detailedEditions, detailedIPFS, failedSets, totalSets: sets.length };
}

// Stages that mean a sync pass just finished and pages should reload from DB.
// The IPFS stage may carry a partial-failure suffix, so match by prefix.
export function isSyncCompleteStage(stage) {
  return stage === "Up to date!" || (typeof stage === "string" && stage.startsWith("IPFS cache refreshed!"));
}

// Canonical-name aliases need every play's raw spelling, which a batch sync
// only has once it finishes: prime the aliases from the raw store, then
// recompile just the plays whose raw name IS an alias (a handful), so a
// late-arriving variant spelling lands as the canonical name.
async function applyNameAliasPass() {
  const rawPlays = await getAllPlaysRawDB();
  const aliases = buildNameAliases(rawPlays);
  if (aliases.size === 0) return;
  const affected = rawPlays.filter((p) => {
    const name = String(standardizePlayKeys(p._raw || p).FullName || "").trim().toLowerCase();
    return name && aliases.has(name);
  });
  if (affected.length === 0) return;
  const recompiled = affected.map((p) => {
    const rawCopy = { ...(p._raw || p) };
    delete rawCopy._raw;
    delete rawCopy.playID;
    return compilePlayMetadata(p.playID, rawCopy);
  }).filter(Boolean);
  await savePlaysDB(recompiled);
  console.log(`Name aliases: ${aliases.size} canonical spellings; recompiled ${recompiled.length} plays.`);
}

// Background database compiler. Returns true on success so callers only
// persist the new overrides hash when the recompile actually landed.
export async function recompileDatabase(newHash) {
  console.log("Recompiling plays and sets database with new overrides/additions configurations...");
  try {
    // 1. Recompile Plays from raw backups (aliases first: they come from
    // the overrides plus every play's raw name). Both raw reads are
    // independent; only the writes below are ordered.
    const [rawPlays, rawSetsRead] = await Promise.all([getAllPlaysRawDB(), getAllSetsRawDB()]);
    buildNameAliases(rawPlays);
    if (rawPlays.length > 0) {
      const compiledPlays = rawPlays.map((p) => {
        const rawCopy = p._raw || { ...p };
        delete rawCopy._raw;
        delete rawCopy.playID;
        return compilePlayMetadata(p.playID, rawCopy);
      }).filter(Boolean);
      await savePlaysDB(compiledPlays);
      await rebuildTeams();
    }

    // 2. Recompile Sets from raw backups
    const rawSets = rawSetsRead;
    if (rawSets.length > 0) {
      const compiledSets = rawSets.map((s) => {
        const rawCopy = s._raw || { ...s };
        delete rawCopy._raw;
        delete rawCopy.id;
        return compileSetMetadata({ id: s.id, ...rawCopy });
      }).filter(Boolean);
      await saveSetsDB(compiledSets);
    }

    // 3. Clear RAM Caches
    clearAllDBCaches();

    // 4. Update stored compile hash
    const stats = await getSyncStatsDB();
    if (stats) {
      stats.overridesHash = newHash;
      await saveSyncStatsDB(stats);
    }
    
    console.log("Database recompilation completed successfully!");
    return true;
  } catch (err) {
    console.error("Failed to recompile IndexedDB plays/sets database:", err);
    return false;
  }
}

// Automatically rebuild unique teams collection from plays
export async function rebuildTeams() {
  console.log("Rebuilding unique teams collection in IndexedDB...");
  try {
    const plays = await getAllPlaysDB();
    const teamsMap = {};
    
    plays.forEach((play) => {
      const nbaID = play.TeamAtMomentNBAID;
      if (!nbaID) return;
      
      const cleanNbaID = String(nbaID);
      if (!teamsMap[cleanNbaID]) {
        teamsMap[cleanNbaID] = {
          TeamName: play.TeamAtMoment || "",
          TeamID: play.CurrentTeamID ? String(play.CurrentTeamID) : undefined
        };
      } else {
        if (!teamsMap[cleanNbaID].TeamName && play.TeamAtMoment) {
          teamsMap[cleanNbaID].TeamName = play.TeamAtMoment;
        }
        if (!teamsMap[cleanNbaID].TeamID && play.CurrentTeamID) {
          teamsMap[cleanNbaID].TeamID = String(play.CurrentTeamID);
        }
      }
    });
    
    const teamsArray = Object.entries(teamsMap).map(([nbaID, data]) => ({
      key: nbaID,
      TeamName: data.TeamName,
      TeamID: data.TeamID
    }));
    await saveTeamsDB(teamsArray);
    console.log(`Teams collection rebuilt successfully with ${teamsArray.length} teams.`);
  } catch (err) {
    console.error("Failed to rebuild teams collection:", err);
  }
}

const PLAY_BATCH_SIZE = 200;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mint counts and retired flags keep changing for as long as an edition is
// open, but the incremental sync only ever fetched details for NEW sets, so
// every count in the editions store froze at whatever the first sync saw
// (and a pre-release database seeded with placeholder values never healed
// at all). This pass re-reads numberMintedPerPlay + retired for every set
// on every sync via the lightweight getMintCounts query (no IPFS resolver
// work) and rewrites only the rows that actually changed.
const MINT_REFRESH_CHUNK = 10;

async function refreshMintCounts() {
  const [sets, editions] = await Promise.all([getAllSetsDB(), getAllEditionsDB()]);
  if (sets.length === 0) return 0;
  const byID = new Map(editions.map((e) => [String(e.id), e]));
  const setIDs = sets.map((s) => Number(s.id)).sort((a, b) => a - b);
  const changed = [];
  for (let i = 0; i < setIDs.length; i += MINT_REFRESH_CHUNK) {
    const chunk = setIDs.slice(i, i + MINT_REFRESH_CHUNK);
    let counts;
    try {
      counts = await getMintCounts(chunk);
    } catch (err) {
      console.warn(`Mint-count refresh failed for sets ${chunk[0]}-${chunk[chunk.length - 1]}:`, err);
      continue;
    }
    Object.entries(counts).forEach(([setID, plays]) => {
      Object.entries(plays).forEach(([playID, v]) => {
        const row = byID.get(`${Number(setID)}_${Number(playID)}`);
        if (!row) return; // edition not synced yet; Phase 4 will create it
        if (Number(row.momentCount) !== v.minted || Boolean(row.retired) !== v.retired) {
          changed.push({ ...row, momentCount: v.minted, retired: v.retired });
        }
      });
    });
    updateStatus({ progressPercent: Math.min(99, Math.round(((i + chunk.length) / setIDs.length) * 100)) });
  }
  if (changed.length > 0) {
    await saveEditionsDB(changed);

    console.log(`Mint-count refresh: updated ${changed.length} of ${editions.length} editions.`);
  }
  return changed.length;
}

// Prebuilt database seed: a deploy-time snapshot of the full chain dataset
// (public/seed/topshot-seed.json, generated by scripts/build-seed.mjs). A
// fresh browser bulk-loads it in seconds instead of walking the chain for
// a minute; the caller then falls through to the normal incremental path,
// which tops up anything newer than the snapshot and refreshes mint
// counts. The file is optional: portable builds without it full-sync
// exactly as before. Returns the seeded sync-stats record, or null when no
// usable seed exists.
// The ?v= content hash pairs with the immutable /seed/* cache rule:
// unchanged seeds stay cached across deploys, changed ones bust cleanly
const SEED_URL = `/seed/topshot-seed.json?v=${typeof __SEED_VERSION__ !== "undefined" ? __SEED_VERSION__ : "0"}`;
const SEED_COMPILE_CHUNK = 500;

async function tryLoadSeedDatabase() {
  let seed;
  try {
    const res = await fetch(SEED_URL);
    // SPA hosting answers missing assets with the app shell as HTTP 200,
    // so the content type must actually be JSON before trusting it
    if (!res.ok || !String(res.headers.get("content-type") || "").includes("json")) return null;
    seed = await res.json();
  } catch {
    return null;
  }
  if (!seed || !seed.stats || !seed.playsRaw || !Array.isArray(seed.setsOverview) || !Array.isArray(seed.setDetails)) {
    return null;
  }
  console.log(`Seeding database from prebuilt snapshot (generated ${seed.generatedAt})...`);
  updateStatus({ stage: "Loading prebuilt database...", progressPercent: 5 });

  // Sets overview, then the edition/IPFS detail rows, exactly as the
  // phased full sync would save them
  await saveSetsDB(seed.setsOverview.map(compileSetMetadata));
  const detailedEditions = [];
  const detailedIPFS = [];
  seed.setDetails.forEach((details) => {
    const { editions, ipfsRecords } = mapSetDetailsToRecords(details);
    detailedEditions.push(...editions);
    detailedIPFS.push(...ipfsRecords);
  });
  await saveEditionsDB(detailedEditions);
  await saveIPFSCIDsDB(detailedIPFS);
  updateStatus({ progressPercent: 20 });

  // Plays: aliases first (they need every raw spelling), then compile in
  // chunks so the main thread never freezes
  const entries = Object.entries(seed.playsRaw);
  buildNameAliases(entries.map(([playID, md]) => ({ playID: Number(playID), _raw: md })));
  for (let i = 0; i < entries.length; i += SEED_COMPILE_CHUNK) {
    const chunk = entries.slice(i, i + SEED_COMPILE_CHUNK);
    const compiled = chunk
      .map(([playID, md]) => compilePlayMetadata(Number(playID), { ...md }))
      .filter(Boolean);
    await savePlaysDB(compiled);
    updateStatus({ progressPercent: 20 + Math.round(((i + chunk.length) / entries.length) * 75) });
    await wait(0);
  }
  await rebuildTeams();


  // The seed compiled against the bundled overrides, so the current hash is
  // correct; the counters are the chain's values at snapshot time, which is
  // what makes the follow-up incremental pass fetch only what came later
  const stats = {
    id: "current_stats",
    nextPlayID: Number(seed.stats.nextPlayID),
    nextSetID: Number(seed.stats.nextSetID),
    totalSupply: Number(seed.stats.totalSupply),
    overridesHash: getCurrentOverridesHash()
  };
  await saveSyncStatsDB(stats);
  console.log(`Seed loaded: ${entries.length} plays, ${seed.setsOverview.length} sets, ${detailedEditions.length} editions.`);
  return stats;
}

// Core Phased Coordinator
export async function runSmartSync() {
  if (currentStatus.isSyncing) return;
  
  updateStatus({
    isSyncing: true,
    stage: "Checking live contract status...",
    progressPercent: 0
  });

  try {
    const currentHash = getCurrentOverridesHash();

    // Step 1: Quick Contract Metrics (takes <100ms, Home page loads fast!)
    // and the cached sync state, in parallel (independent sources)
    const [liveStats, cachedStatsRead] = await Promise.all([getTopshotStats(), getSyncStatsDB()]);
    const liveMaxPlayID = liveStats.nextPlayID - 1;
    const liveMaxSetID = liveStats.nextSetID - 1;
    let cachedStats = cachedStatsRead;

    // Reconstruct sync stats if they are missing but the database already contains records
    if (!cachedStats) {
      const existingPlays = await getAllPlaysDB();
      const existingSets = await getAllSetsDB();
      if (existingPlays.length > 0 && existingSets.length > 0) {
        console.log("Sync stats were missing, but database is already populated. Reconstructing sync stats...");
        const maxPlayID = Math.max(...existingPlays.map((p) => Number(p.playID)), 0);
        const maxSetID = Math.max(...existingSets.map((s) => Number(s.id)), 0);
        
        cachedStats = {
          id: "current_stats",
          nextPlayID: maxPlayID + 1,
          nextSetID: maxSetID + 1,
          totalSupply: liveStats.totalSupply,
          overridesHash: currentHash
        };
        await saveSyncStatsDB(cachedStats);
      }
    }

    // Hash persisted with the sync stats below. Kept at the previous value when
    // a recompile fails, so the recompile retries on the next sync pass instead
    // of being silently marked as done.
    let persistHash = currentHash;

    // Auto-compilation check if overrides configuration changed
    if (cachedStats && cachedStats.overridesHash !== currentHash) {
      console.log("Local overrides/additions changes detected. Recompiling database plays & sets...");
      updateStatus({
        isSyncing: true,
        stage: "Recompiling data overrides...",
        progressPercent: 10
      });
      const recompiled = await recompileDatabase(currentHash);
      if (recompiled) {
        cachedStats.overridesHash = currentHash;
      } else {
        persistHash = cachedStats.overridesHash;
      }
    }

    // CASE 1: No cached stats -> bulk-load the prebuilt seed when the
    // deployment ships one, else execute the Phased Full Sync. A seeded
    // database falls through to the incremental path below, which tops up
    // anything newer than the snapshot and refreshes mint counts.
    if (!cachedStats) {
      cachedStats = await tryLoadSeedDatabase();
      if (!cachedStats) {
        console.log("No DB cache discovered. Initiating Phased Full Sync...");
        await performPhasedFullSync(liveStats);
        return;
      }
    }

    console.log("DB sync cache found. Processing incremental checks...", { cachedStats, liveStats });
    
    let playsToFetch = [];
    let setsToFetch = [];

    // Check plays
    if (liveMaxPlayID > cachedStats.nextPlayID - 1) {
      const cachedMax = cachedStats.nextPlayID - 1;
      for (let id = cachedMax + 1; id <= liveMaxPlayID; id++) {
        playsToFetch.push(id);
      }
    }

    // Check sets
    if (liveMaxSetID > cachedStats.nextSetID - 1) {
      const cachedMax = cachedStats.nextSetID - 1;
      for (let id = cachedMax + 1; id <= liveMaxSetID; id++) {
        setsToFetch.push(id);
      }
    }

    const totalSteps = playsToFetch.length + (setsToFetch.length * 2);
    let completedSteps = 0;

    if (totalSteps > 0) {
      updateStatus({
        totalPlays: liveMaxPlayID,
        stage: "Incremental updates detected. Syncing..."
      });
    } else {
      // Four independent store reads, all cold on a fresh page load; one
      // round of parallel IndexedDB transactions instead of four in series
      const [teams, existingSets, existingEditions, existingIpfs] = await Promise.all([
        getAllTeamsDB(),
        getAllSetsDB(),
        getAllEditionsDB(),
        getAllIPFSDB()
      ]);

      // Ensure teams database store is populated even if already up to date
      if (!teams || teams.length === 0) {
        await rebuildTeams();
      }

      // Self-heal: an interrupted first sync (e.g. a page refresh mid-sync)
      // can leave plays/sets populated while the editions/ipfs stores are
      // empty; the reconstructed sync stats then report up-to-date forever.
      // Backfill the editions and IPFS details when that state is detected.
      // Self-heal 2 (2026-09-01): prototype-seeded ipfs rows carry
      // placeholder CIDs like "bafy24170HERO"; real CIDs are 46+ chars
      // (CIDv0 Qm... = 46, CIDv1 bafy... = 59). Rebuild both detail stores
      // when any are found, mirroring the fabricated-momentCount fix.
      const hasFakeCids = existingIpfs.some((rec) =>
        Object.values(rec.cids || {}).some((cid) => cid && String(cid).length < 46));
      if (existingSets.length > 0 && (existingEditions.length === 0 || hasFakeCids)) {
        console.log(hasFakeCids
          ? "Fabricated placeholder IPFS CIDs detected. Rebuilding editions & IPFS details from chain..."
          : "Editions store is empty despite synced sets. Backfilling editions & IPFS details...");
        updateStatus({ stage: "Phase 4: Syncing IPFS CIDs & edition details...", progressPercent: 5 });
        const { detailedEditions, detailedIPFS } = await fetchAllSetDetails(5, 95);
        if (detailedEditions.length > 0) {
          // Wipe first so stale fabricated rows cannot survive the upsert
          if (hasFakeCids) await clearStoresDB(["editions", "ipfs"]);
          await saveEditionsDB(detailedEditions);
          await saveIPFSCIDsDB(detailedIPFS);

        }
      }

      // Self-heal 3 (2026-09-02): sets whose edition rows are missing
      // entirely (the fabricated-CID rebuild wiped the editions store and
      // refetched via getSetDetails, which blows the computation limit on
      // sets 27/52, deleting their rows for good) get placeholder rows
      // rebuilt from their own playIDs, exactly like Phase 1 of a full
      // sync; the mint-count refresh below fills in the real counts and
      // retired flags in the same pass. Cheap and idempotent, so it runs
      // every up-to-date pass.
      const setsWithEditions = new Set(existingEditions.map((e) => Number(e.setID)));
      const editionBare = existingSets.filter((s) => (s.playIDs || []).length > 0 && !setsWithEditions.has(Number(s.id)));
      if (editionBare.length > 0) {
        const placeholders = [];
        editionBare.forEach((set) => {
          (set.playIDs || []).forEach((playID, idx) => {
            placeholders.push({
              id: `${Number(set.id)}_${Number(playID)}`,
              setID: Number(set.id),
              playID: Number(playID),
              momentCount: 0,
              retired: false,
              playOrder: idx + 1
            });
          });
        });
        await saveEditionsDB(placeholders);

        console.log(`Edition placeholder heal: created ${placeholders.length} rows for ${editionBare.length} sets.`);
      }

      // Self-heal 4 (2026-09-02): the biggest sets (27 and 52, Platinum
      // Ice) blow the Cadence computation limit in getSetDetails, so every
      // sync path built on it leaves their editions without IPFS rows.
      // Backfill any set that has plays but zero ipfs rows through the
      // lightweight resolver-only query, once per browser (sets with no
      // registered media stay empty, so the flag stops repeat queries).
      if (localStorage.getItem("ipfs_light_heal_v1") !== "done") {
        try {
          const ipfsNow = await getAllIPFSDB();
          const setsWithRows = new Set(ipfsNow.map((r) => Number(r.setID)));
          const bare = existingSets.filter((s) => (s.playIDs || []).length > 0 && !setsWithRows.has(Number(s.id)));
          if (bare.length > 0) {
            updateStatus({ stage: "Backfilling IPFS CIDs...", progressPercent: 0 });
            const healed = [];
            for (const set of bare) {
              const playIDs = (set.playIDs || []).map(Number);
              for (let i = 0; i < playIDs.length; i += 150) {
                const cidsByPlay = await getSetCIDs(set.id, playIDs.slice(i, i + 150));
                Object.entries(cidsByPlay || {}).forEach(([playID, cids]) => {
                  if (cids && Object.keys(cids).length > 0) {
                    healed.push({ id: `${Number(set.id)}_${Number(playID)}`, setID: Number(set.id), playID: Number(playID), cids });
                  }
                });
              }
            }
            if (healed.length > 0) {
              await saveIPFSCIDsDB(healed);

              console.log(`IPFS light heal: backfilled ${healed.length} editions across ${bare.length} sets.`);
            }
          }
          localStorage.setItem("ipfs_light_heal_v1", "done");
        } catch (err) {
          console.warn("IPFS light backfill failed (offline?):", err);
        }
      }

      // Even with no new plays or sets, open editions keep minting: refresh
      // the stored counts so they track the chain instead of freezing
      updateStatus({ stage: "Refreshing mint counts...", progressPercent: 0 });
      try {
        await refreshMintCounts();
      } catch (err) {
        console.warn("Mint-count refresh failed (offline?):", err);
      }

      // Proactively keep sync stats up to date with on-chain values to prevent repetitive incremental checks
      await saveSyncStatsDB({ ...liveStats, overridesHash: persistHash });

      updateStatus({
        totalPlays: liveMaxPlayID,
        syncedPlays: liveMaxPlayID,
        isSyncing: false,
        stage: "Up to date!",
        progressPercent: 100
      });
      return;
    }

    // The sets overview serves both Phase 1 and the open-set expansion
    // check in Phase 3.5; fetch it at most once per sync pass
    let setsOverviewPromise = null;
    const fetchSetsOverviewOnce = () => {
      if (!setsOverviewPromise) setsOverviewPromise = getSetsOverview();
      return setsOverviewPromise;
    };

    // Phased Incremental 1: Load/sync sets overview
    if (setsToFetch.length > 0) {
      updateStatus({ stage: "Phase 1: Loading sets overview..." });
      const setsOverview = await fetchSetsOverviewOnce();
      // FCL decodes UInt32 as strings, so compare numerically: a strict
      // includes() on the numeric setsToFetch IDs never matched anything.
      const setsToFetchIDs = new Set(setsToFetch.map(Number));
      const newSets = setsOverview.filter(s => setsToFetchIDs.has(Number(s.id)));
      
      await saveSetsDB(newSets.map(compileSetMetadata));
      
      completedSteps += setsToFetch.length;
      updateStatus({
        progressPercent: Math.round((completedSteps / totalSteps) * 100)
      });
    }

    // Phased Incremental 2: Process local configurations (instantaneous)
    updateStatus({ stage: "Phase 2: Indexing local data configurations..." });
    await wait(100);

    // Phased Incremental 3: Sync play metadata
    if (playsToFetch.length > 0) {
      updateStatus({ stage: `Phase 3: Syncing ${playsToFetch.length} new plays...` });
      
      for (let i = 0; i < playsToFetch.length; i += PLAY_BATCH_SIZE) {
        const batch = playsToFetch.slice(i, i + PLAY_BATCH_SIZE);
        const fetched = await fetchPlayBatch(batch);
        
        const playsArray = fetched
          .filter(p => p.metadata)
          .map(p => compilePlayMetadata(p.playID, p.metadata));
        
        await savePlaysDB(playsArray);
        completedSteps += batch.length;
        updateStatus({
          progressPercent: Math.round((completedSteps / totalSteps) * 100)
        });
      }
      
      await rebuildTeams();

      // Check if any open sets expanded due to play additions on-chain
      try {
        console.log("Checking open sets for on-chain expansions...");
        const cachedSets = await getAllSetsDB();
        const openSets = cachedSets.filter(s => !s.locked);
        
        if (openSets.length > 0) {
          updateStatus({ stage: "Phase 3.5: Checking open sets for expansions..." });
          const liveSetsOverview = await fetchSetsOverviewOnce();
          const expandedSets = [];
          
          for (const openSet of openSets) {
            const liveSet = liveSetsOverview.find(ls => Number(ls.id) === Number(openSet.id));
            if (liveSet && liveSet.playIDs) {
              // Compare numerically: live playIDs arrive as strings from FCL
              const cachedPlayIDs = new Set((openSet.playIDs || []).map(Number));
              const hasNewPlays = liveSet.playIDs.some(id => !cachedPlayIDs.has(Number(id))) ||
                                  liveSet.playIDs.length !== cachedPlayIDs.size;
              
              if (hasNewPlays) {
                console.log(`Detected expanded open set #${openSet.id} (${openSet.setName})`);
                expandedSets.push(liveSet);
              }
            }
          }
          
          if (expandedSets.length > 0) {
            updateStatus({ stage: `Phase 3.5: Syncing ${expandedSets.length} expanded sets...` });
            
            // 1. Save updated sets to IndexedDB
            await saveSetsDB(expandedSets.map(compileSetMetadata));
            
            // 2. Fetch fresh set details (editions + IPFS media) for the expanded sets
            for (const set of expandedSets) {
              console.log(`Re-syncing editions/IPFS CIDs for expanded set #${set.id}`);
              const setDetails = await getSetDetails(set.id);
              const { editions, ipfsRecords } = mapSetDetailsToRecords(setDetails);
              await saveEditionsDB(editions);
              await saveIPFSCIDsDB(ipfsRecords);
            }
            console.log("Successfully updated all expanded sets.");
          } else {
            console.log("No open sets expanded.");
          }
        }
      } catch (err) {
        console.warn("Failed checking/updating expanded open sets:", err);
      }
    }

    // New plays can arrive with variant spellings whose canonical form only
    // the alias table knows, so the alias pass runs whenever anything was
    // fetched; it used to be gated on new sets, which the common
    // plays-only drop shape never triggered
    if (setsToFetch.length > 0 || playsToFetch.length > 0) {
      await applyNameAliasPass();
    }

    // Phased Incremental 4: Sync detailed IPFS CIDs & edition mint sizes
    if (setsToFetch.length > 0) {
      updateStatus({ stage: "Phase 4: Syncing IPFS CIDs & edition details..." });
      
      for (let id of setsToFetch) {
        try {
          const setDetails = await getSetDetails(id);
          const { editions, ipfsRecords } = mapSetDetailsToRecords(setDetails);
          await saveEditionsDB(editions);
          await saveIPFSCIDsDB(ipfsRecords);
        } catch (err) {
          console.warn(`Failed to sync set details for set #${id}:`, err);
        }
      }
    }

    // Refresh mint counts for the sets that were NOT refetched above
    updateStatus({ stage: "Refreshing mint counts..." });
    try {
      await refreshMintCounts();
    } catch (err) {
      console.warn("Mint-count refresh failed (offline?):", err);
    }

    // Save sync stats to DB
    await saveSyncStatsDB({ ...liveStats, overridesHash: persistHash });

    
    updateStatus({
      syncedPlays: liveMaxPlayID,
      totalPlays: liveMaxPlayID,
      isSyncing: false,
      stage: "Up to date!",
      progressPercent: 100
    });

  } catch (err) {
    console.error("Incremental sync failed:", err);
    updateStatus({
      isSyncing: false,
      stage: "Sync error occurred"
    });
  }
}

// Force re-sync trigger
export async function forceFullSync() {
  updateStatus({
    isSyncing: true,
    stage: "Wiping database stores...",
    progressPercent: 0
  });

  try {
    await clearAllStoresDB();
    // The once-per-browser IPFS backfill must rerun after a wipe, or the
    // Platinum Ice sets (which the heavy set-details query cannot deliver)
    // would stay without media rows forever
    try { localStorage.removeItem("ipfs_light_heal_v1"); } catch { /* ignore */ }
    const liveStats = await getTopshotStats();
    await performPhasedFullSync(liveStats);
  } catch (err) {
    console.error("Force full re-sync failed:", err);
    updateStatus({ isSyncing: false, stage: "Wipe error occurred" });
  }
}

// Sequenced Data Loading Pipeline
async function performPhasedFullSync(liveStats) {
  const maxPlayID = liveStats.nextPlayID - 1;

  updateStatus({
    totalPlays: maxPlayID,
    syncedPlays: 0,
    progressPercent: 0
  });

  try {
    // ----------------------------------------------------
    // PHASE 1: Load Sets Overview (takes < 200ms)
    // ----------------------------------------------------
    updateStatus({ stage: "Phase 1: Loading sets overview...", progressPercent: 5 });
    console.log("Phase 1: Querying sets list overview...");
    const setsOverview = await getSetsOverview();
    
    // Save sets overview data immediately to DB
    const setsArray = setsOverview.map(compileSetMetadata);
    await saveSetsDB(setsArray);
    
    // Populate placeholder editions so Sets page renders aggregated mint counts safely
    const initialEditions = [];
    setsOverview.forEach((set) => {
      set.playIDs.forEach((playID, idx) => {
        initialEditions.push({
          id: `${set.id}_${playID}`,
          setID: set.id,
          playID: playID,
          momentCount: 0, // Placeholder populated as 0, detailed values loaded in Phase 4
          retired: false,
          playOrder: idx + 1
        });
      });
    });
    await saveEditionsDB(initialEditions);

    // ----------------------------------------------------
    // PHASE 2: Load Local Configurations from /data Folder (takes < 50ms)
    // ----------------------------------------------------
    updateStatus({ stage: "Phase 2: Loading local configuration files...", progressPercent: 10 });

    // The overrides & additions files are already statically imported and
    // bundled; log their sizes for visibility without re-importing anything.
    console.log("Phase 2 complete: Local overrides & additions files verified.", {
      overrides: {
        series: Object.keys(seriesOverrides).length,
        sets: Object.keys(setsOverrides).length,
        plays: Object.keys(playsOverrides).length
      },
      additions: {
        series: Object.keys(seriesAdditions).length,
        sets: Object.keys(setsAdditions).length,
        plays: Object.keys(playsAdditions).length,
        editions: Object.keys(editionsAdditions).length
      }
    });
    await wait(200); // Small visual pause for user readability

    // ----------------------------------------------------
    // PHASE 3: Load Plays Metadata (takes ~ 10 seconds)
    // ----------------------------------------------------
    updateStatus({ stage: "Phase 3: Syncing plays metadata database...", progressPercent: 15 });
    console.log(`Phase 3: Syncing ${maxPlayID} play metadata records...`);
    
    const allPlayIDs = Array.from({ length: maxPlayID }, (_, i) => i + 1);
    let playsSynced = 0;

    for (let i = 0; i < allPlayIDs.length; i += PLAY_BATCH_SIZE) {
      const batch = allPlayIDs.slice(i, i + PLAY_BATCH_SIZE);
      const fetched = await fetchPlayBatch(batch);
      
      const playsBatch = fetched
        .filter(p => p.metadata)
        .map(p => compilePlayMetadata(p.playID, p.metadata));
      
      await savePlaysDB(playsBatch);
      
      playsSynced += batch.length;
      // Plays sync progress scales from 15% up to 60%
      const playsProgress = 15 + Math.round((playsSynced / maxPlayID) * 45);
      
      updateStatus({
        syncedPlays: playsSynced,
        progressPercent: playsProgress
      });
      
      await wait(30); // Prevent main thread freezing
    }
    
    await rebuildTeams();

    // ----------------------------------------------------
    // PHASE 4: Load IPFS Media & Editions detailed mint sizes (takes ~ 15 seconds)
    // ----------------------------------------------------
    await applyNameAliasPass();
    updateStatus({ stage: "Phase 4: Syncing IPFS CIDs & edition details...", progressPercent: 60 });
    console.log("Phase 4: Querying detailed set edition mint counts and IPFS media files...");
    
    const detailedEditions = [];
    const detailedIPFS = [];

    for (let i = 0; i < setsOverview.length; i++) {
      const set = setsOverview[i];
      try {
        const details = await getSetDetails(set.id);
        const { editions, ipfsRecords } = mapSetDetailsToRecords(details);
        detailedEditions.push(...editions);
        detailedIPFS.push(...ipfsRecords);
      } catch (err) {
        console.warn(`Failed to sync detailed set details for set #${set.id}:`, err);
      }

      // IPFS sync progress scales from 60% up to 98%
      const ipfsProgress = 60 + Math.round(((i + 1) / setsOverview.length) * 38);
      updateStatus({ progressPercent: ipfsProgress });
      
      await wait(10);
    }

    // Bulk save detailed editions and IPFS details
    await saveEditionsDB(detailedEditions);
    await saveIPFSCIDsDB(detailedIPFS);

    // Save final stats and complete
    await saveSyncStatsDB({ ...liveStats, overridesHash: getCurrentOverridesHash() });

    
    updateStatus({
      syncedPlays: maxPlayID,
      isSyncing: false,
      stage: "Up to date!",
      progressPercent: 100
    });

    console.log("Phased Full Sync completed successfully!");

  } catch (err) {
    console.error("Phased Full Sync failed:", err);
    updateStatus({
      isSyncing: false,
      stage: "Sync error occurred"
    });
    throw err;
  }
}

// The old syncIPFSCacheOnly (Settings' "Refresh IPFS & Editions Cache")
// was removed 2026-09-02: its per-set getSetDetails refetch cannot deliver
// the biggest sets (27/52 blow the computation limit), so it would gut
// their rows, and the automatic self-heals above cover every case it
// existed for. Force Full Re-Sync remains as the manual escape hatch.
