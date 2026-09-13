// On-the-fly image derivation from HERO renders, entirely in the
// browser: the repo ships only these numbers (recipes), never the
// derived pixels. Ported from the offline pipeline in
// scripts/lib/hero-split.mjs + scripts (fixed quads, perspective
// homography unwarp, silhouette-matte player reconstruction).
//
//   generateSetArt(heroUrl, series)        -> { url, width, height }
//   reconstructPlayer(heroUrl, playerUrl)  -> { url, width, height }
//
// Both fetch the hero from an IPFS gateway (CORS-clean, gateways send
// Access-Control-Allow-Origin: *), so they only work on hosts that allow
// pixel reads. Results are object URLs (caller shows them; not revoked
// here). Heroes are multi-MB, so call on demand, never automatically.
//
// The cube render camera never moves within a generation, so faces sit
// at fixed quads in every 2880x2880 hero:
// - SET ART (right face): "old" quad for series 1-5, "new" for 6+.
// - PLAYER CARD (left face, 2025-26 generation only): TWO panes, the
//   main card quad plus a refraction-offset sliver that continues the
//   photo to the seam. The official 2048 PLAYER image is composited
//   onto that card nearly 1:1, so using the (silhouette) PLAYER image
//   as the alpha matte recovers the real colour player photo. The exact
//   composite transform varies slightly by set (two clusters measured),
//   so a small registration search aligns the matte per image.

import { HERO_REF, FIXED_QUADS, fixedQuadVariantForSeries, isBlankRGB, BLANK_LINE_SHARE } from "./hero-quads.js";

const REF = HERO_REF;

// hero-quads stores quads as corner arrays (clockwise from top-left);
// this module's mappers take named corners
const toQuad = ([tl, tr, br, bl]) => ({ tl, tr, br, bl });
const SET_ART_QUADS = { old: toQuad(FIXED_QUADS.old), new: toQuad(FIXED_QUADS.new) };

// 2025-26 generation player-card panes (measured from a hand-painted mask,
// validated against all 640 reconstructable silhouette editions)
const PANE_A = { tl: [512, 847], tr: [1315, 648], br: [1315, 2209], bl: [512, 2011] };
const PANE_B = { tl: [1315, 663], tr: [1412, 638], br: [1412, 2219], bl: [1315, 2196] };
const PANE_FULL = { tl: [512, 847], tr: [1412, 624], br: [1412, 2233], bl: [512, 2011] };
const PANE_SPLIT_X = 1315;

// Homography mapping the unit square onto a quad (4-point projective)
function squareToQuad({ tl, tr, br, bl }, scale) {
  const [x0, y0] = [tl[0] * scale, tl[1] * scale];
  const [x1, y1] = [tr[0] * scale, tr[1] * scale];
  const [x2, y2] = [br[0] * scale, br[1] * scale];
  const [x3, y3] = [bl[0] * scale, bl[1] * scale];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - sy * dx2) / den;
  const h = (dx1 * sy - dy1 * sx) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

async function fetchImageData(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Flatten to black: transparent-hero PNGs must not sample as garbage
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function canvasToUrl(canvas, type = "image/jpeg", quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("canvas export failed (CORS-tainted source?)"));
      else resolve(URL.createObjectURL(blob));
    }, type, quality);
  });
}

// Sample a mapped quad into an RGBA ImageData of size x size
function unwarp(img, mappers, size) {
  const { data, width: W, height: H } = img;
  const out = new ImageData(size, size);
  const o = out.data;
  for (let oy = 0; oy < size; oy++) {
    const v = oy / (size - 1);
    for (let ox = 0; ox < size; ox++) {
      const u = ox / (size - 1);
      const [x, y] = mappers(u, v);
      const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
      const yi = Math.max(0, Math.min(H - 1, Math.round(y)));
      const si = (yi * W + xi) * 4, oi = (oy * size + ox) * 4;
      o[oi] = data[si]; o[oi + 1] = data[si + 1]; o[oi + 2] = data[si + 2]; o[oi + 3] = 255;
    }
  }
  return out;
}

// A real hero is the cube render centred on an empty background, so the
// outermost pixel line on every side of the image is blank (transparent,
// which the fetch flattens to black, or near-black or near-white). Some
// editions ship a raw photograph as the hero instead; the fixed quads
// mean nothing there and would return an arbitrary crop. Same rule as
// the offline border lookup (>= 99.5% blank per line, photo when any
// side fails); it matched the offline classification on all 803 batch
// heroes.
function heroHasCube(img) {
  const { data, width: W, height: H } = img;
  const blank = (i) => isBlankRGB(data[i], data[i + 1], data[i + 2]);
  const side = (count, indexAt) => {
    let bad = 0;
    for (let k = 0; k < count; k++) if (!blank(indexAt(k))) bad++;
    return bad / count <= 1 - BLANK_LINE_SHARE;
  };
  return side(W, (k) => k * 4)
    && side(W, (k) => ((H - 1) * W + k) * 4)
    && side(H, (k) => k * W * 4)
    && side(H, (k) => (k * W + W - 1) * 4);
}

// Callers catch this via err.photoHero and can fall back to showing the
// hero itself (for these editions the hero IS the raw photo already)
function photoHeroError() {
  return Object.assign(new Error("hero is a raw photo, no cube render to extract from"), { photoHero: true });
}

// Session cache: object URLs live for the page's lifetime anyway, so a
// repeated call (re-render, revisit) returns the same result without
// refetching the multi-MB hero. Failures are not cached.
const setArtCache = new Map();

export function generateSetArt(heroUrl, series, size = 1024) {
  const variant = fixedQuadVariantForSeries(series);
  const quad = SET_ART_QUADS[variant];
  const key = `${heroUrl}|${variant}|${size}`;
  if (!setArtCache.has(key)) {
    const p = (async () => {
      const img = await fetchImageData(heroUrl);
      if (!heroHasCube(img)) throw photoHeroError();
      const map = squareToQuad(quad, img.width / REF);
      const out = unwarp(img, map, size);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas.getContext("2d").putImageData(out, 0, 0);
      return { url: await canvasToUrl(canvas), width: size, height: size };
    })();
    p.catch(() => setArtCache.delete(key));
    setArtCache.set(key, p);
  }
  return setArtCache.get(key);
}

// Stitched two-pane mapper for the player card face
function playerCardMapper(imgWidth) {
  const scale = imgWidth / REF;
  const mapFull = squareToQuad(PANE_FULL, scale);
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (mapFull(m, 0.5)[0] < PANE_SPLIT_X * scale) lo = m; else hi = m;
  }
  const uSplit = (lo + hi) / 2;
  const mapA = squareToQuad(PANE_A, scale);
  const mapB = squareToQuad(PANE_B, scale);
  return (u, v) => (u < uSplit ? mapA(u / uSplit, v) : mapB((u - uSplit) / (1 - uSplit), v));
}

function greyOf(imageData) {
  const { data, width, height } = imageData;
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) g[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  return g;
}

function scaleImageData(imageData, size) {
  const src = document.createElement("canvas");
  src.width = imageData.width;
  src.height = imageData.height;
  src.getContext("2d").putImageData(imageData, 0, 0);
  const dst = document.createElement("canvas");
  dst.width = size;
  dst.height = size;
  const ctx = dst.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

function contourPoints(grey, size, step) {
  const pts = [];
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const i = y * size + x;
    if (grey[i] < 128 && (grey[i - 1] >= 128 || grey[i + 1] >= 128 || grey[i - size] >= 128 || grey[i + size] >= 128)) pts.push([x, y]);
  }
  const out = [];
  for (let k = 0; k < pts.length; k += step) out.push(pts[k]);
  return out;
}

function gradientOf(grey, size) {
  const m = new Float32Array(size * size);
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const i = y * size + x;
    m[i] = Math.hypot(grey[i + 1] - grey[i - 1], grey[i + size] - grey[i - size]);
  }
  return m;
}

function bestFit(grad, size, pts, sRange, txRange, tyRange, sStep, tStep) {
  let best = { s: 1, tx: 0, ty: 0, sc: -1 };
  for (let s = sRange[0]; s <= sRange[1] + 1e-9; s += sStep) {
    for (let tx = txRange[0]; tx <= txRange[1]; tx += tStep) {
      for (let ty = tyRange[0]; ty <= tyRange[1]; ty += tStep) {
        let sum = 0, n = 0;
        for (const [px, py] of pts) {
          const x = Math.round(px * s + tx), y = Math.round(py * s + ty);
          if (x < 1 || x >= size - 1 || y < 1 || y >= size - 1) continue;
          sum += grad[y * size + x];
          n++;
        }
        const sc = n > pts.length * 0.5 ? sum / n : 0;
        if (sc > best.sc) best = { s, tx, ty, sc };
      }
    }
  }
  return best;
}

// Default is the FULL card photo with its original background (the
// silhouette cutout does not always land cleanly, so the
// matte path is parked behind the cutout option for a later phase).
// Same session cache as set art: the cube trigger and the dynamic-photo
// action can both ask for one edition's rebuild, and the hero is multi-MB.
const playerCache = new Map();

export function reconstructPlayer(heroUrl, playerUrl, size = 2048, { cutout = false } = {}) {
  const key = `${heroUrl}|${playerUrl}|${size}|${cutout ? 1 : 0}`;
  if (!playerCache.has(key)) {
    const p = reconstructPlayerUncached(heroUrl, playerUrl, size, { cutout });
    p.catch(() => playerCache.delete(key));
    playerCache.set(key, p);
  }
  return playerCache.get(key);
}

async function reconstructPlayerUncached(heroUrl, playerUrl, size, { cutout }) {
  if (!cutout) {
    const hero = await fetchImageData(heroUrl);
    if (!heroHasCube(hero)) throw photoHeroError();
    const flat = unwarp(hero, playerCardMapper(hero.width), size);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").putImageData(flat, 0, 0);
    return { url: await canvasToUrl(canvas), width: size, height: size };
  }

  const [hero, silImg] = await Promise.all([fetchImageData(heroUrl), fetchImageData(playerUrl)]);
  if (!heroHasCube(hero)) throw photoHeroError();
  const map = playerCardMapper(hero.width);
  const flat = unwarp(hero, map, size);

  // Registration: coarse at 256 (range covers both measured composite
  // clusters), refined at 512
  const flat256 = scaleImageData(flat, 256);
  const sil256 = scaleImageData(silImg, 256);
  const coarse = bestFit(
    gradientOf(greyOf(flat256), 256), 256,
    contourPoints(greyOf(sil256), 256, 3),
    [0.92, 1.08], [-12, 26], [-10, 18], 0.01, 2
  );
  const flat512 = scaleImageData(flat, 512);
  const sil512 = scaleImageData(silImg, 512);
  const fine = bestFit(
    gradientOf(greyOf(flat512), 512), 512,
    contourPoints(greyOf(sil512), 512, 4),
    [coarse.s - 0.01, coarse.s + 0.01], [coarse.tx * 2 - 4, coarse.tx * 2 + 4], [coarse.ty * 2 - 4, coarse.ty * 2 + 4], 0.005, 1
  );

  // Compose: silhouette (in its own 2048 frame) supplies alpha, colour
  // sampled from the flat card at the registered transform
  const silFull = scaleImageData(silImg, size);
  const out = new ImageData(size, size);
  const o = out.data, fd = flat.data, sd = silFull.data;
  const toFit = 512 / size, fromFit = size / 512;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const alpha = 255 - Math.round((sd[i * 4] + sd[i * 4 + 1] + sd[i * 4 + 2]) / 3);
      if (alpha < 8) continue;
      const fx = Math.round((x * toFit * fine.s + fine.tx) * fromFit);
      const fy = Math.round((y * toFit * fine.s + fine.ty) * fromFit);
      if (fx < 0 || fx >= size || fy < 0 || fy >= size) continue;
      const fi = (fy * size + fx) * 4;
      o[i * 4] = fd[fi]; o[i * 4 + 1] = fd[fi + 1]; o[i * 4 + 2] = fd[fi + 2]; o[i * 4 + 3] = alpha;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.getContext("2d").putImageData(out, 0, 0);
  return { url: await canvasToUrl(canvas, "image/png"), width: size, height: size };
}
