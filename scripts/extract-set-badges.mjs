// Extracts the event logos/badges that live INSIDE set-art squares
// (playoffs/finals/all-star lockups, and set 141's per-team centre
// logos), driven by the recipe in data/logos.json:
//
//   badges: per-edition rectangles measured in 1024x1024 set-art space,
//           cropped from a fresh fixed-quad extraction of the hero
//   masks:  circle regions (set-art space) or colour-key filters applied
//           to a fresh fixed-quad extraction, output keeps alpha
//           (per-team mode fans out over one hero per team in the tier)
//
//   node scripts/extract-set-badges.mjs
//
// Self-contained: every entry resolves its edition to a HERO CID via the
// seed and unwarps from the IPFS mirror directly; nothing assumes the
// set-art batch (or its file naming) exists on disk.
//
// Output (generated assets, never committed): assets/logos/badges/ named
// <editionID>-<logo name>.png (the logo name being the wording from
// the recipe's "name" field, lowercase with spaces as _), and per-team
// logos in assets/logos/teams/<nba|wnba>/<editionID>-<team slug>.png

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  ROOT, findCachedImage, extractSetArtFixed, fixedQuadVariantForSeries
} from "./lib/hero-split.mjs";
import { seedFacts } from "./lib/seed-facts.mjs";

const OUT_DIR = join(ROOT, "assets", "logos", "badges");
const TEAMS_DIR = join(ROOT, "assets", "logos", "teams");
mkdirSync(OUT_DIR, { recursive: true });

const recipe = JSON.parse(readFileSync(join(ROOT, "data", "logos.json"), "utf8"));
const { namesBySet, seriesBySet, detailsBySet, tierFor, teamFor } = seedFacts();

// Specials (parentheses in display names like "(eastern)") are dropped
// from filenames; the recipe's name field stays the display source.
// (Different rule from extract-set-art's slug ON PURPOSE: this one names
// files after the logo wording, that one after set names.)
const slug = (name) => name.toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");

// Resolve an edition id ("16_199_0") to the local mirror file of its
// HERO image plus the fixed-quad variant for the set's series.
function resolveHero(editionId) {
  const [setID, playID] = editionId.split("_").map(Number);
  const sd = detailsBySet.get(setID);
  const ed = (sd?.editions || []).find((e) => Number(e.playID) === playID);
  const cid = (ed?.ipfsCIDs || {}).HERO;
  const file = cid && findCachedImage(cid);
  return { setID, playID, file, variant: fixedQuadVariantForSeries(seriesBySet.get(setID)) };
}

// ---------- rect badges out of fresh set-art extractions ----------
// Rects are in 1024 set-art space; the extraction is flattened to black
// exactly like the set-art jpgs the rects were tuned against.
let done = 0;
for (const b of recipe.badges) {
  const [x, y, w, h] = b.rect;
  const { file, variant } = resolveHero(b.edition);
  if (!file) { console.warn(`no local hero for ${b.edition}`); continue; }
  const { image } = await extractSetArtFixed(file, { variant, size: 1024 });
  const dest = join(OUT_DIR, `${b.edition}-${slug(b.name)}.png`);
  await image.flatten({ background: "#000" })
    .extract({ left: x, top: y, width: w, height: h }).png().toFile(dest);
  done++;
}
console.log(`${done} rect badges cropped`);

// ---------- mask badges out of fresh hero extractions ----------
// The mask is a circle in 1024x1024 set-art space (the
// originals were painted as ellipse-tool circles; measured centre/radius replaced the
// PNGs, boundary fit within 1px). Alpha ramps over the last pixel so the
// edge antialiases like the painted originals did.
function circleMask({ cx, cy, r }, W = 1024, H = W) {
  const alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    alpha[y * W + x] = Math.round(255 * Math.min(1, Math.max(0, r + 0.5 - d)));
  }
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  return { alpha, W, H, bbox: { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
}

async function maskedBadge(heroFile, variant, mask, dest, opts = {}) {
  const { image } = await extractSetArtFixed(heroFile, { variant, size: mask.W });
  const rgba = await image.raw().toBuffer();
  const W = mask.W, H = mask.H;
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = mask.alpha[i];

  if (opts.removeBackground === "dark-flood") {
    // Drop the masked region's dark textured BACKGROUND, keep the logo:
    // 1. a pixel is LOGO-LIKE when saturated (chroma > 25) or bright
    //    (max channel > 90); the disc texture is desaturated and mostly
    //    dark (bright grunge speckles get past this and are removed by
    //    the size cleanup below)
    // 2. background = non-logo pixels the flood reaches from the mask's
    //    edge; ENCLOSED non-logo pockets (black shoes, outlines inside
    //    the logo) are unreachable and stay
    // 3. surviving pieces under 300px are speckle dust, dropped
    const isLogo = (i) => {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      return (Math.max(r, g, b) - Math.min(r, g, b)) > 25 || Math.max(r, g, b) > 90;
    };
    const reached = new Uint8Array(W * H);
    const stack = [];
    const seed = (i) => {
      if (!reached[i] && rgba[i * 4 + 3] >= 128 && !isLogo(i)) { reached[i] = 1; stack.push(i); }
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (rgba[i * 4 + 3] < 128) continue;
      const atEdge = x === 0 || y === 0 || x === W - 1 || y === H - 1
        || rgba[(i - 1) * 4 + 3] < 128 || rgba[(i + 1) * 4 + 3] < 128
        || rgba[(i - W) * 4 + 3] < 128 || rgba[(i + W) * 4 + 3] < 128;
      if (atEdge) seed(i);
    }
    while (stack.length) {
      const j = stack.pop();
      const x = j % W;
      if (x > 0) seed(j - 1);
      if (x < W - 1) seed(j + 1);
      if (j >= W) seed(j - W);
      if (j < W * (H - 1)) seed(j + W);
    }
    for (let i = 0; i < W * H; i++) if (reached[i]) rgba[i * 4 + 3] = 0;
    // size cleanup: drop tiny surviving components (speckle texture)
    {
      const label = new Int32Array(W * H).fill(-1);
      const areas = [];
      for (let i = 0; i < W * H; i++) {
        if (rgba[i * 4 + 3] < 128 || label[i] !== -1) continue;
        const id = areas.length;
        let area = 0;
        stack.push(i); label[i] = id;
        while (stack.length) {
          const j = stack.pop();
          area++;
          const x = j % W;
          for (const k of [j - 1, j + 1, j - W, j + W]) {
            if (k < 0 || k >= W * H) continue;
            if ((k === j - 1 && x === 0) || (k === j + 1 && x === W - 1)) continue;
            if (rgba[k * 4 + 3] >= 128 && label[k] === -1) { label[k] = id; stack.push(k); }
          }
        }
        areas.push(area);
      }
      for (let i = 0; i < W * H; i++) {
        if (rgba[i * 4 + 3] >= 128 && areas[label[i]] < 300) rgba[i * 4 + 3] = 0;
      }
    }
    // crop to the surviving content instead of the full mask bbox
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let i = 0; i < W * H; i++) {
      if (rgba[i * 4 + 3] >= 128) {
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) throw new Error("dark-flood removed everything");
    const PAD = 6;
    x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD);
    x1 = Math.min(W - 1, x1 + PAD); y1 = Math.min(H - 1, y1 + PAD);
    await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toFile(dest);
    return;
  }

  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract(mask.bbox).png().toFile(dest);
}

// Filter-based cutout: no painted mask, the background is removed by a
// colour key instead. "gold-on-dark" keeps warm (gold) pixels and drops
// the neutral black-grey gradient; near-white speculars on the gold are
// rescued by a brightness term. Output is cropped to the kept pixels.
const smooth = (v, lo, hi) => (v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo));
const FILTERS = {
  // warm gold on a neutral gradient (metallic gold styles)
  "gold-on-dark": (r, g, b) =>
    Math.max(smooth(r - b, 18, 55), smooth((r + g + b) / 3, 200, 235)),
  // any saturated colour on a neutral gradient (iridescent holo styles)
  "chroma-on-dark": (r, g, b) =>
    Math.max(smooth(Math.max(r, g, b) - Math.min(r, g, b), 22, 60), smooth((r + g + b) / 3, 200, 235)),
  // holo variant that also keeps NEUTRAL silver logos (Spurs, Nets):
  // measured on set 53, background neutrals stay under ~125 brightness
  // within r<=460 of centre, so the 130+ ramp only ever hits logo. MUST
  // be paired with a centred region or the bright image corners leak in.
  "holo-on-dark": (r, g, b) =>
    Math.max(
      smooth(Math.max(r, g, b) - Math.min(r, g, b), 22, 60),
      smooth((r + g + b) / 3, 200, 235),
      smooth((r + g + b) / 3, 130, 175)
    ),
  // bright silver/white on near-black (framed emblem styles)
  "bright-on-dark": (r, g, b) => smooth((r + g + b) / 3, 70, 150)
};

// Outline flood for embossed dark-on-dark styles (Base Set): no colour
// or brightness separates the charcoal logo from the grey gradient, but
// the background is SMOOTH while the logo has sharp bevel edges. Strong
// gradient pixels form a barrier; flooding inward from the image borders
// over smooth pixels reaches all background, and whatever the flood
// cannot reach (the logo, interior included) becomes the alpha.
function embossOutlineAlpha(rgba, SIZE) {
  const grey = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) grey[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
  const barrier = new Uint8Array(SIZE * SIZE);
  // adaptive threshold: edge strength scales with local brightness in
  // these renders, so a fixed cut misses the logo's edges where it
  // crosses the DARK end of the gradient (Sparks leak) while JPEG noise
  // stays absolute; the 3.5 floor stays above the noise
  for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
    const i = y * SIZE + x;
    const gx = grey[i + 1] - grey[i - 1];
    const gy = grey[i + SIZE] - grey[i - SIZE];
    if (Math.hypot(gx, gy) > Math.max(3.5, grey[i] * 0.10)) barrier[i] = 1;
  }
  // 2px dilation closes hairline gaps in the edge wall
  const wall = new Uint8Array(barrier);
  for (let pass = 0; pass < 2; pass++) {
    const src = Uint8Array.from(wall);
    for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      if (src[i]) { wall[i - 1] = 1; wall[i + 1] = 1; wall[i - SIZE] = 1; wall[i + SIZE] = 1; }
    }
  }
  const reached = new Uint8Array(SIZE * SIZE);
  const stack = [];
  const seed = (i) => { if (!reached[i] && !wall[i]) { reached[i] = 1; stack.push(i); } };
  for (let x = 0; x < SIZE; x++) { seed(x); seed((SIZE - 1) * SIZE + x); }
  for (let y = 0; y < SIZE; y++) { seed(y * SIZE); seed(y * SIZE + SIZE - 1); }
  while (stack.length) {
    const j = stack.pop();
    const x = j % SIZE;
    if (x > 0) seed(j - 1);
    if (x < SIZE - 1) seed(j + 1);
    if (j >= SIZE) seed(j - SIZE);
    if (j < SIZE * (SIZE - 1)) seed(j + SIZE);
  }
  for (let i = 0; i < SIZE * SIZE; i++) rgba[i * 4 + 3] = reached[i] ? 0 : 255;
  // one 3x3 feather pass so the hard outline edge antialiases
  const a = Buffer.from(rgba.filter((_, k) => k % 4 === 3));
  for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
    const i = y * SIZE + x;
    rgba[i * 4 + 3] = Math.round((a[i] * 4 + a[i - 1] + a[i + 1] + a[i - SIZE] + a[i + SIZE]) / 8);
  }
}

// opts: region {cx, cy, r} zeroes alpha outside a circle (keeps a busy
// frame out of the key); keepLargest keeps only the biggest connected
// piece of kept alpha (drops sparkles/particles around an emblem).
async function filteredBadge(heroFile, variant, filterName, dest, opts = {}) {
  const SIZE = 1024;
  const key = FILTERS[filterName];
  const { image } = await extractSetArtFixed(heroFile, { variant, size: SIZE });
  const rgba = await image.raw().toBuffer();
  if (filterName === "emboss-outline") {
    embossOutlineAlpha(rgba, SIZE);
    if (opts.region) {
      for (let i = 0; i < SIZE * SIZE; i++) {
        const x = i % SIZE, y = (i / SIZE) | 0;
        const { cx, cy, r } = opts.region;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) rgba[i * 4 + 3] = 0;
      }
    }
  } else
  for (let i = 0; i < SIZE * SIZE; i++) {
    let a = key(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    if (opts.region) {
      const x = i % SIZE, y = (i / SIZE) | 0;
      const { cx, cy, r } = opts.region;
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) a = 0;
    }
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  // Component cleanup. keepLargest: only the biggest connected piece
  // survives (single-emblem styles; WRONG for multi-part logos).
  // minComponent/dropBorder: drop pieces smaller than N px or touching
  // the image border (noise specks, the neighbour-face sliver) while
  // keeping every substantial logo part.
  if (opts.keepLargest || opts.minComponent || opts.dropBorder) {
    const label = new Int32Array(SIZE * SIZE).fill(-1);
    const comps = [];
    const stack = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (rgba[i * 4 + 3] < 128 || label[i] !== -1) continue;
      const id = comps.length;
      const c = { area: 0, border: false };
      stack.push(i); label[i] = id;
      while (stack.length) {
        const j = stack.pop();
        c.area++;
        const x = j % SIZE, y = (j / SIZE) | 0;
        if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) c.border = true;
        for (const k of [j - 1, j + 1, j - SIZE, j + SIZE]) {
          if (k < 0 || k >= SIZE * SIZE) continue;
          if ((k === j - 1 && x === 0) || (k === j + 1 && x === SIZE - 1)) continue;
          if (rgba[k * 4 + 3] >= 128 && label[k] === -1) { label[k] = id; stack.push(k); }
        }
      }
      comps.push(c);
    }
    if (comps.length === 0) throw new Error("filter kept nothing");
    const keep = new Set();
    if (opts.keepLargest) {
      keep.add(comps.indexOf(comps.reduce((a, b) => (b.area > a.area ? b : a))));
    } else {
      // minEdgeContrast: a real logo piece is full of bevel edges, so its
      // mean INTERIOR gradient is high; an enclosed patch of BACKGROUND
      // that the flood could not reach (walled off by faint banding) is a
      // smooth gradient with near-zero interior texture. (Contrast across
      // the component BOUNDARY cannot separate them: the flood wall puts
      // every boundary a few pixels out in smooth background.)
      const contrast = new Map();
      if (opts.minEdgeContrast) {
        const grey = new Float32Array(SIZE * SIZE);
        for (let i = 0; i < SIZE * SIZE; i++) grey[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
        const acc = comps.map(() => ({ sum: 0, n: 0 }));
        for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
          const i = y * SIZE + x;
          const id = label[i];
          if (id === -1) continue;
          const gx = grey[i + 1] - grey[i - 1];
          const gy = grey[i + SIZE] - grey[i - SIZE];
          acc[id].sum += Math.hypot(gx, gy); acc[id].n++;
        }
        acc.forEach((a, id) => contrast.set(id, a.n ? a.sum / a.n : 0));
      }
      if (process.env.BADGE_DEBUG) {
        comps.forEach((c, id) => { if (c.area >= 400) console.log(`  comp ${id}: area ${c.area}${c.border ? " border" : ""} contrast ${(contrast.get(id) ?? -1).toFixed(1)}`); });
      }
      // border-touching pieces are dropped only when SMALL: a large one
      // is the logo itself slightly overshooting the frame, not a sliver
      const borderMax = SIZE * SIZE * 0.05;
      comps.forEach((c, id) => {
        if (opts.minComponent && c.area < opts.minComponent) return;
        if (opts.dropBorder && c.border && c.area < borderMax) return;
        if (opts.minEdgeContrast && contrast.get(id) < opts.minEdgeContrast) return;
        keep.add(id);
      });
      if (keep.size === 0) throw new Error("component cleanup kept nothing");
    }
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (rgba[i * 4 + 3] >= 128 && !keep.has(label[i])) rgba[i * 4 + 3] = 0;
      // soft fringe pixels survive only next to a kept component
      else if (rgba[i * 4 + 3] > 0 && rgba[i * 4 + 3] < 128) {
        const x = i % SIZE, y = (i / SIZE) | 0;
        let near = false;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && keep.has(label[ny * SIZE + nx])) near = true;
        }
        if (!near) rgba[i * 4 + 3] = 0;
      }
    }
  }
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (rgba[i * 4 + 3] >= 128) {
      const x = i % SIZE, y = (i / SIZE) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("filter kept nothing");
  const PAD = 6;
  x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD);
  x1 = Math.min(SIZE - 1, x1 + PAD); y1 = Math.min(SIZE - 1, y1 + PAD);
  await sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .png().toFile(dest);
}

for (const m of recipe.masks) {
  const setID = Number(m.set);
  const sd = detailsBySet.get(setID);
  const setName = namesBySet.get(setID) || `set ${setID}`;
  const variant = fixedQuadVariantForSeries(seriesBySet.get(setID));
  const mask = m.circle ? circleMask(m.circle) : null;
  const cut = (file, dest) => m.filter
    ? filteredBadge(file, variant, m.filter, dest, { region: m.region, keepLargest: m.keepLargest, minComponent: m.minComponent, dropBorder: m.dropBorder, minEdgeContrast: m.minEdgeContrast })
    : maskedBadge(file, variant, mask, dest, { removeBackground: m.removeBackground });
  const editions = [...sd.editions].sort((a, b) => a.playOrder - b.playOrder);

  if (m.mode === "single") {
    const ed = editions.find((e) => Number(e.playID) === Number(m.playID));
    const cid = (ed.ipfsCIDs || {}).HERO;
    const file = findCachedImage(cid);
    if (!file) { console.warn(`no local hero for ${setID}_${m.playID}`); continue; }
    const dest = join(OUT_DIR, `${setID}_${m.playID}_0-${slug(m.name)}.png`);
    await cut(file, dest);
    console.log(`mask single: ${setID}_${m.playID} (${setName})`);
  } else if (m.mode === "per-team") {
    // team logos live under teams/<league>/ (league from the set name)
    const league = /wnba/i.test(setName) ? "wnba" : "nba";
    const teamDir = join(TEAMS_DIR, league);
    mkdirSync(teamDir, { recursive: true });
    const seen = new Set();
    let n = 0;
    for (const ed of editions) {
      const playID = Number(ed.playID);
      if (tierFor(setID, playID) !== m.tier) continue;
      const team = teamFor(playID);
      if (seen.has(team)) continue;
      const cid = (ed.ipfsCIDs || {}).HERO;
      const file = cid && findCachedImage(cid);
      if (!file) continue; // a later edition of the same team may be mirrored
      seen.add(team);
      const dest = join(teamDir, `${setID}_${playID}_0-${slug(team)}.png`);
      await cut(file, dest);
      n++;
    }
    console.log(`mask per-team: set ${setID} (${setName}), ${n} teams -> teams/${league}`);
  }
}
console.log(`output: ${OUT_DIR}`);
