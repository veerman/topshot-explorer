// Syncs the derived media tree into the R2 bucket behind
// cache.topshotexplorer.com (see docs/MEDIA-PIPELINE.md). Uploads what the
// bucket is missing, builds and uploads manifest.json, and DELETES thumbs
// whose CID has gone dead at Dapper's gateway (the origin-respect rule:
// removals at the origin propagate to us on the next sync).
//
// Bucket keys mirror the assets/ tree exactly, so the dev middleware
// (/assets/...) and the bucket serve the same relative paths:
//   derived/thumbs/v1/512/<cid>.jpg   immutable, 1 year (CID-addressed)
//   derived/setart/512/<file>.jpg     1 day (recipe reruns keep the name)
//   sets/<file>.jpg, logos/**         1 day
//   manifest.json                     5 minutes
//
// wrangler has no bucket listing or bulk upload, so state lives in the
// gitignored scratch/media-sync-state.json (key -> content signature) and
// each object is one `wrangler r2 object put`, pooled. Resumable: state is
// saved as it goes, and a re-run picks up where it stopped. Thumbs are
// never overwritten (content-addressed); other files re-upload when their
// md5 changes.
//
//   node scripts/media-sync.mjs [--dry-run] [--concurrency N]

import { readFileSync, readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT } from "./lib/paths.mjs";
import { flag, num } from "./lib/args.mjs";
import { runPool } from "./lib/pool.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const BUCKET = "topshot-explorer-cache";
const ASSETS = join(ROOT, "assets");
const STATE_PATH = join(ROOT, "scratch", "media-sync-state.json");

const dryRun = flag("--dry-run");
const concurrency = num("--concurrency", 6);

// wrangler's package exports hide the bin entry from resolve(), so point
// straight at the file (spawned as a script, not imported)
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
if (!existsSync(WRANGLER)) { console.error("wrangler not installed"); process.exit(1); }

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { uploaded: {} };
let stateDirty = 0;
const saveState = () => { writeJsonAtomic(STATE_PATH, state); stateDirty = 0; };

// ---- collect local files -> bucket keys ------------------------------
const IMMUTABLE = "public, max-age=31536000, immutable";
const DAILY = "public, max-age=86400";
const ctypeOf = (f) => (f.endsWith(".png") ? "image/png" : f.endsWith(".jpg") ? "image/jpeg" : "application/json");

const walk = (rel) => {
  const abs = join(ASSETS, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const childRel = posix.join(rel, e.name);
    if (e.isDirectory()) return walk(childRel);
    return /\.(png|jpg)$/i.test(e.name) ? [childRel] : [];
  });
};

const isThumb = (key) => key.startsWith("derived/thumbs/");
const md5 = (abs) => createHash("md5").update(readFileSync(abs)).digest("hex");
// Thumbs are content-addressed by CID: existence is the signature. Other
// files can change content under the same name, so they carry an md5.
const signature = (key, abs) => (isThumb(key) ? String(statSync(abs).size) : md5(abs));

const keys = [...walk("derived"), ...walk("sets"), ...walk("logos")];
const jobs = [];
for (const key of keys) {
  const abs = join(ASSETS, key);
  const sig = signature(key, abs);
  if (state.uploaded[key] === sig) continue;
  jobs.push({ key, abs, sig, cc: isThumb(key) ? IMMUTABLE : DAILY, ct: ctypeOf(key) });
}

// ---- manifest --------------------------------------------------------
// Same shape the dev middleware synthesizes, plus setArt: the cover file
// per set (files[0] in the extractor's index = the canonical square).
const list = (rel) => { try { return readdirSync(join(ASSETS, rel)).filter((f) => /\.(png|jpg)$/i.test(f)) } catch { return [] } };
const setArt = {};
try {
  const index = JSON.parse(readFileSync(join(ASSETS, "sets", "index.json"), "utf8"));
  for (const [setID, entry] of Object.entries(index.sets || {})) {
    if (entry?.files?.[0]?.file) setArt[setID] = entry.files[0].file;
  }
} catch { /* no index generated on this machine */ }
const manifest = {
  generated: new Date().toISOString().slice(0, 10),
  teams: { nba: list("logos/teams/nba"), wnba: list("logos/teams/wnba") },
  badges: list("logos/badges"),
  setArt
};

// ---- origin-respect deletions ---------------------------------------
const dead = JSON.parse(readFileSync(join(ROOT, "data", "ipfs_dead.json"), "utf8"));
const deletions = dead
  .map((cid) => `derived/thumbs/v1/512/${cid}.jpg`)
  .filter((key) => state.uploaded[key]);

console.log(`${keys.length} local files; ${jobs.length} to upload, ${deletions.length} dead thumbs to delete, manifest covers ${Object.keys(setArt).length} sets`);
if (dryRun) process.exit(0);

// ---- wrangler runner -------------------------------------------------
const wrangler = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [WRANGLER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out.slice(-300)))));
});

const putArgs = (j) => ["r2", "object", "put", `${BUCKET}/${j.key}`, "--file", j.abs, "--content-type", j.ct, "--cache-control", j.cc, "--remote"];

let done = 0;
const failures = [];
await runPool(jobs, concurrency, async (j) => {
  for (let attempt = 1; ; attempt++) {
    try {
      await wrangler(putArgs(j));
      state.uploaded[j.key] = j.sig;
      done++;
      if (++stateDirty >= 100) saveState();
      if (done % 250 === 0) console.log(`  ${done}/${jobs.length} uploaded...`);
      return;
    } catch (err) {
      if (attempt >= 3) { failures.push(`${j.key}: ${err.message.split("\n")[0]}`); return; }
    }
  }
});

for (const key of deletions) {
  try {
    await wrangler(["r2", "object", "delete", `${BUCKET}/${key}`, "--remote"]);
    delete state.uploaded[key];
    const local = join(ASSETS, key);
    if (existsSync(local)) unlinkSync(local);
    console.log(`deleted dead thumb ${key}`);
  } catch (err) {
    failures.push(`delete ${key}: ${err.message.split("\n")[0]}`);
  }
}

// Manifest last, so it never advertises files that are still uploading
try {
  writeJsonAtomic(join(ASSETS, "manifest.json"), manifest);
  await wrangler(["r2", "object", "put", `${BUCKET}/manifest.json`, "--file", join(ASSETS, "manifest.json"), "--content-type", "application/json", "--cache-control", "public, max-age=300", "--remote"]);
  console.log("manifest.json uploaded");
} catch (err) {
  failures.push(`manifest: ${err.message.split("\n")[0]}`);
}

saveState();
console.log(`uploaded ${done}, failed ${failures.length}, state saved`);
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  process.exitCode = 1;
}
