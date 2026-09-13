// Fixed HERO-render geometry and blank-pixel thresholds: PURE DATA, no
// imports, no platform APIs, so both sides of the fence share one source:
// the browser generator (ipfs.generate.js) and the offline pipeline
// (scripts/lib/hero-split.mjs, analyze-image-borders, extract-set-art).
// A future render generation gets measured ONCE, here.

// Reference edge length of the heroes the quads were measured on.
export const HERO_REF = 2880;

// The cube render camera never moves within a generation, so the set-art
// face sits at the SAME absolute pixel position in every 2880x2880 hero.
// These trapezoids (tall edge left, receding right; corners clockwise from
// top-left) were measured from hand-painted masks:
// seven masks across Common, Rare, Legendary and Ultimate collapsed to two
// variants within a couple of pixels, then were snapped to clean values
// ("old" is symmetric about y=1440, the image's vertical centre). "old"
// fits roughly S1-S5 renders, "new" S6+.
export const FIXED_QUADS = {
  old: [[1585, 675], [2295, 880], [2295, 2000], [1585, 2205]],
  new: [[1553, 655], [2263, 875], [2263, 1985], [1553, 2210]]
};

export function fixedQuadVariantForSeries(series) {
  return Number(series) >= 6 ? "new" : "old";
}

// Blank-pixel rule shared by the border census, the offline border crop,
// and the browser's photo-hero detector: a pixel is BLANK when it is
// transparent, near-black, or near-white; a border/background LINE is
// blank when at least BLANK_LINE_SHARE of its pixels are.
export const BLANK_ALPHA_MAX = 8;
export const BLANK_DARK_MAX = 12;
export const BLANK_BRIGHT_MIN = 243;
export const BLANK_LINE_SHARE = 0.995;

export function isBlankRGB(r, g, b) {
  return (r <= BLANK_DARK_MAX && g <= BLANK_DARK_MAX && b <= BLANK_DARK_MAX)
    || (r >= BLANK_BRIGHT_MIN && g >= BLANK_BRIGHT_MIN && b >= BLANK_BRIGHT_MIN);
}

export function isBlankRGBA(r, g, b, a) {
  return a <= BLANK_ALPHA_MAX || isBlankRGB(r, g, b);
}
