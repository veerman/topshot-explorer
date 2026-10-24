/*
 * Parallel size groups: a subedition's mint count per edition (Omega 1 ...
 * Rippled 4000), bucketed rarest first. Shared by the homepage parallels
 * matrix (columns) and the Sets page ?parallel= filter (sets that contain
 * a parallel of that size), so a click on a matrix cell lands on exactly
 * the sets it counted. The label doubles as the URL value. The bounds
 * spread the NBA parallels about evenly (4, 5, 5, 3 and 3 of them), with
 * Explosion (500) below the top group. Each group runs up to one below
 * the next group's first size, so the labels leave no gap a new size
 * could fall into (Animated, 17, arrived between 10 and 25).
 */
export const PARALLEL_GROUPS = [
  { label: "1 to 9", max: 9, color: "#c084fc" },
  { label: "10 to 49", max: 49, color: "#f87171" },
  { label: "50 to 99", max: 99, color: "#facc15" },
  { label: "100 to 999", max: 999, color: "#4ade80" },
  { label: "1000+", max: Infinity, color: "#94a3b8" }
];
export const PARALLEL_ORDER = PARALLEL_GROUPS.map((g) => g.label);
export const PARALLEL_COLORS = Object.fromEntries(PARALLEL_GROUPS.map((g) => [g.label, g.color]));
export const parallelGroup = (size) => (PARALLEL_GROUPS.find((g) => size <= g.max) || PARALLEL_GROUPS[PARALLEL_GROUPS.length - 1]).label;
