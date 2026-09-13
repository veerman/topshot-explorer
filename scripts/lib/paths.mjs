// Repo root and cache-dir helpers for the maintenance scripts, importable
// WITHOUT dragging sharp in (several non-pixel scripts used to import ROOT
// from hero-split.mjs and paid sharp's native module load for it).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ipfs_dirs.json: { search: [dir, ...] } of local image-mirror directories.
// Memoized: findCachedImage runs per CID (thousands of calls in per-team
// extractions) and used to re-read and re-parse the config every time.
let dirConfigCache = null;
export function loadDirConfig() {
  if (!dirConfigCache) {
    let dirConfig = { search: ["ipfs_cache/originals"] };
    const configPath = join(ROOT, "ipfs_dirs.json");
    if (existsSync(configPath)) dirConfig = { ...dirConfig, ...JSON.parse(readFileSync(configPath, "utf8")) };
    dirConfigCache = dirConfig;
  }
  return dirConfigCache;
}

export function findCachedImage(cid) {
  for (const dir of loadDirConfig().search.map((p) => (isAbsolute(p) ? p : join(ROOT, p)))) {
    for (const ext of ["jpg", "png", "jpeg"]) {
      const p = join(dir, `${cid}.${ext}`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
