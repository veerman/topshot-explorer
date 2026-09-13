// Distills data/ipfs_media.json (5.7MB, lazy-loaded by media pages) into
// data/ipfs_media_summary.json (under 1KB, imported by the home page), so
// the landing page's four stat cards and resolution chips never pull the
// big lookup. Rerun after scripts/probe-missing.mjs merges new entries
// (probe-missing does this itself on a clean merge).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/paths.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const SRC = join(ROOT, "data", "ipfs_media.json");
const OUT = join(ROOT, "data", "ipfs_media_summary.json");
const IMG_DIMS_SHOWN = 5;

const { media } = JSON.parse(readFileSync(SRC, "utf8"));

const s = { total: 0, videos: 0, jpg: 0, png: 0, mpo: 0, dead: 0, seconds: 0, bytes: 0 };
const vidDims = new Map();
const imgDims = new Map();
for (const e of Object.values(media)) {
  if (e === 0) { s.dead++; s.total++; continue; }
  if (!Array.isArray(e)) continue;
  s.total++;
  if (e[0] === "mp4") {
    s.videos++;
    s.seconds += e[4] || 0;
    // Size estimated from bitrate x duration where the probe missed it
    s.bytes += e[3] != null ? e[3] : (e[4] || 0) * ((e[5] || 0) + (e[6] || 0)) * 125;
    const d = `${e[1]}x${e[2]}`;
    vidDims.set(d, (vidDims.get(d) || 0) + 1);
  } else {
    if (e[0] === "jpg") s.jpg++;
    else if (e[0] === "png") s.png++;
    else s.mpo++;
    s.bytes += e[3] || 0;
    const d = `${e[1]}x${e[2]}`;
    imgDims.set(d, (imgDims.get(d) || 0) + 1);
  }
}

const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const imgSorted = sorted(imgDims);
const summary = {
  generatedAt: new Date().toISOString().slice(0, 10),
  ...s,
  seconds: Math.round(s.seconds),
  bytes: Math.round(s.bytes),
  vidDims: sorted(vidDims),
  imgDims: imgSorted.slice(0, IMG_DIMS_SHOWN),
  imgDimsMore: Math.max(0, imgSorted.length - IMG_DIMS_SHOWN)
};

writeJsonAtomic(OUT, summary);
console.log(`wrote ${OUT}: ${s.total} files, ${s.videos} videos, ${s.dead} dead, ${summary.vidDims.length} video dims, ${imgSorted.length} image dims`);
