// Runtime player-silhouette detection, the front-end fallback for CIDs
// the shipped lookup has not caught up with. Resolution order:
//
//   1. baked flag in data/ipfs_media.json (scripts/mark-image-flags.mjs)
//   2. verdict cached in localStorage from an earlier computation
//   3. computed here from the pixels, then cached forever (CIDs are
//      content-addressed, a verdict can never go stale)
//
// The computation mirrors the offline pipeline exactly (same rule,
// validated 811/811): sample at 128px, a pixel is COLOURED when
// max(r,g,b) - min(r,g,b) > 12 (transparent pixels ignored), the image
// is colourless when under 0.2% of visible pixels are coloured, and a
// colourless image is a silhouette unless it is BLACK-FRAMED (an opaque
// black border at least 1% of the dimension thick on all four sides;
// those are stylized b/w art, not silhouettes).
//
// Reading pixels needs a CORS-clean fetch (the big public gateways send
// Access-Control-Allow-Origin: *). On any failure the answer is null
// (unknown), never a guess, and failures are not cached.

import { loadIpfsMedia, getMediaInfo } from "./ipfs.media.js";

const CACHE_KEY = "ipfs_silhouette_cache_v1";
const SAMPLE = 128;
const CHROMA = 12;       // per-pixel: coloured when max-min exceeds this
const COLORED_PCT = 0.2; // per-image: colourless when under this percent
const BLACK = 12;        // border analyzer's black class: r,g,b all <= 12

let cache = null;
const inflight = new Map();

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
  catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
  catch { /* storage full or blocked: verdicts just recompute */ }
}

function classify(data, w, h) {
  // colourless test
  let visible = 0, colored = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 16) continue;
    visible++;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHROMA) colored++;
  }
  if (visible === 0) return true; // fully transparent counts as colourless
  if ((colored / visible) * 100 > COLORED_PCT) return false;

  // black-frame exclusion: consecutive opaque-black lines from each edge
  const lineBlack = (getPx, len) => {
    let dark = 0;
    for (let k = 0; k < len; k++) {
      const i = getPx(k);
      if (data[i * 4 + 3] >= 8 && data[i * 4] <= BLACK && data[i * 4 + 1] <= BLACK && data[i * 4 + 2] <= BLACK) dark++;
    }
    return dark / len >= 0.99;
  };
  const depth = (line, count) => {
    let d = 0;
    while (d < count && line(d)) d++;
    return d;
  };
  const top = depth((y) => lineBlack((x) => y * w + x, w), h);
  const bottom = depth((y) => lineBlack((x) => (h - 1 - y) * w + x, w), h);
  const left = depth((x) => lineBlack((y) => y * w + x, h), w);
  const right = depth((x) => lineBlack((y) => y * w + (w - 1 - x), h), w);
  const minH = Math.max(1, h * 0.01), minW = Math.max(1, w * 0.01);
  const blackFramed = top >= minH && bottom >= minH && left >= minW && right >= minW;
  return !blackFramed;
}

async function compute(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, SAMPLE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return classify(ctx.getImageData(0, 0, w, h).data, w, h);
}

// True/false when known or computable, null when it cannot be determined
// (no url given for an unknown CID, fetch/CORS failure, no DOM). Safe to
// call repeatedly: concurrent calls for one CID share a single fetch.
export async function isSilhouette(cid, url) {
  await loadIpfsMedia().catch(() => {});
  const info = getMediaInfo(cid);
  if (info) {
    if (info.kind !== "image") return false;
    if (info.silhouette) return true;
  }
  const cached = loadCache()[cid];
  if (cached !== undefined) return cached === 1;
  if (!url || typeof document === "undefined") return info ? false : null;
  if (!inflight.has(cid)) {
    inflight.set(cid, compute(url).then((verdict) => {
      loadCache()[cid] = verdict ? 1 : 0;
      saveCache();
      return verdict;
    }).catch(() => null).finally(() => inflight.delete(cid)));
  }
  return inflight.get(cid);
}
