// Set-level status flags and the whole-set tier, read from the additions
// files (data/additions/sets.json and data/additions/editions.json).
//
//   burned:  ISO date on which Top Shot destroyed every moment in the set.
//            The contract never decrements numMinted, so the chain still
//            reports the original counts; the app strikes them through and
//            leaves them out of every total. Platinum Ice (sets 3, 27, 42,
//            52): 7,962 moments burned on 2023-01-11.
//   mismint: an empty duplicate set the contract created by mistake (155,
//            156, 158 in Series 6). Hidden from set lists and counts.
//
// These are facts about a SET, which is why they live here and not in
// plays_exclude.json: Platinum Ice reuses the same play IDs as Base Set and
// friends, so a play-level exclusion would erase the real moments too.
import setsAdditions from "../../data/additions/sets.json";
import editionsAdditions from "../../data/additions/editions.json";

export const MIXED_TIER = "Mixed";

export function getSetStatus(setID) {
  const add = setsAdditions[String(setID)] || {};
  return { burned: add.burned || null, mismint: add.mismint === true };
}

export function isBurnedSet(setID) {
  return getSetStatus(setID).burned !== null;
}

export function isMismintSet(setID) {
  return getSetStatus(setID).mismint;
}

// Tier of ONE edition: its own addition first, else the set-level tier
export function getEditionTier(setID, playID) {
  const ed = editionsAdditions[`${Number(setID)}_${Number(playID)}`];
  if (ed && ed.tier) return ed.tier;
  return (setsAdditions[String(setID)] || {}).tier || null;
}

// Tier of the whole set: the set-level tier when every edition shares it,
// "Mixed" when the editions carry different tiers, null when unknown
export function getSetTier(setID, playIDs) {
  const add = setsAdditions[String(setID)] || {};
  if (add.tier) return add.tier;
  const tiers = new Set();
  (playIDs || []).forEach((p) => {
    const ed = editionsAdditions[`${Number(setID)}_${Number(p)}`];
    if (ed && ed.tier) tiers.add(ed.tier);
  });
  if (tiers.size === 0) return null;
  return tiers.size === 1 ? [...tiers][0] : MIXED_TIER;
}
