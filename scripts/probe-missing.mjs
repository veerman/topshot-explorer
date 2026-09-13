// Incremental IPFS probe: fills data/ipfs_media.json for CIDs that are on
// chain (per public/seed/topshot-seed.json) but absent from the lookup:
// editions newer than the original 2026-08-29 day-long run, the Platinum
// Ice sets the heavy chain query could never deliver, and the transient
// failures from that run's errors.log. NEVER re-probes existing entries;
// CIDs are content-addressed, so done is done forever.
//
// Downloads headers only, like the original run:
//   images: one ranged GET (128KB) carries dimensions + EXIF + the total
//           file size via Content-Range
//   videos: ffprobe pointed at the gateway URL fetches just the moov atom
//           via its own range requests; size comes from the ranged GET
//
// Usage:
//   node scripts/probe-missing.mjs [--limit N] [--concurrency N] [--dry]
// Results append to scratch/ipfs-probe/results-incremental.jsonl (resumable: rerun
// skips CIDs already probed); failures go to scratch/ipfs-probe/errors-incremental.log.
// When every missing CID is accounted for, the new entries merge into
// data/ipfs_media.json and data/ipfs_dead.json automatically.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { ROOT } from "./lib/paths.mjs";
import { flag, num } from "./lib/args.mjs";
import { withRetries } from "./lib/retry.mjs";
import { runPool } from "./lib/pool.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const GATEWAY = "https://ipfs.dapperlabs.com/ipfs/";
const HEAD_BYTES = 131072;
const PROBE_DIR = join(ROOT, "scratch", "ipfs-probe");
const RESULTS_PATH = join(PROBE_DIR, "results-incremental.jsonl");
const ERRORS_PATH = join(PROBE_DIR, "errors-incremental.log");
const MEDIA_PATH = join(ROOT, "data", "ipfs_media.json");
const DEAD_PATH = join(ROOT, "data", "ipfs_dead.json");

const LIMIT = num("--limit", Infinity);
const CONCURRENCY = num("--concurrency", 6);

// The probe dir is gitignored, so on a fresh checkout the first
// appendFileSync used to throw ENOENT out of the pool and kill the run
mkdirSync(PROBE_DIR, { recursive: true });

// ---- What is missing -------------------------------------------------
const mediaFile = JSON.parse(readFileSync(MEDIA_PATH, "utf8"));
const media = mediaFile.media;
const seed = JSON.parse(readFileSync(join(ROOT, "public", "seed", "topshot-seed.json"), "utf8"));
const chainCids = new Set();
seed.setDetails.forEach((sd) => sd.editions.forEach((ed) => {
  Object.values(ed.ipfsCIDs || {}).forEach((cid) => { if (cid) chainCids.add(cid); });
}));

const alreadyProbed = new Set();
if (existsSync(RESULTS_PATH)) {
  readFileSync(RESULTS_PATH, "utf8").split(/\r?\n/).filter(Boolean).forEach((l) => {
    try { alreadyProbed.add(JSON.parse(l).cid); } catch { /* ignore */ }
  });
}

const missing = [...chainCids].filter((c) => !(c in media) && !alreadyProbed.has(c));
console.log(`chain CIDs: ${chainCids.size} | in lookup: ${chainCids.size - missing.length - alreadyProbed.size + [...alreadyProbed].filter((c) => c in media).length} | to probe now: ${Math.min(missing.length, LIMIT)} (resumed past ${alreadyProbed.size})`);
if (flag("--dry")) process.exit(0);
const queue = missing.slice(0, LIMIT);

// ---- Helpers ---------------------------------------------------------

async function rangedGet(url) {
  const res = await fetch(url, { headers: { range: `bytes=0-${HEAD_BYTES - 1}` } });
  const type = res.headers.get("content-type") || "";
  if (res.status === 404 || type.includes("text/html")) {
    res.body?.cancel?.();
    return { dead: true, status: res.status, type };
  }
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  // Total size: Content-Range on 206, Content-Length on a full 200
  let size = null;
  const cr = res.headers.get("content-range");
  if (cr) {
    const m = cr.match(/\/(\d+)$/);
    if (m) size = Number(m[1]);
  } else if (res.status === 200) {
    const cl = res.headers.get("content-length");
    if (cl) size = Number(cl);
  }
  // Read at most HEAD_BYTES even if the server ignored the range
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { dead: false, size, bytes: buf };
}

// Minimal JPEG walker: dimensions from the first SOF marker, EXIF strings
// (Artist 0x013B, Model 0x0110, DateTime 0x0132) from APP1, MPO detection
// from an APP2 MPF block.
function parseJpeg(buf) {
  const out = { format: "jpg", width: null, height: null, author: null, camera: null, photoDate: null };
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      out.height = buf.readUInt16BE(off + 5);
      out.width = buf.readUInt16BE(off + 7);
      break; // dimensions are the last thing we need this deep
    }
    if (marker === 0xe1 && buf.slice(off + 4, off + 10).toString("latin1") === "Exif\0\0") {
      try { parseExif(buf.subarray(off + 10, off + 2 + len), out); } catch { /* EXIF is best-effort */ }
    }
    if (marker === 0xe2 && buf.slice(off + 4, off + 8).toString("latin1") === "MPF\0") {
      out.format = "mpo";
    }
    off += 2 + len;
  }
  return out;
}

function parseExif(tiff, out) {
  const little = tiff.slice(0, 2).toString("latin1") === "II";
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    if (![0x013b, 0x0110, 0x0132].includes(tag)) continue;
    const type = u16(e + 2);
    const n = u32(e + 4);
    if (type !== 2) continue; // ASCII
    const valOff = n <= 4 ? e + 8 : u32(e + 8);
    if (valOff + n > tiff.length) continue;
    const val = tiff.slice(valOff, valOff + n - 1).toString("latin1").trim();
    if (!val) continue;
    if (tag === 0x013b) out.author = val;
    if (tag === 0x0110) out.camera = val;
    if (tag === 0x0132) {
      const m = val.match(/^(\d{4}):(\d{2}):(\d{2})/);
      if (m) out.photoDate = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
}

function parsePng(buf) {
  return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function ffprobe(url) {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url],
      { timeout: 90000, maxBuffer: 4 * 1048576 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  });
}

async function probeOne(cid) {
  const url = GATEWAY + cid;
  const head = await rangedGet(url);
  if (head.dead) return { cid, dead: true };
  const buf = head.bytes;
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { cid, kind: "image", size: head.size, ...parsePng(buf) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = parseJpeg(buf);
    if (!img.width) throw new Error("jpeg dimensions not in first 128KB");
    return { cid, kind: "image", size: head.size, ...img };
  }
  // mp4 (ftyp) or anything else ffprobe can read: probe the URL directly
  const info = await ffprobe(url);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("no video stream");
  const duration = Number(info.format?.duration || v.duration || 0);
  return {
    cid,
    kind: "video",
    size: head.size,
    width: v.width,
    height: v.height,
    duration: Math.round(duration * 10) / 10,
    videoKbps: v.bit_rate ? Math.round(Number(v.bit_rate) / 1000) : null,
    audioKbps: a && a.bit_rate ? Math.round(Number(a.bit_rate) / 1000) : 0
  };
}

// ---- Run -------------------------------------------------------------
let done = 0, dead = 0, failed = 0;
await runPool(queue, CONCURRENCY, async (cid) => {
  let record = null;
  try {
    record = await withRetries(() => probeOne(cid), cid, { attempts: 3 });
  } catch (err) {
    failed++;
    appendFileSync(ERRORS_PATH, `${new Date().toISOString()} ${cid} ${String(err).slice(0, 200)}\n`);
  }
  if (record) {
    if (record.dead) dead++;
    appendFileSync(RESULTS_PATH, JSON.stringify(record) + "\n");
  }
  done++;
  process.stdout.write(`\r  probed ${done}/${queue.length} (dead ${dead}, failed ${failed})   `);
});
process.stdout.write("\n");

// ---- Merge into the lookup -------------------------------------------
// Only when nothing failed this run: a partial merge would make the failed
// CIDs look done to the resume logic's consumers. (Reruns are cheap.)
if (failed > 0) {
  console.log(`${failed} CID(s) failed after retries (see ${ERRORS_PATH}); rerun to retry them. Not merging yet.`);
  process.exit(1);
}

const trimTrailing = (arr) => {
  while (arr.length > 0 && (arr[arr.length - 1] === null || arr[arr.length - 1] === undefined)) arr.pop();
  return arr;
};

const records = readFileSync(RESULTS_PATH, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
let added = 0, newlyDead = 0;
const deadList = JSON.parse(readFileSync(DEAD_PATH, "utf8"));
const deadSet = new Set(deadList);
records.forEach((r) => {
  if (r.cid in media) return; // never overwrite
  if (r.dead) {
    media[r.cid] = 0;
    if (!deadSet.has(r.cid)) { deadSet.add(r.cid); deadList.push(r.cid); newlyDead++; }
  } else if (r.kind === "image") {
    media[r.cid] = trimTrailing([r.format, r.width, r.height, r.size ?? null, r.author ?? null, r.camera ?? null, r.photoDate ?? null]);
  } else {
    media[r.cid] = ["mp4", r.width, r.height, r.size ?? null, r.duration, r.videoKbps, r.audioKbps || 0];
  }
  added++;
});
// Idempotent source note: strip any prior incremental-probe clauses so the
// string carries one dated clause, not one per merge ever run
mediaFile._meta.source = String(mediaFile._meta.source)
  .replace(/; incremental probe \d{4}-\d{2}-\d{2} \(scripts\/probe-missing\.mjs\)/g, "")
  + `; incremental probe ${new Date().toISOString().slice(0, 10)} (scripts/probe-missing.mjs)`;
writeJsonAtomic(MEDIA_PATH, mediaFile);
writeJsonAtomic(DEAD_PATH, deadList);
console.log(`Merged ${added} new entries into ${MEDIA_PATH} (${newlyDead} newly dead -> ${DEAD_PATH}). Lookup now has ${Object.keys(media).length} entries.`);

// The home page's stat cards read the baked summary, keep it in step
await import("./build-ipfs-summary.mjs");
