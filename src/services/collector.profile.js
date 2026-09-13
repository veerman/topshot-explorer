import setsParallels from "../../data/sets_parallels.json";
import { supplyOf } from "./supply.service";
import { runSizeFor } from "../utils/serials.utils";
import { SUBEDITION_NAMES } from "./fcl.service";
import { isMismintPlay, editionTags, withTags, getSeriesInfo } from "./overrides.service";
import { editionBadges } from "./autograph.service";
import { getEditionTier, isBurnedSet } from "./set.status";

/**
 * A collector's profile: what an account holds more of than the field
 * does, one line per dimension (team, player, tier, parallel, series,
 * set, badge, league) and the serial numbers that recur.
 *
 * The baseline is the supply of every edition and parallel (remaining
 * or original mints, as the Settings switch has it),
 * whatever Settings shows elsewhere. For a value v of a dimension:
 *   share      = owned(v) / owned(all)         how much of the collection it is
 *   fieldShare = remaining(v) / remaining(all) how much of the field it is
 *   hold       = owned(v) / remaining(v)       how much of everything of v you hold
 *   lift       = share / fieldShare  (= hold / (owned(all) / remaining(all)))
 * so lift 3 means v is three times the share of the collection that it is
 * of the field. A lean is the value with the highest lift among those big
 * enough to mean something (at least MIN_COUNT copies).
 *
 * Serials: every copy has a serial drawn from its run, so the expected
 * count of serial s across the collection is the sum over copies of 1/R
 * for runs of size R >= s. A serial you hold far more often than that is
 * a habit worth naming.
 */
const DIMENSIONS = [
  { key: "team", label: "Team" },
  { key: "player", label: "Player" },
  { key: "tier", label: "Tier" },
  { key: "parallel", label: "Parallel" },
  { key: "series", label: "Series" },
  { key: "set", label: "Set" },
  { key: "badge", label: "Badge" },
  { key: "league", label: "League" }
];
const MIN_LIFT = 1.25;

export function buildCollectorProfile({ index, editions, playByID, setByID, playTags, playLeague }) {
  if (!index || !editions || editions.length === 0 || !playByID || playByID.size === 0) return null;

  const parallelName = (sub) => (sub === 0 ? "Standard" : (SUBEDITION_NAMES[sub] || `Subedition ${sub}`));
  const seriesName = (series) => (getSeriesInfo(series) || {}).name || `Series ${series}`;
  // The values a run (set, play, parallel) contributes to each dimension
  const factsOf = (setID, playID, sub) => {
    const play = playByID.get(String(playID));
    const set = setByID.get(String(setID));
    if (!play || !set) return null;
    const tags = editionBadges(withTags((playTags && playTags.get(String(playID))) || [], editionTags(setID, playID)), setID, playID, sub);
    return {
      team: (play.TeamAtMoment || "").trim() || null,
      player: (play.FullName || "").trim() || null,
      tier: getEditionTier(setID, playID) || null,
      parallel: parallelName(sub),
      series: set.series !== undefined && set.series !== null ? seriesName(set.series) : null,
      set: set.setName || set.name || `Set #${setID}`,
      badge: tags,
      league: (playLeague && playLeague.get(String(playID))) || "NBA"
    };
  };
  const dims = {};
  DIMENSIONS.forEach((d) => { dims[d.key] = { owned: new Map(), supply: new Map() }; });
  const add = (map, value, n) => {
    if (value === null || value === undefined || n <= 0) return;
    map.set(value, (map.get(value) || 0) + n);
  };
  const addFacts = (facts, n, which) => {
    DIMENSIONS.forEach((d) => {
      const v = facts[d.key];
      if (Array.isArray(v)) v.forEach((x) => add(dims[d.key][which], x, n));
      else add(dims[d.key][which], v, n);
    });
  };

  // The field: every run of every edition, at the supply Settings shows
  let totalSupply = 0;
  editions.forEach((ed) => {
    const setID = Number(ed.setID), playID = Number(ed.playID);
    if (isMismintPlay(playID) || isBurnedSet(setID)) return;
    const subs = [0, ...(setsParallels[String(setID)] || [])];
    subs.forEach((sub) => {
      const run = runSizeFor(setID, sub, ed.momentCount) || 0;
      const rem = supplyOf(run, setID, playID, sub);
      if (rem <= 0) return;
      const facts = factsOf(setID, playID, sub);
      if (!facts) return;
      totalSupply += rem;
      addFacts(facts, rem, "supply");
    });
  });
  if (totalSupply === 0) return null;

  // The collection: every run held, plus the serial habits
  const mintOf = new Map(editions.map((e) => [`${Number(e.setID)}_${Number(e.playID)}`, Number(e.momentCount) || 0]));
  let totalOwned = 0;
  const serialActual = new Map(); // serial -> copies
  const runWeights = new Map(); // run size R -> copies / R
  let lowActual = 0, lowExpected = 0; // serials 1-10
  index.serials.forEach((list, key) => {
    const [setStr, playStr, subStr] = key.split("_");
    const setID = Number(setStr), playID = Number(playStr), sub = Number(subStr);
    if (isMismintPlay(playID)) return;
    const facts = factsOf(setID, playID, sub);
    if (!facts) return;
    const n = list.length;
    totalOwned += n;
    addFacts(facts, n, "owned");
    const run = runSizeFor(setID, sub, mintOf.get(`${setID}_${playID}`) || 0) || 0;
    list.forEach((serial) => { serialActual.set(serial, (serialActual.get(serial) || 0) + 1); });
    if (run > 0) {
      runWeights.set(run, (runWeights.get(run) || 0) + n / run);
      lowExpected += n * Math.min(10, run) / run;
      lowActual += list.filter((s) => s <= 10).length;
    }
  });
  if (totalOwned === 0) return null;
  const baseHold = totalOwned / totalSupply;
  const minCount = Math.max(5, Math.round(totalOwned * 0.005));

  const leans = DIMENSIONS.map((d) => {
    const { owned, supply } = dims[d.key];
    let best = null;
    let biggest = null;
    owned.forEach((n, value) => {
      const rem = supply.get(value) || 0;
      const share = n / totalOwned;
      if (!biggest || n > biggest.owned) biggest = { value, owned: n, share, supply: rem };
      if (n < minCount || rem <= 0) return;
      const fieldShare = rem / totalSupply;
      const hold = n / rem;
      const lift = share / fieldShare;
      if (!best || lift > best.lift) best = { value, owned: n, supply: rem, share, fieldShare, hold, lift };
    });
    return { key: d.key, label: d.label, lean: best && best.lift >= MIN_LIFT ? best : null, biggest };
  });

  // Expected copies per serial: the suffix sum of run weights over R >= s
  const runsDesc = [...runWeights.keys()].sort((a, b) => b - a);
  const expectedFor = (s) => {
    let e = 0;
    for (const R of runsDesc) { if (R < s) break; e += runWeights.get(R); }
    return e;
  };
  let serialLean = null;
  serialActual.forEach((n, serial) => {
    if (n < 5) return;
    const expected = expectedFor(serial);
    if (expected <= 0) return;
    const lift = n / expected;
    if (!serialLean || lift > serialLean.lift) serialLean = { serial, owned: n, expected, lift };
  });
  const lowSerials = lowExpected > 0 ? { owned: lowActual, expected: lowExpected, lift: lowActual / lowExpected } : null;

  return { totalOwned, totalSupply, baseHold, minCount, leans, serialLean, lowSerials };
}
