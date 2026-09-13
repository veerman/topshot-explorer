// Deploy-time database seed. Fetches the full chain dataset through the
// app's own fcl.service (so the shapes match what the sync coordinator
// consumes verbatim) and writes public/seed/topshot-seed.json. A fresh
// browser bulk-loads that snapshot in seconds instead of walking the chain
// for a minute; the normal incremental sync then tops up anything newer.
// The file is optional everywhere: portable builds without it full-sync
// exactly as before.
//
// The edition rows are assembled from three LIGHT queries (sets overview
// playIDs for playOrder, getMintCounts for minted/retired, and a
// resolver-only CIDs script in chunks) instead of the app's heavy
// getSetDetails: that script blows the Cadence computation limit on the
// biggest set (set 27 fails at 100,002 of 100,000 units), which the app
// tolerates by skipping but a seed must not.
//
// Usage:
//   node --import ./scripts/node-json-hook.mjs scripts/build-seed.mjs [options]
//     --if-stale        skip when the existing seed is younger than 24h
//                       (used by deploy:cloudflare so UI-only redeploys
//                       don't pay a chain walk)
//     --raw <file>      reuse a saved raw-plays snapshot
//     --save-raw <file> save the fetched raw-plays snapshot for reuse
//     --full            ignore the previous seed and refetch everything
//                       (default runs are incremental: plays are immutable
//                       so only new ids are fetched, and LOCKED sets reuse
//                       their previous CIDs since a locked set can never
//                       gain plays)
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { initFCL, getTopshotStats, getSetsOverview, getMintCounts, getSetCIDs } from "../src/services/fcl.service.js";
import { loadRawPlays } from "./lib/raw-plays.mjs";
import { withRetries } from "./lib/retry.mjs";
import { runPool } from "./lib/pool.mjs";
import { flag, opt } from "./lib/args.mjs";
import { ROOT } from "./lib/paths.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const SEED_PATH = path.join(ROOT, "public", "seed", "topshot-seed.json");
const MAX_AGE_HOURS = 24;
const MINT_CHUNK = 10;
const CID_CHUNK = 150;
const CONCURRENCY = 3;

if (flag("--if-stale") && existsSync(SEED_PATH)) {
  const ageHours = (Date.now() - statSync(SEED_PATH).mtimeMs) / 3600000;
  if (ageHours < MAX_AGE_HOURS) {
    console.log(`Seed is ${ageHours.toFixed(1)}h old (< ${MAX_AGE_HOURS}h); skipping rebuild (--if-stale).`);
    process.exit(0);
  }
}

// Previous seed for incremental reuse (immutable data only)
let prevSeed = null;
if (!flag("--full") && existsSync(SEED_PATH)) {
  try {
    prevSeed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  } catch {
    console.warn("Previous seed unreadable; doing a full fetch.");
  }
}

initFCL();
const stats = await withRetries(() => getTopshotStats(), "stats");
const playsRaw = await loadRawPlays({ rawPath: opt("--raw"), saveRawPath: opt("--save-raw"), previousRaw: prevSeed?.playsRaw });

console.log("Fetching sets overview...");
const setsOverview = await withRetries(() => getSetsOverview(), "sets overview");

console.log(`Fetching mint counts for ${setsOverview.length} sets...`);
const mintCounts = {};
const setIDs = setsOverview.map((s) => Number(s.id)).sort((a, b) => a - b);
for (let i = 0; i < setIDs.length; i += MINT_CHUNK) {
  const chunk = setIDs.slice(i, i + MINT_CHUNK);
  Object.assign(mintCounts, await withRetries(() => getMintCounts(chunk), `mint counts ${chunk[0]}-${chunk[chunk.length - 1]}`));
  process.stdout.write(`\r  fetched ${Math.min(i + MINT_CHUNK, setIDs.length)}/${setIDs.length} sets`);
}
process.stdout.write("\n");

// CIDs from the previous seed, for sets that were ALREADY locked then:
// a locked set can never gain plays and registered CIDs never change,
// so those sets skip the chain entirely. Open sets always refetch.
const prevLockedCids = new Map();
if (prevSeed?.setsOverview && prevSeed?.setDetails) {
  const lockedBefore = new Set(prevSeed.setsOverview.filter((s) => s.locked).map((s) => Number(s.id)));
  for (const sd of prevSeed.setDetails) {
    if (!lockedBefore.has(Number(sd.id))) continue;
    const byPlay = {};
    for (const ed of sd.editions || []) byPlay[Number(ed.playID)] = ed.ipfsCIDs || {};
    prevLockedCids.set(Number(sd.id), byPlay);
  }
}

console.log(`Fetching IPFS CIDs for ${setsOverview.length} sets...`);
const cidsBySet = {};
let done = 0;
let reused = 0;
await runPool(setsOverview, CONCURRENCY, async (set) => {
  const playIDs = set.playIDs || [];
  const prior = set.locked ? prevLockedCids.get(Number(set.id)) : null;
  if (prior && playIDs.every((p) => prior[Number(p)] !== undefined)) {
    cidsBySet[Number(set.id)] = prior;
    done++;
    reused++;
    process.stdout.write(`\r  fetched ${done}/${setsOverview.length} sets`);
    return;
  }
  const merged = {};
  for (let i = 0; i < playIDs.length; i += CID_CHUNK) {
    const chunk = playIDs.slice(i, i + CID_CHUNK);
    Object.assign(merged, await withRetries(() => getSetCIDs(set.id, chunk), `cids set ${set.id}`));
  }
  cidsBySet[Number(set.id)] = merged;
  done++;
  process.stdout.write(`\r  fetched ${done}/${setsOverview.length} sets`);
});
process.stdout.write("\n");
if (reused > 0) console.log(`  CIDs reused for ${reused} locked sets from the previous seed`);

// Assemble the exact shape mapSetDetailsToRecords consumes in the app
const setDetails = setsOverview.map((set) => ({
  id: set.id,
  editions: (set.playIDs || []).map((playID, idx) => {
    const mc = (mintCounts[Number(set.id)] || {})[Number(playID)] || { minted: 0, retired: false };
    return {
      playID,
      retired: mc.retired,
      momentCount: mc.minted,
      playOrder: idx + 1,
      ipfsCIDs: (cidsBySet[Number(set.id)] || {})[Number(playID)] || {}
    };
  })
})).sort((a, b) => Number(a.id) - Number(b.id));

const seed = {
  generatedAt: new Date().toISOString(),
  stats,
  playsRaw,
  setsOverview,
  setDetails
};

writeJsonAtomic(SEED_PATH, seed);
const mb = (statSync(SEED_PATH).size / 1048576).toFixed(1);
const editionCount = setDetails.reduce((n, s) => n + s.editions.length, 0);
const cidCells = setDetails.reduce((n, s) => n + s.editions.filter((e) => Object.keys(e.ipfsCIDs).length > 0).length, 0);
console.log(`Wrote ${SEED_PATH} (${mb} MB): ${Object.keys(playsRaw).length} plays, ${setsOverview.length} sets, ${editionCount} editions (${cidCells} with CIDs).`);
