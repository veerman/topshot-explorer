// Derives the static media the site serves from cache.topshotexplorer.com
// (see docs/MEDIA-PIPELINE.md): one 512px jpg thumbnail per live HERO CID, plus
// 512px versions of the extracted set-art squares. Everything lands in the
// gitignored assets/derived/ tree; scripts/media-sync.mjs uploads it.
//
// Idempotent and resumable: outputs that already exist are skipped, so a
// re-run after new editions appear derives only the gap. Sources come from
// the local image mirror (ipfs_dirs.json search dirs); a CID missing from
// the mirror is fetched from the gateway once and saved into
// ipfs_cache/originals so the next run has it locally.
//
// Encode matches extract-set-art.mjs exactly (jpeg quality 92, mozjpeg,
// flattened to black): one consistent look across every derived file.
//
//   node scripts/media-derive.mjs [--dry-run] [--limit N] [--concurrency N]
//
// Dead CIDs (data/ipfs_dead.json) are never derived; media-sync.mjs also
// DELETES their thumbs from the bucket (the origin-respect rule: removals
// at Dapper's gateway propagate to us).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ROOT, findCachedImage } from "./lib/paths.mjs";
import { flag, num } from "./lib/args.mjs";
import { withRetries } from "./lib/retry.mjs";
import { runPool } from "./lib/pool.mjs";

const GATEWAY = "https://ipfs.dapperlabs.com/ipfs/";
const SIZE = 512;
const THUMBS_OUT = join(ROOT, "assets", "derived", "thumbs", "v1", String(SIZE));
const SETART_OUT = join(ROOT, "assets", "derived", "setart", String(SIZE));
const SETART_SRC = join(ROOT, "assets", "sets");
const FALLBACK_MIRROR = join(ROOT, "ipfs_cache", "originals");

const dryRun = flag("--dry-run");
const limit = num("--limit", Infinity);
const concurrency = num("--concurrency", 4);

const media = JSON.parse(readFileSync(join(ROOT, "data", "ipfs_media.json"), "utf8")).media;
const dead = new Set(JSON.parse(readFileSync(join(ROOT, "data", "ipfs_dead.json"), "utf8")));

// Heroes are the 2880x2880 squares (every edition and parallel has its
// own), plus whatever the chain records name as HERO regardless of size:
// a raw photo hero can be 2048, 1800 or smaller (500 of them, 2026-09-11),
// and without a thumb the cube trigger falls back to the glyph. The seed
// carries the standard editions' records; parallels' own heroes are the
// 2880 renders the size rule already catches. Dead CIDs carry 0 in the
// lookup and fail the array check. fullBleed (index 8, from the border
// census) marks heroes that are raw photographs with no border: those
// must NOT be trimmed.
const seedPath = join(ROOT, "public", "seed", "topshot-seed.json");
const namedHeroes = new Set();
if (existsSync(seedPath)) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  (seed.setDetails || []).forEach((s) => (s.editions || []).forEach((e) => {
    const cid = e.ipfsCIDs && e.ipfsCIDs.HERO;
    if (cid) namedHeroes.add(cid);
  }));
} else {
  console.warn("no public/seed/topshot-seed.json: heroes are the 2880 squares only (npm run seed first for the rest)");
}
const heroCids = Object.entries(media)
  .filter(([cid, v]) => Array.isArray(v) && v[0] !== "mp4" && !dead.has(cid)
    && ((v[1] === 2880 && v[2] === 2880) || namedHeroes.has(cid)))
  .map(([cid, v]) => ({ cid, fullBleed: v[8] === 1 }));

const setArtFiles = existsSync(SETART_SRC)
  ? readdirSync(SETART_SRC).filter((f) => f.endsWith(".jpg"))
  : [];

const thumbJobs = heroCids
  .map(({ cid, fullBleed }) => ({ cid, fullBleed, dest: join(THUMBS_OUT, `${cid}.jpg`) }))
  .filter((j) => !existsSync(j.dest));
const setArtJobs = setArtFiles
  .map((f) => ({ src: join(SETART_SRC, f), dest: join(SETART_OUT, f) }))
  .filter((j) => !existsSync(j.dest));

console.log(`heroes: ${heroCids.length} live, ${thumbJobs.length} missing a ${SIZE}px thumb`);
console.log(`set art: ${setArtFiles.length} squares, ${setArtJobs.length} missing a ${SIZE}px version`);
if (dryRun) process.exit(0);

mkdirSync(THUMBS_OUT, { recursive: true });
mkdirSync(SETART_OUT, { recursive: true });

// The mirror's write dir may live on another machine's drive; gap fetches
// go to the in-repo originals dir (a standing search dir) instead.
mkdirSync(FALLBACK_MIRROR, { recursive: true });
async function sourceFor(cid) {
  const local = findCachedImage(cid);
  if (local) return local;
  const buf = await withRetries(async () => {
    const res = await fetch(GATEWAY + cid);
    if (!res.ok) throw new Error(`${res.status} for ${cid}`);
    return Buffer.from(await res.arrayBuffer());
  }, `fetch ${cid}`, { attempts: 3, backoffMs: 2000, fatal: (e) => /\b404\b/.test(String(e)) });
  const ext = buf[0] === 0x89 ? "png" : "jpg";
  const dest = join(FALLBACK_MIRROR, `${cid}.${ext}`);
  writeFileSync(dest + ".part", buf);
  renameSync(dest + ".part", dest);
  return dest;
}

// Thumbnail spec: crop the detected padding/border
// first, THEN scale so the largest side is 512; the result need not be
// square. trim() references the top-left pixel, which handles both hero
// generations (png heroes pad with transparency, jpg heroes with black
// plus jpeg noise; threshold 10 absorbs the noise). flatten() runs after
// trim in sharp's pipeline, so transparent padding trims correctly and
// the remainder lands on black. Set-art squares and fullBleed heroes
// (raw photographs, border census index 8) are never trimmed.
const encode = async (input, trim) => {
  const run = (s) =>
    s.flatten({ background: "#000" })
      .resize(SIZE, SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  if (trim) {
    try {
      const { data, info } = await run(sharp(input).trim({ threshold: 10 }));
      // A collapsed trim (near-blank hero) stays tiny because enlargement
      // is off; fall through to the untrimmed frame instead
      if (Math.max(info.width, info.height) >= 300) return data;
    } catch { /* trim can reject blank images; use the full frame */ }
  }
  return (await run(sharp(input))).data;
};

let done = 0, fetched = 0, failed = 0;
const failures = [];
const finish = (dest, buf) => {
  writeFileSync(dest + ".part", buf);
  renameSync(dest + ".part", dest);
  done++;
  if (done % 500 === 0) console.log(`  ${done} derived...`);
};

const jobs = [
  ...setArtJobs.map((j) => async () => {
    finish(j.dest, await encode(j.src, false));
  }),
  ...thumbJobs.slice(0, limit).map((j) => async () => {
    try {
      const src = await sourceFor(j.cid);
      if (src.startsWith(FALLBACK_MIRROR)) fetched++;
      finish(j.dest, await encode(src, !j.fullBleed));
    } catch (err) {
      failed++;
      failures.push(`${j.cid}: ${err.message}`);
    }
  })
];

await runPool(jobs, concurrency, (job) => job());

console.log(`derived ${done} files (${fetched} sources fetched from the gateway), ${failed} failed`);
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  process.exitCode = 1;
}
