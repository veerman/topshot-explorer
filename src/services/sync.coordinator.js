import {
  getTopshotStats,
  getSetsOverview,
  getSetDetails,
  getMintCounts,
  getSetCIDs,
  fetchPlayBatch
} from "./fcl.service";
import { compilePlayMetadata, compileSetMetadata, buildNameAliases, hasBlankBioField, standardizePlayKeys, teamKeyForPlay, areOverridesDisabled } from "./overrides.service";
import {
  saveSyncStatsDB,
  getSyncStatsDB,
  savePlaysDB,
  saveSetsDB,
  saveEditionsDB,
  saveIPFSCIDsDB,
  clearAllStoresDB,
  clearAllDBCaches,
  getAllSetsDB,
  getAllEditionsDB,
  getAllIPFSDB,
  getAllPlaysRawDB,
  getAllSetsRawDB,
  saveTeamsDB,
  getAllPlaysDB,
  getAllTeamsDB,
  getAllRecords
} from "./db.service";

import playsOverrides from "../../data/overrides/plays.json";
import playsAdditions from "../../data/additions/plays.json";
import setsOverrides from "../../data/overrides/sets.json";
import setsAdditions from "../../data/additions/sets.json";
import seriesOverrides from "../../data/overrides/series.json";
import seriesAdditions from "../../data/additions/series.json";
import editionsAdditions from "../../data/additions/editions.json";
import teamsAdditions from "../../data/additions/teams.json";

// Progress chatter: on in development, and in production only when the
// console asks for it (localStorage.debugSync = "1"). Warnings and errors
// always print.
const DEBUG_SYNC = import.meta.env.DEV
  || (typeof localStorage !== "undefined" && localStorage.getItem("debugSync") === "1");
const log = (...args) => { if (DEBUG_SYNC) console.log(...args); };

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
const NORMALIZATION_VERSION = "8"; // 8: the chain's "+0000 UTC" timestamps read as ISO (Safari kept the UTC day); 7: weights as bare pounds; 6: the play 9088+ mint format (team names and ids, play types, bare dates, heights, file-name taglines, team reels, bio fill); 5: Team Coop on the 2026 WNBA All-Star plays; 4: All-Star entities on the 2025 final plays, Hornets id, Rookie Mint tags dropped

// The hash covers exactly what the stored compile reads: the play and set
// corrections, teams.json (team names and ids, team reels and the bio
// fill all resolve through it), NORMALIZATION_VERSION, and the Settings
// switch that turns corrections off. Series names and edition additions
// are applied when data is read, never stored, so they stay out: hashing
// them recompiled every play in every browser for nothing, while a
// teams.json fix never reached a stored database. With the switch in the
// hash, a recompile cut short (Settings reloads the page soon after) is
// redone on the next sync.
// The files are static imports, so only the switch can change within a
// session; hashing them once avoids re-serializing a megabyte per call.
let cachedFilesHash = null;

export function getCurrentOverridesHash() {
  if (cachedFilesHash === null) {
    cachedFilesHash = cyrb128(
      JSON.stringify(playsOverrides) +
      JSON.stringify(playsAdditions) +
      JSON.stringify(setsOverrides) +
      JSON.stringify(setsAdditions) +
      JSON.stringify(teamsAdditions) +
      NORMALIZATION_VERSION
    );
  }
  return areOverridesDisabled() ? `${cachedFilesHash}:off` : cachedFilesHash;
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
      console.warn(`Failed to sync detailed set details for set ${set.id}:`, err);
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

// Canonical-name aliases and the player bio fill need every play, which a
// batch sync only has once it finishes: prime both from the raw store, then
// recompile just the plays whose raw name IS an alias or that have a blank
// bio field (a few hundred), so a late-arriving variant spelling lands as
// the canonical name and a new mint's blanks take the player's known facts.
async function applyNameAliasPass() {
  const rawPlays = await getAllPlaysRawDB();
  const aliases = buildNameAliases(rawPlays);
  const affected = rawPlays.filter((p) => {
    const raw = p._raw || p;
    const name = String(standardizePlayKeys(raw).FullName || "").trim().toLowerCase();
    return (name && aliases.has(name)) || hasBlankBioField(raw);
  });
  if (affected.length === 0) return;
  const recompiled = affected.map((p) => {
    const rawCopy = { ...(p._raw || p) };
    delete rawCopy._raw;
    delete rawCopy.playID;
    return compilePlayMetadata(p.playID, rawCopy);
  }).filter(Boolean);
  await savePlaysDB(recompiled);
  log(`Name aliases: ${aliases.size} canonical spellings; recompiled ${recompiled.length} plays.`);
}

// Background database compiler. Returns true on success so callers only
// persist the new overrides hash when the recompile actually landed.
export async function recompileDatabase(newHash) {
  log("Recompiling plays and sets database with new overrides/additions configurations...");
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
    
    log("Database recompilation completed successfully!");
    return true;
  } catch (err) {
    console.error("Failed to recompile IndexedDB plays/sets database:", err);
    return false;
  }
}

// Automatically rebuild unique teams collection from plays
export async function rebuildTeams() {
  log("Rebuilding unique teams collection in IndexedDB...");
  try {
    const plays = await getAllPlaysDB();
    const teamsMap = {};
    
    plays.forEach((play) => {
      // The stats id, or the special entry's key for a squad without one
      const nbaID = teamKeyForPlay(play);
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
    log(`Teams collection rebuilt successfully with ${teamsArray.length} teams.`);
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
// Chain calls in flight at once in the per-visit passes
const SYNC_CONCURRENCY = 4;

/** Runs fn over items, `limit` at a time */
async function inPool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function refreshMintCounts() {
  const [sets, editions] = await Promise.all([getAllSetsDB(), getAllEditionsDB()]);
  if (sets.length === 0) return 0;
  const byID = new Map(editions.map((e) => [String(e.id), e]));
  // A locked set gains no plays and a retired edition mints no more, so a
  // locked set whose editions are all retired has counts that can never
  // change (184 of 285 sets on 2026-10-23): it is not asked again
  const settled = (s) => s.locked && (s.playIDs || []).length > 0
    && s.playIDs.every((p) => (byID.get(`${Number(s.id)}_${Number(p)}`) || {}).retired === true);
  const setIDs = sets.filter((s) => !settled(s)).map((s) => Number(s.id)).sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < setIDs.length; i += MINT_REFRESH_CHUNK) chunks.push(setIDs.slice(i, i + MINT_REFRESH_CHUNK));
  const changed = [];
  let done = 0;
  await inPool(chunks, SYNC_CONCURRENCY, async (chunk) => {
    let counts = null;
    try {
      counts = await getMintCounts(chunk);
    } catch (err) {
      console.warn(`Mint-count refresh failed for sets ${chunk[0]}-${chunk[chunk.length - 1]}:`, err);
    }
    Object.entries(counts || {}).forEach(([setID, plays]) => {
      Object.entries(plays).forEach(([playID, v]) => {
        const row = byID.get(`${Number(setID)}_${Number(playID)}`);
        if (!row) return; // edition not synced yet; Phase 4 will create it
        if (Number(row.momentCount) !== v.minted || Boolean(row.retired) !== v.retired) {
          // Chain fields only: rows read back carry editions.json merged in
          changed.push({ id: row.id, setID: row.setID, playID: row.playID, momentCount: v.minted, retired: v.retired, playOrder: row.playOrder });
        }
      });
    });
    done++;
    updateStatus({ progressPercent: Math.min(99, Math.round((done / chunks.length) * 100)) });
  });
  if (changed.length > 0) {
    await saveEditionsDB(changed);

    log(`Mint-count refresh: updated ${changed.length} of ${editions.length} editions.`);
  }
  return changed.length;
}

// Plays can be edited on chain after the mint (the TopShot contract update
// of 2026-09-22, FOUNDATION 2.4), but a browser never fetched a play twice.
// Each sync re-reads one batch of plays, a batch further along each visit
// (about 47 visits cover the catalogue, then it starts over), and
// recompiles only a play whose raw chain metadata changed. Edits are rare,
// so this is the gentle version: one small request per visit, never a
// re-download of everything. Returns the cursor for the next visit.
const sameRaw = (a, b) => {
  const ka = Object.keys(a || {});
  return ka.length === Object.keys(b || {}).length && ka.every((k) => a[k] === b[k]);
};

async function refreshPlaysSlice(cursor, maxPlayID) {
  const start = cursor >= 1 && cursor <= maxPlayID ? cursor : 1;
  const end = Math.min(start + PLAY_BATCH_SIZE - 1, maxPlayID);
  const ids = [];
  for (let id = start; id <= end; id++) ids.push(id);
  const [fetched, stored] = await Promise.all([
    fetchPlayBatch(ids),
    getAllRecords("plays", IDBKeyRange.bound(start, end))
  ]);
  const storedRaw = new Map(stored.map((p) => [Number(p.playID), p._raw]));
  const changed = new Map();
  // A play missing from the store (a write that never landed) is stored
  // now, like an edited one
  fetched.forEach((p) => {
    const id = Number(p.playID);
    if (p.metadata && (!storedRaw.has(id) || !sameRaw(storedRaw.get(id), p.metadata))) changed.set(id, p.metadata);
  });
  if (changed.size > 0) {
    // Prime the name aliases and the player bio index with the new values
    // first, so the edited plays compile exactly as a full recompile would
    const rawPlays = (await getAllPlaysRawDB()).map((p) => (changed.has(Number(p.playID)) ? { playID: p.playID, ...changed.get(Number(p.playID)) } : p));
    buildNameAliases(rawPlays);
    await savePlaysDB([...changed].map(([id, md]) => compilePlayMetadata(id, { ...md })).filter(Boolean));
    await rebuildTeams();
    log(`Play refresh: ${changed.size} of plays ${start}-${end} changed on chain or were missing; recompiled.`);
  }
  return end >= maxPlayID ? 1 : end + 1;
}

// Sets keep changing after a browser first stored them: Dapper creates
// plays first and fills a set later (274 of 285 sets hold plays older than
// the set), so a visit that sees no new play id can still bring new
// editions; sets get locked; and media is registered on an edition long
// after its mint (no 2026 WNBA set had any on 2026-10-23). The seed carries
// all of that to new browsers only. This pass, on every visit, carries it
// to returning ones from the one sets-overview call (edge-cached), plus a
// call only for what changed and a few sets' missing media per visit.
const MEDIA_SETS_PER_VISIT = 5;

/** CID rows for these plays of a set (150 per resolver call); empty when none registered */
async function fetchCidRows(setID, playIDs) {
  const rows = [];
  for (let i = 0; i < playIDs.length; i += 150) {
    const cidsByPlay = await getSetCIDs(setID, playIDs.slice(i, i + 150));
    Object.entries(cidsByPlay || {}).forEach(([playID, cids]) => {
      if (cids && Object.keys(cids).length > 0) {
        rows.push({ id: `${Number(setID)}_${Number(playID)}`, setID: Number(setID), playID: Number(playID), cids });
      }
    });
  }
  return rows;
}

/** Returns the media cursor for the next visit (a set id; the walk goes down from it) */
async function refreshSets(liveSets, mediaCursor) {
  const [storedSets, editions, ipfs] = await Promise.all([getAllSetsDB(), getAllEditionsDB(), getAllIPFSDB()]);
  const setByID = new Map(storedSets.map((s) => [Number(s.id), s]));
  const editionsBySet = new Map();
  editions.forEach((e) => {
    const s = Number(e.setID);
    if (!editionsBySet.has(s)) editionsBySet.set(s, new Map());
    editionsBySet.get(s).set(Number(e.playID), e);
  });

  // 1. Plays added to a set, and sets locked since. A grown set's edition
  // rows and its new plays' media land before the set row, so a failure
  // leaves the set as it was and the next visit tries again
  const changed = [];
  for (const live of liveSets) {
    const have = setByID.get(Number(live.id));
    if (!have) continue; // a new set arrives through Phases 1 and 4
    const livePlays = (live.playIDs || []).map(Number);
    const havePlays = (have.playIDs || []).map(Number);
    const samePlays = livePlays.length === havePlays.length && livePlays.every((p, i) => p === havePlays[i]);
    if (samePlays && Boolean(have.locked) === Boolean(live.locked)) continue;
    if (!samePlays) {
      const stored = editionsBySet.get(Number(live.id)) || new Map();
      // Chain fields only: rows read back carry editions.json merged in.
      // A new row's count is filled by the mint-count refresh after this
      const rows = livePlays.map((playID, idx) => {
        const e = stored.get(playID);
        return { id: `${Number(live.id)}_${playID}`, setID: Number(live.id), playID, momentCount: e ? Number(e.momentCount) || 0 : 0, retired: e ? Boolean(e.retired) : false, playOrder: idx + 1 };
      });
      await saveEditionsDB(rows);
      await saveIPFSCIDsDB(await fetchCidRows(live.id, livePlays.filter((p) => !stored.has(p))));
      log(`Set ${live.id} (${live.setName}) now holds ${livePlays.length} plays, was ${havePlays.length}.`);
    }
    changed.push(live);
  }
  if (changed.length > 0) await saveSetsDB(changed.map(compileSetMetadata));

  // 2. Media registered after the mint: a few sets with editions still
  // without any, newest first, the walk resuming where the last visit
  // stopped and wrapping at the oldest
  const withMedia = new Set(ipfs.filter((r) => Object.keys(r.cids || {}).length > 0).map((r) => String(r.id)));
  const skip = new Set(changed.map((s) => Number(s.id)));
  const missing = new Map(); // setID -> playIDs without media
  editions.forEach((e) => {
    const s = Number(e.setID);
    if (skip.has(s) || withMedia.has(`${s}_${Number(e.playID)}`)) return;
    if (!missing.has(s)) missing.set(s, []);
    missing.get(s).push(Number(e.playID));
  });
  const ids = [...missing.keys()].sort((a, b) => b - a);
  const below = Number(mediaCursor) > 0 ? Number(mediaCursor) : Infinity;
  const picks = ids.filter((id) => id < below).slice(0, MEDIA_SETS_PER_VISIT);
  for (const id of ids) {
    if (picks.length >= Math.min(MEDIA_SETS_PER_VISIT, ids.length)) break;
    if (!picks.includes(id)) picks.push(id);
  }
  let found = 0;
  await inPool(picks, SYNC_CONCURRENCY, async (id) => {
    const rows = await fetchCidRows(id, missing.get(id));
    await saveIPFSCIDsDB(rows);
    found += rows.length;
  });
  if (found > 0) log(`Media refresh: ${found} editions gained media across sets ${picks.join(", ")}.`);
  return picks.length > 0 ? picks[picks.length - 1] : mediaCursor;
}

// The sets pass both sync branches run; its media cursor is persisted with
// the stats (kept as it was when offline)
async function nextMediaRefreshCursor(cachedStats, loadSetsOverview) {
  try {
    return await refreshSets(await loadSetsOverview(), cachedStats.mediaRefreshCursor);
  } catch (err) {
    console.warn("Sets refresh failed (offline?):", err);
    return cachedStats.mediaRefreshCursor;
  }
}

// The pass both sync branches run before saving the stats: the cursor it
// returns is persisted with them (kept as it was when offline)
async function nextPlayRefreshCursor(cachedStats, maxPlayID) {
  try {
    return await refreshPlaysSlice(Number(cachedStats.playRefreshCursor) || 1, maxPlayID);
  } catch (err) {
    console.warn("Play refresh failed (offline?):", err);
    return cachedStats.playRefreshCursor;
  }
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
  log(`Seeding database from prebuilt snapshot (generated ${seed.generatedAt})...`);
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
  log(`Seed loaded: ${entries.length} plays, ${seed.setsOverview.length} sets, ${detailedEditions.length} editions.`);
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
        log("Sync stats were missing, but database is already populated. Reconstructing sync stats...");
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
      log("Local overrides/additions changes detected. Recompiling database plays & sets...");
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
        log("No DB cache discovered. Initiating Phased Full Sync...");
        await performPhasedFullSync(liveStats);
        return;
      }
    }

    log("DB sync cache found. Processing incremental checks...", { cachedStats, liveStats });
    
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
      // Three independent store reads, all cold on a fresh page load; one
      // round of parallel IndexedDB transactions instead of three in series
      const [teams, existingSets, existingEditions] = await Promise.all([
        getAllTeamsDB(),
        getAllSetsDB(),
        getAllEditionsDB()
      ]);

      // Ensure teams database store is populated even if already up to date
      if (!teams || teams.length === 0) {
        await rebuildTeams();
      }

      // Self-heal: an interrupted first sync (e.g. a page refresh mid-sync)
      // can leave plays/sets populated while the editions/ipfs stores are
      // empty; the reconstructed sync stats then report up-to-date forever.
      // Backfill the editions and IPFS details when that state is detected.
      // (A second heal, for placeholder CIDs from a 2026 prototype, wiped
      // both stores and refetched through getSetDetails, which cannot
      // return the biggest sets; it was removed so it can never gut them.)
      if (existingSets.length > 0 && existingEditions.length === 0) {
        log("Editions store is empty despite synced sets. Backfilling editions & IPFS details...");
        updateStatus({ stage: "Phase 4: Syncing IPFS CIDs & edition details...", progressPercent: 5 });
        const { detailedEditions, detailedIPFS } = await fetchAllSetDetails(5, 95);
        if (detailedEditions.length > 0) {
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

        log(`Edition placeholder heal: created ${placeholders.length} rows for ${editionBare.length} sets.`);
      }

      // Plays added to stored sets, locks, and media registered since
      // (refreshSets; it also covers the biggest sets, 27 and 52, which
      // getSetDetails cannot return and the once-per-browser media heal
      // used to backfill)
      const mediaRefreshCursor = await nextMediaRefreshCursor(cachedStats, getSetsOverview);

      // Even with no new plays or sets, open editions keep minting: refresh
      // the stored counts so they track the chain instead of freezing
      updateStatus({ stage: "Refreshing mint counts...", progressPercent: 0 });
      try {
        await refreshMintCounts();
      } catch (err) {
        console.warn("Mint-count refresh failed (offline?):", err);
      }

      // One batch of existing plays, read again for on-chain edits
      const playRefreshCursor = await nextPlayRefreshCursor(cachedStats, liveMaxPlayID);

      // Proactively keep sync stats up to date with on-chain values to prevent repetitive incremental checks
      await saveSyncStatsDB({ ...liveStats, overridesHash: persistHash, playRefreshCursor, mediaRefreshCursor });

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
          console.warn(`Failed to sync set details for set ${id}:`, err);
        }
      }
    }

    // Plays added to stored sets, locks, and media registered since
    const mediaRefreshCursor = await nextMediaRefreshCursor(cachedStats, fetchSetsOverviewOnce);

    // Refresh mint counts for the sets that were NOT refetched above
    updateStatus({ stage: "Refreshing mint counts..." });
    try {
      await refreshMintCounts();
    } catch (err) {
      console.warn("Mint-count refresh failed (offline?):", err);
    }

    // One batch of existing plays, read again for on-chain edits
    const playRefreshCursor = await nextPlayRefreshCursor(cachedStats, liveMaxPlayID);

    // Save sync stats to DB
    await saveSyncStatsDB({ ...liveStats, overridesHash: persistHash, playRefreshCursor, mediaRefreshCursor });

    
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

// Force re-sync trigger: wipe every store, then run a first visit,
// which loads the prebuilt seed when the deployment ships one and walks
// the chain only when it does not
export async function forceFullSync() {
  if (currentStatus.isSyncing) return;
  updateStatus({ stage: "Wiping database stores...", progressPercent: 0 });
  if (!(await clearAllStoresDB())) {
    updateStatus({ stage: "Wipe error occurred" });
    return;
  }
  await runSmartSync();
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
    log("Phase 1: Querying sets list overview...");
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
    log("Phase 2 complete: Local overrides & additions files verified.", {
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
    log(`Phase 3: Syncing ${maxPlayID} play metadata records...`);
    
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
    log("Phase 4: Querying detailed set edition mint counts and IPFS media files...");
    
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
        console.warn(`Failed to sync detailed set details for set ${set.id}:`, err);
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

    log("Phased Full Sync completed successfully!");

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
