// Raw on-chain play metadata for the maintenance scripts (reconcile-tags,
// atlas-tags). Fetches every play through the app's own fcl.service so the
// scripts see exactly what the app syncs, with a --raw/--save-raw snapshot
// option for repeat runs without a full chain fetch.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initFCL, getTopshotStats, fetchPlayBatch } from "../../src/services/fcl.service.js";
import { withRetries } from "./retry.mjs";
import { runPool } from "./pool.mjs";
import { ROOT } from "./paths.mjs";

const BATCH_SIZE = 200;
const CONCURRENCY = 3;

// Re-exported for the existing importers (build-seed); the implementation
// lives in lib/retry.mjs now
export { withRetries } from "./retry.mjs";

// The previous seed's playsRaw, the standard `previousRaw` source: plays
// are immutable, so a script only fetches ids the seed lacks. ROOT-relative
// (a cwd-relative read used to miss the seed silently when run from
// anywhere but the repo root, causing a full 9,000-play refetch), and the
// miss reason is logged so a slow run explains itself.
export function loadSeedPlaysRaw() {
  const seedPath = path.join(ROOT, "public", "seed", "topshot-seed.json");
  try {
    const raw = JSON.parse(readFileSync(seedPath, "utf8")).playsRaw || null;
    if (!raw) console.log("seed snapshot has no playsRaw; fetching all plays");
    return raw;
  } catch (err) {
    console.log(`no usable seed snapshot (${err.code || err.message}); fetching all plays`);
    return null;
  }
}

// Returns { [playID]: rawMetadata } for every play on chain. Play
// metadata is immutable once minted, so entries in `previousRaw` (a
// prior snapshot, e.g. the last seed's playsRaw) are reused verbatim
// and only the ids it lacks are fetched.
export async function fetchRawPlays(previousRaw = null) {
  initFCL();
  const stats = await withRetries(() => getTopshotStats(), "stats");
  const maxPlayID = Number(stats.nextPlayID) - 1;
  const raw = previousRaw ? { ...previousRaw } : {};
  const ids = [];
  for (let i = 1; i <= maxPlayID; i++) {
    if (!raw[String(i)]) ids.push(i);
  }
  if (previousRaw) {
    console.log(`  reusing ${Object.keys(previousRaw).length} plays from the previous snapshot; ${ids.length} new to fetch`);
  }
  if (ids.length === 0) return raw;
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

  let done = 0;
  await runPool(batches, CONCURRENCY, async (batch) => {
    const fetched = await withRetries(() => fetchPlayBatch(batch), `plays ${batch[0]}-${batch[batch.length - 1]}`);
    fetched.forEach((p) => {
      if (p && p.metadata) raw[String(p.playID)] = p.metadata;
    });
    done += batch.length;
    process.stdout.write(`\r  fetched ${Math.min(done, ids.length)}/${ids.length} plays`);
  });
  process.stdout.write("\n");
  return raw;
}

// rawPath: read a saved snapshot instead of fetching; saveRawPath: save the
// fetched snapshot for later runs; previousRaw: prior play map whose
// entries are reused (plays are immutable), only new ids get fetched
export async function loadRawPlays({ rawPath = null, saveRawPath = null, previousRaw = null } = {}) {
  if (rawPath) {
    console.log(`Using raw snapshot ${rawPath}`);
    return JSON.parse(readFileSync(path.resolve(rawPath), "utf8"));
  }
  console.log("Fetching play metadata from Flow...");
  const raw = await fetchRawPlays(previousRaw);
  if (saveRawPath) {
    writeFileSync(path.resolve(saveRawPath), JSON.stringify(raw));
    console.log(`Saved raw snapshot to ${saveRawPath}`);
  }
  return raw;
}
