// Downloads every IPFS image (videos excluded) to a local cache, so
// thumbnails can be generated offline at any resolution later without
// touching the gateway again.
//
// The cache can span multiple drives: ipfs_dirs.json at the repo root
// (machine-specific, not committed) lists the directories to SEARCH and the
// one directory new downloads are WRITTEN to:
//
//   { "search": ["<mirror dir>", "ipfs_cache/originals"], "out": "<mirror dir>" }
//
// A file found complete in ANY search dir is skipped, so drives can be
// added over time (or split by media type later) without re-downloading.
//
// Idempotent and resumable: completeness is checked against the probe
// run's byte sizes (data/ipfs_media.json), partial downloads land in a
// .part file renamed only on success, and re-running fills the gaps.
// CIDs are content-addressed, so a complete file never goes stale.
//
//   node scripts/download-ipfs-images.mjs [--dry-run] [--limit N]
//        [--dirs A;B;C] [--out DIR] [--concurrency N]
//
//   --dry-run       count what is missing and estimate bytes, no network
//   --limit N       stop after N downloads (test batches)
//   --dirs A;B;C    override the search dirs (semicolon-separated)
//   --out DIR       override the write destination
//   --concurrency N parallel downloads (default 6)
//
// The gateway serves originals (2880x2880 heroes, multi-MB PNGs); the
// full set is ~46 GB, so mind the destination drive.

import { readFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { ROOT, loadDirConfig } from "./lib/paths.mjs";
import { flag, opt, num } from "./lib/args.mjs";
import { withRetries } from "./lib/retry.mjs";
import { runPool } from "./lib/pool.mjs";

const GATEWAY = "https://ipfs.dapperlabs.com/ipfs/";

const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

// Directory config: ipfs_dirs.json, overridable per run
let dirConfig;
try {
  dirConfig = { out: "ipfs_cache/originals", ...loadDirConfig() };
} catch (err) {
  console.error(`ipfs_dirs.json is unreadable: ${err.message}`);
  process.exit(1);
}
const SEARCH = (opt("--dirs", null) ? opt("--dirs", "").split(";") : dirConfig.search).filter(Boolean).map(abs);
const OUT = abs(opt("--out", dirConfig.out));
if (!SEARCH.includes(OUT)) SEARCH.push(OUT);

const DRY = flag("--dry-run");
const LIMIT = num("--limit", Infinity) || Infinity;
const CONCURRENCY = Math.max(1, num("--concurrency", 6) || 6);
const FAIL_LOG = join(OUT, "download-failed.txt");

const data = JSON.parse(readFileSync(join(ROOT, "data", "ipfs_media.json"), "utf8"));

// A file is complete when its size matches the probe's byte count (any
// size > 0 when the probe had none)
const complete = (file, expected) => {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  return expected === null ? size > 0 : size === expected;
};

// Images only: entries are [format, w, h, bytes, ...]; "mp4" is video, 0 is
// a dead CID the gateway has no content for
const jobs = [];
let alreadyCount = 0;
let alreadyBytes = 0;
for (const [cid, e] of Object.entries(data.media || {})) {
  if (!Array.isArray(e) || e[0] === "mp4") continue;
  const name = `${cid}.${e[0] || "img"}`;
  const expected = e[3] ?? null;
  const found = SEARCH.find((dir) => complete(join(dir, name), expected));
  if (found) {
    alreadyCount++;
    alreadyBytes += statSync(join(found, name)).size;
    continue;
  }
  jobs.push({ cid, file: join(OUT, name), expected });
}

const missingBytes = jobs.reduce((s, j) => s + (j.expected || 0), 0);
const gb = (b) => (b / 1073741824).toFixed(2);
console.log(`search dirs: ${SEARCH.join(" | ")}`);
console.log(`writing to: ${OUT}`);
console.log(`already complete: ${alreadyCount} images (${gb(alreadyBytes)} GB on disk)`);
console.log(`missing: ${jobs.length} images, ~${gb(missingBytes)} GB`);
if (DRY) process.exit(0);
if (jobs.length === 0) process.exit(0);

mkdirSync(OUT, { recursive: true });
writeFileSync(FAIL_LOG, "");

let done = 0, failed = 0, downloadedBytes = 0;
const startTime = Date.now();

async function fetchAttempt(job) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(GATEWAY + job.cid, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) throw new Error(`not an image: ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (job.expected !== null && buf.length !== job.expected) {
      throw new Error(`size mismatch: got ${buf.length}, probe said ${job.expected}`);
    }
    const part = `${job.file}.part`;
    writeFileSync(part, buf);
    renameSync(part, job.file);
    downloadedBytes += buf.length;
  } catch (err) {
    try { unlinkSync(`${job.file}.part`); } catch { /* never existed */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const queue = jobs.slice(0, LIMIT === Infinity ? undefined : LIMIT);
await runPool(queue, CONCURRENCY, async (job) => {
  try {
    await withRetries(() => fetchAttempt(job), job.cid, { attempts: 3 });
  } catch (err) {
    failed++;
    appendFileSync(FAIL_LOG, `${job.cid} ${err.cause?.message || err.message}\n`);
  }
  done++;
  if (done % 50 === 0 || done === queue.length) {
    const mins = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`${done}/${queue.length} done, ${failed} failed, ${gb(downloadedBytes)} GB, ${mins} min`);
  }
});
console.log(`finished: ${done - failed} downloaded, ${failed} failed (see ${FAIL_LOG}), ${gb(downloadedBytes)} GB this run`);
