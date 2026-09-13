/*
 * Parallel size groups: a subedition's mint count per edition (Omega 1 ...
 * Rippled 4000), bucketed rarest first. Shared by the homepage parallels
 * matrix (columns) and the Sets page ?parallel= filter (sets that contain
 * a parallel of that size), so a click on a matrix cell lands on exactly
 * the sets it counted. The label doubles as the URL value.
 */
export const PARALLEL_GROUPS = [
  { label: "1 to 10", max: 10, color: "#c084fc" },
  { label: "25 to 50", max: 50, color: "#f87171" },
  { label: "75 to 100", max: 100, color: "#facc15" },
  { label: "250 to 500", max: 500, color: "#4ade80" },
  { label: "1000+", max: Infinity, color: "#94a3b8" }
];
export const PARALLEL_ORDER = PARALLEL_GROUPS.map((g) => g.label);
export const PARALLEL_COLORS = Object.fromEntries(PARALLEL_GROUPS.map((g) => [g.label, g.color]));
export const parallelGroup = (size) => (PARALLEL_GROUPS.find((g) => size <= g.max) || PARALLEL_GROUPS[PARALLEL_GROUPS.length - 1]).label;
