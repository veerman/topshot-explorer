// HERO image splitter. A HERO is a 3D render of two cube faces meeting at
// a vertical seam: the PLAYER CARD on the left and the SET ART (or
// set/team art, for core sets) on the right. The faces are flat planes,
// so each projects to a quadrilateral; a homography from that quad back
// to a square undoes the perspective.
//
// Pipeline (each stage exported separately so the test harness can dump
// intermediates):
//   1. border crop     - uniform black/white/transparent padding, from the
//                        image-borders lookup (inline re-measure fallback)
//   2. face detection  - silhouette mask -> seam (tallest column) -> line
//                        fits -> two quads
//   3. unwarp          - homography + bilinear sampling into a square
//   4. art window      - trim pane margins/bezels via edge-line gaps with
//                        the segment-absorb rule
//   5. squaring        - the set art is truly square, so the window's
//                        longer axis (usually the one that ran to the face
//                        edge undetected) is trimmed symmetrically to
//                        match the shorter, measured one
//
// extractSetArt() runs the whole chain for the set-art face.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { ROOT } from "./paths.mjs";
import { isBlankRGBA, BLANK_LINE_SHARE, FIXED_QUADS, HERO_REF } from "../../src/services/hero-quads.js";

// ---------- cache lookup ----------
// Path/config helpers live in lib/paths.mjs (importable without sharp);
// re-exported here so existing importers keep working.
export { ROOT, loadDirConfig, findCachedImage } from "./paths.mjs";

export function loadBorderLookup() {
  const lookupPath = join(ROOT, "ipfs_cache", "image-borders.json");
  return existsSync(lookupPath) ? JSON.parse(readFileSync(lookupPath, "utf8")) : {};
}

// ---------- stage 1: border crop ----------

// Same rules as analyze-image-borders.mjs (thresholds shared via
// hero-quads.js), for CIDs not in the lookup yet
export async function measureBorders(file) {
  const { data: bd, info: bi } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const isB = (x, y) => {
    const i = (y * bi.width + x) * 4;
    return isBlankRGBA(bd[i], bd[i + 1], bd[i + 2], bd[i + 3]);
  };
  const cap = Math.floor(Math.min(bi.width, bi.height) * 0.45);
  const scan = (len, at) => {
    let d = 0;
    while (d < cap) {
      let n = 0;
      for (let j = 0; j < len; j++) if (at(d, j)) n++;
      if (n / len < BLANK_LINE_SHARE) break;
      d++;
    }
    return d;
  };
  return {
    top: scan(bi.width, (d, j) => isB(j, d)),
    bottom: scan(bi.width, (d, j) => isB(j, bi.height - 1 - d)),
    left: scan(bi.height, (d, j) => isB(d, j)),
    right: scan(bi.height, (d, j) => isB(bi.width - 1 - d, j))
  };
}

// True when the lookup shows a TRANSPARENT border on any side: the hero
// has real transparency, and its extraction should stay a PNG with alpha
// (an opaque hero flattens to jpeg)
export function hasTransparentBorder(cid, lookup) {
  const entry = lookup ? lookup[cid] : null;
  return Array.isArray(entry) && typeof entry[6] === "string" && entry[6].includes("t");
}

// Border widths for a cid: lookup first, inline measurement otherwise
export async function bordersFor(cid, file, lookup) {
  const entry = lookup ? lookup[cid] : null;
  if (Array.isArray(entry)) return { top: entry[2], right: entry[3], bottom: entry[4], left: entry[5] };
  return measureBorders(file);
}

export async function borderCropRegion(file, borders) {
  const meta = await sharp(file).metadata();
  return {
    left: borders.left,
    top: borders.top,
    width: meta.width - borders.left - borders.right,
    height: meta.height - borders.top - borders.bottom
  };
}

// ---------- stage 2: face detection ----------

const DET = 720; // detection resolution

// Detects the two face quads inside the border-cropped content. Quads are
// in FULL-RES original-image coordinates, corners clockwise from top-left.
// Returns { faces: [{name, quad}], x0, x1, seamX, seamPct, scaleX }.
//
// Two threshold profiles: the DEFAULT one is tuned for the modern hero
// style (neon brackets whose glow must not bridge into the cube, faces
// lifted by glass sheen); when its result fails the sanity checks the DIM
// profile retries with much lower cutoffs for the early-series style
// (near-black embossed team-logo faces, no brackets to bridge).
export async function detectFaces(file, crop, opts = {}) {
  // flatten() first: on an image WITH an alpha channel, greyscale().raw()
  // emits TWO channels per pixel (grey + alpha) and single-channel
  // indexing reads interleaved garbage (this silently wrecked every
  // transparent-PNG hero until 2026-09-05); flattening onto black also
  // makes transparent background read as background, matching the border
  // rules
  const detImg = await sharp(file).extract(crop).resize(DET, DET, { fit: "fill" }).flatten({ background: "#000" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const dw = detImg.info.width, dh = detImg.info.height;
  const g = detImg.data;
  if (detImg.info.channels !== 1) throw new Error(`detection buffer has ${detImg.info.channels} channels, expected 1`);

  // Style check up front: in the early dark styles the set-art face is a
  // near-black pane (embossed or neon team logo) whose specular sheen
  // stays in the mid-tones, so on the right side of the content only a
  // small share of non-background pixels is truly BRIGHT (>120); modern
  // faces carry bright artwork (measured share: dark styles 0.03..0.18,
  // modern 0.32). The dark styles need the dim thresholds (the default
  // profile can pass its sanity checks there while quading only a
  // fragment of the near-black face).
  const wCols = [];
  for (let x = 0; x < dw; x++) {
    let n = 0;
    for (let y = 0; y < dh; y++) if (g[y * dw + x] > 6) n++;
    if (n > dh * 0.02) wCols.push(x);
  }
  let brightFrac = 1;
  if (wCols.length > dw * 0.1) {
    const wx0 = wCols[0], wx1 = wCols[wCols.length - 1];
    const bandFrom = Math.round(wx0 + (wx1 - wx0) * 0.6);
    let n6 = 0, n120 = 0;
    for (let x = bandFrom; x <= wx1; x++) {
      for (let y = 0; y < dh; y++) {
        const v = g[y * dw + x];
        if (v > 6) n6++;
        if (v > 120) n120++;
      }
    }
    if (n6 > 0) brightFrac = n120 / n6;
  }

  const dim = { threshold: 6, strong: 14, minComp: opts.minComp ?? 1, profile: "dim" };
  const dflt = { threshold: opts.threshold ?? 24, strong: opts.strong ?? 60, minComp: opts.minComp ?? 1 };
  const attempts = brightFrac < 0.25 ? [dim, dflt] : [dflt, dim];
  // Preference order: a fully valid result, else one whose SET-ART face
  // is valid (a degenerate player fit does not spoil the side this
  // pipeline extracts), else the last attempt flagged suspect
  let last = null;
  let setOk = null;
  for (const att of attempts) {
    const res = detectOnce(g, dw, dh, crop, att);
    res.profile = att.profile ?? "default";
    if (res.valid) return res;
    if (res.faces && res.setArtValid && !setOk) setOk = res;
    last = res;
  }
  if (setOk) {
    setOk.playerSuspect = true;
    return setOk;
  }
  last.suspectDetection = true;
  return last;
}

function detectOnce(g, dw, dh, crop, { threshold: BRIGHTNESS_MIN, strong: STRONG, minComp: MIN_COMP_PCT }) {
  // Two masks: components form on STRONG pixels only, so the faint glow
  // that bridges the floating neon brackets to the cube cannot connect
  // them; the weak mask later reclaims dim glass edges around the faces
  const weak = new Uint8Array(dw * dh);
  const strong = new Uint8Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) {
    weak[i] = g[i] > BRIGHTNESS_MIN ? 1 : 0;
    strong[i] = g[i] > STRONG ? 1 : 0;
  }

  // Connected components (4-connected flood fill) of a binary mask
  const components = (mask) => {
    const label = new Int32Array(dw * dh).fill(-1);
    const sizes = [];
    const stack = [];
    for (let start = 0; start < dw * dh; start++) {
      if (label[start] !== -1 || !mask[start]) continue;
      const id = sizes.length;
      let size = 0;
      stack.push(start);
      label[start] = id;
      while (stack.length) {
        const i = stack.pop();
        size++;
        const x = i % dw, y = (i / dw) | 0;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= dw || ny >= dh) continue;
          const ni = ny * dw + nx;
          if (label[ni] === -1 && mask[ni]) { label[ni] = id; stack.push(ni); }
        }
      }
      sizes.push(size);
    }
    return { label, sizes };
  };

  // The body is the UNION of every component big enough to be a face, so
  // the two faces need not touch and bracket blobs (small) drop out
  const { label, sizes } = components(strong);
  const minSize = (dw * dh * MIN_COMP_PCT) / 100;
  const keep = new Set(sizes.map((s, id) => [s, id]).filter(([s]) => s >= minSize).map(([, id]) => id));

  // Pad the union out by a few px, clipped to the weak mask, so dim glass
  // edges just outside the strong pixels still shape the profiles
  const PAD = 3;
  const union = new Uint8Array(dw * dh);
  for (let i = 0; i < dw * dh; i++) union[i] = keep.has(label[i]) ? 1 : 0;
  const body = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const i = y * dw + x;
      if (!weak[i]) continue;
      let near = false;
      for (let ry = -PAD; ry <= PAD && !near; ry++) {
        for (let rx = -PAD; rx <= PAD && !near; rx++) {
          const nx = x + rx, ny = y + ry;
          if (nx >= 0 && ny >= 0 && nx < dw && ny < dh && union[ny * dw + nx]) near = true;
        }
      }
      if (near) body[i] = 1;
    }
  }

  // Top/bottom profile of the cube body per column
  const top = new Array(dw).fill(-1), bottom = new Array(dw).fill(-1);
  for (let x = 0; x < dw; x++) {
    for (let y = 0; y < dh; y++) if (body[y * dw + x]) { top[x] = y; break; }
    for (let y = dh - 1; y >= 0; y--) if (body[y * dw + x]) { bottom[x] = y; break; }
  }
  const cols = [];
  for (let x = 0; x < dw; x++) if (top[x] !== -1) cols.push(x);
  if (cols.length < dw * 0.1) return { valid: false, reason: "no cube silhouette found" };
  const x0 = cols[0], x1 = cols[cols.length - 1];

  // Seam. Two hero styles: in the modern one the faces touch and the seam
  // is the tallest column (the nearest cube edge); in the early-series
  // style the player pane FLOATS free of the cube with real background
  // between them, so a run of (near) empty columns in the middle marks the
  // split, and each face gets only its own side of the gap.
  const occ = new Array(dw).fill(0);
  for (let x = 0; x < dw; x++) {
    let n = 0;
    for (let y = 0; y < dh; y++) if (body[y * dw + x]) n++;
    occ[x] = n;
  }
  const EMPTY = dh * 0.02;
  let gap = null;
  let runStart = -1;
  for (let x = x0; x <= x1 + 1; x++) {
    if (x <= x1 && occ[x] <= EMPTY) { if (runStart === -1) runStart = x; continue; }
    if (runStart !== -1) {
      const runEnd = x - 1;
      const mid = (runStart + runEnd) / 2;
      const inMiddle = mid > x0 + (x1 - x0) * 0.2 && mid < x0 + (x1 - x0) * 0.8;
      if (runEnd - runStart + 1 >= 4 && inMiddle && (!gap || runEnd - runStart > gap[1] - gap[0])) gap = [runStart, runEnd];
      runStart = -1;
    }
  }
  let xs, playerTo, setFrom;
  if (gap) {
    xs = Math.round((gap[0] + gap[1]) / 2);
    playerTo = gap[0] - 1;
    setFrom = gap[1] + 1;
  } else {
    xs = -1;
    let bestSpan = -1;
    for (let x = x0 + Math.round((x1 - x0) * 0.15); x <= x1 - Math.round((x1 - x0) * 0.15); x++) {
      const span = bottom[x] - top[x];
      if (span > bestSpan) { bestSpan = span; xs = x; }
    }
    playerTo = xs;
    setFrom = xs;
  }

  // Tighten the set-art segment's left boundary to the face itself: in
  // the floating-pane style the region right of the seam starts with
  // low-occupancy leftovers (the pane's ghost reflection on the hidden
  // left face) and thin full-height accent strips (blue-edged glass
  // panes) before the face proper. The face is the first SUSTAINED
  // high-occupancy run, so both low columns and high runs too narrow to
  // be a face are skipped. In the touching-faces style the seam column
  // starts a wide high run, so this is a no-op.
  let occMax = 0;
  for (let x = setFrom; x <= x1; x++) occMax = Math.max(occMax, occ[x]);
  const minSet = Math.round((x1 - x0) * 0.15);
  const HI = occMax * 0.5;
  while (setFrom < x1 - minSet) {
    if (occ[setFrom] < HI) { setFrom++; continue; }
    let runEnd = setFrom;
    while (runEnd < x1 && occ[runEnd + 1] >= HI) runEnd++;
    if (runEnd - setFrom + 1 >= minSet) break;
    setFrom = runEnd + 1;
  }

  // NOTE on the legendary/ultimate wireframe-shell styles (the faces are
  // panes floating inside a glowing shell): pane detection via erosion of
  // the strong mask was tried and ABANDONED (2026-09-04): dark art
  // punches holes in the strong mask so panes fragment, glow lights the
  // weak mask everywhere inside the shell so bbox-fill tests cannot tell
  // pane from glow blob, and the shell tubes hug the pane edges so
  // no emptiness test around a candidate holds up. Those styles are
  // instead handled downstream: the quad spans the shell, and the art
  // window trims the wide near-BLACK shell regions (see artWindow).

  // Straight-line fit y = a*x + b over the middle of a segment (avoids
  // rounded corners and glow at the ends)
  const fitLine = (profile, from, to) => {
    const pad = Math.max(2, Math.round((to - from) * 0.12));
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let x = from + pad; x <= to - pad; x++) {
      if (profile[x] === -1) continue;
      sx += x; sy += profile[x]; sxx += x * x; sxy += x * profile[x]; n++;
    }
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const b = (sy - a * sx) / n;
    return (x) => a * x + b;
  };

  // det coords -> ORIGINAL image coords (through the border crop)
  const scaleX = crop.width / dw, scaleY = crop.height / dh;
  const P = (x, y) => [crop.left + x * scaleX, crop.top + y * scaleY];

  // The silhouette fit tends to sit a hair inside the true face (glow gets
  // clipped), so each quad is expanded slightly around its centroid; the
  // art-window trim afterwards removes whatever extra this lets in
  const QUAD_EXPAND = 1.02;
  const expand = (quad) => {
    const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
    const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
    return quad.map(([x, y]) => [cx + (x - cx) * QUAD_EXPAND, cy + (y - cy) * QUAD_EXPAND]);
  };

  const faces = [];
  let valid = true;
  let reason = null;
  for (const [from, to, name] of [[x0, playerTo, "player"], [setFrom, x1, "set-art"]]) {
    // Sanity: most columns of the segment must actually have a profile,
    // or the line fits below run on scattered noise
    let faceOk = true;
    let covered = 0;
    for (let x = from; x <= to; x++) if (top[x] !== -1) covered++;
    if (covered / (to - from + 1) < 0.8) { faceOk = false; reason = reason || `${name} profile coverage ${Math.round((covered / (to - from + 1)) * 100)}%`; }

    const topLine = fitLine(top, from, to);
    const botLine = fitLine(bottom, from, to);
    const quad = expand([P(from, topLine(from)), P(to, topLine(to)), P(to, botLine(to)), P(from, botLine(from))]);
    // Sanity: the top edge must sit clearly above the bottom edge at both
    // ends (a degenerate fit crosses them)
    const minH = crop.height * 0.1;
    if (quad[3][1] - quad[0][1] < minH || quad[2][1] - quad[1][1] < minH) { faceOk = false; reason = reason || `${name} quad degenerate`; }
    if (!faceOk) valid = false;
    faces.push({ name, quad, valid: faceOk });
  }
  const seamPct = Math.round(((xs - x0) / (x1 - x0)) * 100);
  if (seamPct < 20 || seamPct > 80) { valid = false; reason = reason || `seam at ${seamPct}%`; }

  return {
    valid, reason,
    setArtValid: faces[1].valid && seamPct >= 20 && seamPct <= 80,
    faces, x0, x1, seamX: xs,
    seamPct,
    strongComponents: sizes.length, keptComponents: keep.size,
    scaleX, scaleY
  };
}

// ---------- stage 3: unwarp ----------

// Homography mapping the unit square to a quad (projective interpolation)
function quadMapper([p0, p1, p2, p3]) {
  const dx1 = p1[0] - p2[0], dy1 = p1[1] - p2[1];
  const dx2 = p3[0] - p2[0], dy2 = p3[1] - p2[1];
  const dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const den = dx1 * dy2 - dy1 * dx2;
  const gg = (dx3 * dy2 - dy3 * dx2) / den;
  const hh = (dx1 * dy3 - dy1 * dx3) / den;
  const a = p1[0] - p0[0] + gg * p1[0];
  const b = p3[0] - p0[0] + hh * p3[0];
  const c = p0[0];
  const d = p1[1] - p0[1] + gg * p1[1];
  const e = p3[1] - p0[1] + hh * p3[1];
  const f = p0[1];
  return (u, v) => {
    const wgt = gg * u + hh * v + 1;
    return [(a * u + b * v + c) / wgt, (d * u + e * v + f) / wgt];
  };
}

export async function loadFullRaw(file) {
  const full = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: full.data, width: full.info.width, height: full.info.height };
}

// Unwarps one face quad from a preloaded full-res raw into size x size RGBA
export function unwarpFace(fullRaw, quad, size) {
  const { data: src, width: fw, height: fh } = fullRaw;
  const map = quadMapper(quad);
  const out = Buffer.alloc(size * size * 4);
  for (let oy = 0; oy < size; oy++) {
    const v = oy / (size - 1);
    for (let ox = 0; ox < size; ox++) {
      const [sxF, syF] = map(ox / (size - 1), v);
      const xi = Math.floor(sxF), yi = Math.floor(syF);
      const o = (oy * size + ox) * 4;
      if (xi < 0 || yi < 0 || xi >= fw - 1 || yi >= fh - 1) { out[o + 3] = 0; continue; }
      const fx = sxF - xi, fy = syF - yi;
      for (let ch = 0; ch < 4; ch++) {
        const i00 = (yi * fw + xi) * 4 + ch;
        const v00 = src[i00], v10 = src[i00 + 4];
        const v01 = src[i00 + fw * 4], v11 = src[i00 + fw * 4 + 4];
        out[o + ch] = Math.round(
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
        );
      }
    }
  }
  return out;
}

// ---------- stage 4: art window ----------

// The pane's edge strips, glass edges and the artwork's own border all
// read as LINES spanning (nearly) the whole face: columns/rows where a
// strong gradient shows on most pixels. Those lines carve the face into
// segments, and the window is found by TRIMMING INWARD from each edge:
// a segment is dropped only while it is NARROW (<=15% of the face) AND
// clearly pane furniture, either dark (margins, edge shadows, background
// wedges from quad overshoot) or flat (bezel highlights, solid accent
// strips). The first segment with real content stops the walk, so a
// card's own bright border survives and full-bleed art is left untouched.
// Re-measured per face, in perspective-free space, so shifting insets
// between heroes do not matter. (Approaches that FAILED here, kept for
// the record: brightness and variance profiles, defeated by through-pane
// reflections and dark comic art; picking the largest gap between lines,
// defeated by full-bleed art whose own straight edges read as interior
// lines and shrank the window to a fragment.)
export function artWindow(faceRgba, size) {
  const lum = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = 0.299 * faceRgba[i * 4] + 0.587 * faceRgba[i * 4 + 1] + 0.114 * faceRgba[i * 4 + 2];
  }
  const lineSupport = (vertical) => {
    const E = new Float64Array(size);
    for (let c = 2; c < size - 2; c++) {
      let n = 0;
      for (let r = 0; r < size; r++) {
        const a = vertical ? lum[r * size + c + 2] : lum[(c + 2) * size + r];
        const b = vertical ? lum[r * size + c - 2] : lum[(c - 2) * size + r];
        if (Math.abs(a - b) > 18) n++;
      }
      E[c] = n / size;
    }
    return E;
  };
  const meanProfile = (vertical) => {
    const M = new Float64Array(size);
    for (let c = 0; c < size; c++) {
      let s = 0;
      for (let r = 0; r < size; r++) s += vertical ? lum[r * size + c] : lum[c * size + r];
      M[c] = s / size;
    }
    return M;
  };
  const devProfile = (vertical) => {
    const D = new Float64Array(size);
    for (let c = 0; c < size; c++) {
      let s = 0, s2 = 0;
      for (let r = 0; r < size; r++) {
        const v = vertical ? lum[r * size + c] : lum[c * size + r];
        s += v; s2 += v * v;
      }
      D[c] = Math.sqrt(Math.max(0, s2 / size - (s / size) ** 2));
    }
    return D;
  };
  const artSpan = (E, mean, dev) => {
    // local maxima with support >= 0.5, 8px apart, as line positions
    const lines = [];
    for (let c = 8; c < size - 8; c++) {
      if (E[c] < 0.5) continue;
      let isMax = true;
      for (let d = -8; d <= 8 && isMax; d++) if (E[c + d] > E[c]) isMax = false;
      if (isMax && (lines.length === 0 || c - lines[lines.length - 1] >= 8)) lines.push(c);
    }
    const bounds = [0, ...lines, size - 1];
    const seg = (a, b, profile) => {
      let s = 0;
      for (let j = a; j <= b; j++) s += profile[j];
      return s / (b - a + 1);
    };
    if (process.env.HS_DEBUG) {
      for (let i = 0; i + 1 < bounds.length; i++) {
        const [a, b] = [bounds[i], bounds[i + 1]];
        console.error(`    seg ${a}..${b} w${b - a} mean ${seg(a, b, mean).toFixed(0)} dev ${seg(a, b, dev).toFixed(0)} edges ${seg(a, b, E).toFixed(3)}`);
      }
    }
    const NARROW = size * 0.15, DARK = 45, UNIFORM = 40, SLIVER = size * 0.03, WIDE = size * 0.4;
    // The segment TOUCHING the face edge may also be trimmed as a mere
    // sliver regardless of content: quad expansion overshoots the seam a
    // few pixels into the neighbouring face, and that bright leak must not
    // block the walk. Deeper segments need the normal rule (a card's
    // narrow burst margin one segment in must survive). WIDE segments are
    // trimmable only when dark-ish AND edge-sparse: the wireframe-shell
    // regions around an inset pane are smooth glow with a few thin tubes,
    // while real art is edge-dense (and the full-width dark embossed
    // faces are protected by the width cap).
    const trimmable = (a, b, outermost) =>
      (outermost && b - a <= SLIVER) ||
      (b - a <= NARROW && (seg(a, b, mean) < DARK || seg(a, b, dev) < UNIFORM)) ||
      (b - a <= WIDE && seg(a, b, mean) < 90 && seg(a, b, E) < 0.12);
    let lo = 0, hi = bounds.length - 1;
    while (lo < hi - 1 && trimmable(bounds[lo], bounds[lo + 1], lo === 0)) lo++;
    while (hi > lo + 1 && trimmable(bounds[hi - 1], bounds[hi], hi === bounds.length - 1)) hi--;
    // Safety net: if the walk consumed more than half the face, the
    // wide-black rule mistook dark ART for shell; redo without it
    if (bounds[hi] - bounds[lo] < size * 0.45) {
      const plain = (a, b, outermost) =>
        (outermost && b - a <= SLIVER) ||
        (b - a <= NARROW && (seg(a, b, mean) < DARK || seg(a, b, dev) < UNIFORM));
      lo = 0;
      hi = bounds.length - 1;
      while (lo < hi - 1 && plain(bounds[lo], bounds[lo + 1], lo === 0)) lo++;
      while (hi > lo + 1 && plain(bounds[hi - 1], bounds[hi], hi === bounds.length - 1)) hi--;
    }
    return [bounds[lo], bounds[hi]];
  };
  // NOTE (2026-09-04): a "bright content run" second hypothesis for the
  // wireframe-shell styles was tried here and ABANDONED: dark smooth face
  // content (embossed team-logo faces) and shell glow have identical
  // pixel statistics, so every statistical discriminator that shrank the
  // shell fringe also gutted the dark faces. Cropping shell insets to the
  // exact pane needs actual rectangle geometry (boundary-line fitting), a
  // future iteration; until then shell-style faces keep a glow fringe.
  const [x0, x1] = artSpan(lineSupport(true), meanProfile(true), devProfile(true));
  const [y0, y1] = artSpan(lineSupport(false), meanProfile(false), devProfile(false));
  return { x0, x1, y0, y1 };
}

// ---------- stage 5: squaring ----------

// The set art is truly square. Both window extents are trusted (the trim
// stage keeps the card's own border and margins by design), so a
// non-square window means the unwarp's scale is slightly off on one axis
// (the quad overshooting into glow does that); the whole window is KEPT
// and resampled to a square. Windows further than this from square get
// flagged instead: something else went wrong.
export const SQUARE_ASPECT_TOLERANCE = 1.3;

// ---------- fixed-quad extraction ----------

// The quads themselves live in src/services/hero-quads.js, ONE source
// shared with the in-browser generator (ipfs.generate.js); re-exported
// here so existing importers keep working.
export { FIXED_QUADS, fixedQuadVariantForSeries } from "../../src/services/hero-quads.js";
export const FIXED_QUAD_REF = HERO_REF;

// file -> square set-art via a fixed quad. The quad already delimits the
// face exactly, so the unwarp IS the final square: no art window, no
// aspect fixup. Alpha is kept; the caller flattens for opaque sources.
export async function extractSetArtFixed(file, opts = {}) {
  const size = opts.size ?? 1024;
  const variant = opts.variant ?? "old";
  const meta = await sharp(file).metadata();
  const scale = meta.width / HERO_REF;
  const quad = FIXED_QUADS[variant].map(([x, y]) => [x * scale, y * scale]);
  const fullRaw = await loadFullRaw(file);
  const rgba = unwarpFace(fullRaw, quad, size);
  const image = sharp(rgba, { raw: { width: size, height: size, channels: 4 } });
  return { image, meta: { variant, scale, quad } };
}

// ---------- full chain ----------

const UNWARP_SIZE = 1024;

// file -> square set-art sharp pipeline. Returns { image, meta }: image
// is a sharp instance holding the size x size square WITH alpha kept
// (transparent-background heroes stay transparent; the caller flattens
// and picks jpeg for opaque sources), meta records every intermediate
// decision for logging.
export async function extractSetArt(file, cid, lookup, opts = {}) {
  const size = opts.size ?? 1024;
  const borders = await bordersFor(cid, file, lookup);
  const crop = await borderCropRegion(file, borders);
  const det = await detectFaces(file, crop, opts);
  if (!det.faces) throw new Error(det.reason || "face detection failed");
  const fullRaw = await loadFullRaw(file);
  const face = det.faces.find((f) => f.name === "set-art");
  const rgba = unwarpFace(fullRaw, face.quad, UNWARP_SIZE);
  const win = artWindow(rgba, UNWARP_SIZE);
  const w = win.x1 - win.x0 + 1, h = win.y1 - win.y0 + 1;
  const aspect = Math.max(w, h) / Math.min(w, h);
  const image = sharp(rgba, { raw: { width: UNWARP_SIZE, height: UNWARP_SIZE, channels: 4 } })
    .extract({ left: win.x0, top: win.y0, width: w, height: h })
    .resize(size, size, { fit: "fill" });
  return {
    image,
    meta: {
      borders, crop, seamPct: det.seamPct, window: win,
      profile: det.profile,
      aspect: Number(aspect.toFixed(3)),
      suspect: aspect > SQUARE_ASPECT_TOLERANCE || Boolean(det.suspectDetection),
      suspectReason: det.suspectDetection ? det.reason : (aspect > SQUARE_ASPECT_TOLERANCE ? "aspect" : undefined)
    }
  };
}
