import burns from "../../data/burns.json";
import { runSizeFor } from "../utils/serials.utils";
import { signedSubs } from "./autograph.service";

/**
 * Remaining supply: the moments of an edition that still exist.
 *
 * The chain reports what was minted and never decrements it, so a burned
 * moment (Top Shot's own destroy, or a collector's) stays in the count.
 * data/burns.json carries the destroyed count per edition from Atlas
 * (`npm run atlas:burns`), and every surface that would show the mint
 * count shows minted minus burned instead: the number a collector can
 * actually chase. Settings switches back to the original mint counts
 * (localStorage `show_remaining_supply`, default on). Either way the
 * other number is one hover away: src/components/Supply.jsx.
 *
 * Serial numbers are positions in the original run, so anything that
 * reasons about serials (#1, jersey, last) keeps using the mint count.
 */
const STORAGE_KEY = "show_remaining_supply";
let remainingCache = null;

export function isRemainingSupply() {
  if (remainingCache === null) {
    try {
      remainingCache = localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
      remainingCache = true;
    }
  }
  return remainingCache;
}

export function setRemainingSupply(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  } catch { /* private mode */ }
  remainingCache = null;
}

/** When the burn counts were read from Atlas (ISO timestamp, or "") */
export function burnsAsOf() {
  return burns.asOf || "";
}

/**
 * Moments destroyed of an edition: the whole edition, or one subedition
 * when `sub` is given (0 = Standard). An entry is a number when every
 * destroyed moment was Standard, else a { subeditionID: n } map whose sum
 * is the edition's count. Unknown editions have none.
 */
export function burnedOf(setID, playID, sub = null) {
  const entry = burns.editions[`${Number(setID)}_${Number(playID)}`];
  if (entry === undefined) return 0;
  if (typeof entry === "number") return sub === null || Number(sub) === 0 ? entry : 0;
  if (sub === null) return Object.values(entry).reduce((s, n) => s + (Number(n) || 0), 0);
  return Number(entry[String(Number(sub))]) || 0;
}

/** Minted minus burned, whatever the setting says */
export function remainingOf(minted, setID, playID, sub = null) {
  return Math.max(0, (Number(minted) || 0) - burnedOf(setID, playID, sub));
}

/**
 * The number to show for an edition (or one of its subeditions): minted
 * minus burned while the setting is on, the mint count otherwise.
 */
export function supplyOf(minted, setID, playID, sub = null) {
  const m = Number(minted) || 0;
  if (!isRemainingSupply()) return m;
  return remainingOf(m, setID, playID, sub);
}

/**
 * The number NOT shown for an edition: the mint count while the setting
 * is on, the remaining supply otherwise. Aggregates keep this beside the
 * shown sum so a cell can swap to it (Supply `shown` / `other`).
 */
export function otherSupplyOf(minted, setID, playID, sub = null) {
  const m = Number(minted) || 0;
  return isRemainingSupply() ? m : remainingOf(m, setID, playID, sub);
}

/** The word for the number shown: "Remaining" while the setting is on, else "Minted" */
export function supplyLabel() {
  return isRemainingSupply() ? "Remaining" : "Minted";
}

/**
 * The signed moments of an edition: the run of each signed parallel
 * (data/autographs.json), as shown per the setting, or the number not
 * shown (`other`). Zero when nothing of the edition is signed.
 */
export function signedSupplyOf(minted, setID, playID, other = false) {
  const subs = signedSubs(setID, playID);
  if (!subs) return 0;
  const pick = other ? otherSupplyOf : supplyOf;
  return subs.reduce((s, sub) => s + pick(runSizeFor(setID, sub, minted) || 0, setID, playID, sub), 0);
}
