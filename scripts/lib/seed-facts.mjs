// Memoized facts from public/seed/topshot-seed.json plus the additions
// files, for the image-derivation scripts: six of them used to each load
// the seed and rebuild the same name/series/tier/team lookups.
//
// tierFor mirrors src/services/set.status.js getEditionTier (edition
// addition first, else set-level tier); the additions are read directly so
// these scripts keep running under plain node (the app module needs the
// json import hook).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";

let seedCache = null;
export function loadSeed() {
  if (!seedCache) {
    seedCache = JSON.parse(readFileSync(join(ROOT, "public", "seed", "topshot-seed.json"), "utf8"));
  }
  return seedCache;
}

/** Every edition in the seed as { setID, playID, momentCount }, the shape
 *  attachMintTotals (overrides.service) reads, so a script that compiles
 *  plays from a raw snapshot derives debuts exactly like the app */
export function seedEditions() {
  const seed = loadSeed();
  const out = [];
  seed.setDetails.forEach((sd) => {
    (sd.editions || []).forEach((e) => out.push({ setID: sd.id, playID: e.playID, momentCount: e.momentCount }));
  });
  return out;
}

let factsCache = null;
export function seedFacts() {
  if (!factsCache) {
    const seed = loadSeed();
    const setsAdditions = JSON.parse(readFileSync(join(ROOT, "data", "additions", "sets.json"), "utf8"));
    const editionsAdditions = JSON.parse(readFileSync(join(ROOT, "data", "additions", "editions.json"), "utf8"));
    const namesBySet = new Map(seed.setsOverview.map((s) => [Number(s.id), s.setName]));
    const seriesBySet = new Map(seed.setsOverview.map((s) => [Number(s.id), Number(s.series)]));
    const detailsBySet = new Map(seed.setDetails.map((sd) => [Number(sd.id), sd]));
    const tierFor = (setID, playID) => {
      const ed = editionsAdditions[`${Number(setID)}_${Number(playID)}`];
      if (ed && ed.tier) return ed.tier;
      return (setsAdditions[String(setID)] || {}).tier || "unknown";
    };
    const teamFor = (playID) => (seed.playsRaw[String(Number(playID))] || {}).TeamAtMoment || "Unknown";
    factsCache = { seed, namesBySet, seriesBySet, detailsBySet, tierFor, teamFor };
  }
  return factsCache;
}
