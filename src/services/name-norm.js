/*
 * Player-name normalization for cross-source matching (chain names vs
 * basketball-reference): case, diacritics, periods and apostrophes fold
 * away; hyphens and suffixes stay because they distinguish real people
 * (Gary Payton is in the Hall of Fame, Gary Payton II is not). Stroke
 * letters that NFD cannot decompose fold explicitly (Rađa vs Radja).
 * Shared by the Hall of Fame badge derivation (overrides.service) and
 * scripts/fetch-awards.mjs so the two sides can never drift apart. Pure
 * module with no JSON imports, so scripts use it without the
 * node-json-hook loader.
 */
export function normPlayerName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'\u2019]/g, "")
    .toLowerCase()
    .replace(/\u0111/g, "d")
    .replace(/\u0142/g, "l")
    .replace(/\u00f8/g, "o")
    .replace(/\s+/g, " ")
    .trim();
}
