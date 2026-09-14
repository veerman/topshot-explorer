import { SUBEDITION_MINT_COUNTS } from "../services/fcl.service";
import setsParallels from "../../data/sets_parallels.json";
import { isWnbaTeam } from "./display.utils";
import teamsAdditions from "../../data/additions/teams.json";

/*
 * Special-serial detection, shared by the account page filters and the
 * set-page ownership summary so the rules live in exactly one place.
 */

export const SPECIAL_LABELS = {
  first: "Serial #1",
  jersey: "Jersey number",
  last: "Last serial",
  draft: "Draft year",
  pick: "Draft pick",
  moment: "Moment year",
  birth: "Birth year",
  area: "Area code",
  nba75: "NBA at 75"
};

/*
 * Home area codes per team, from the curated arenas (data/additions/
 * teams.json). A home arena is one the team played in for more than 90
 * days (or with no dates); the 2020 bubble (58 days) and the international
 * games (a day or two) are short stays at someone else's building and
 * carry no code of the team's. A building renamed within its first
 * months still counts. Only plain three-digit codes count; "+52" is a
 * country code.
 */
const DAY = 86400000;
const HOME_SPAN = 90 * DAY;
let homeArenas = null;
function homeArenasOf(teamId) {
  if (!homeArenas) {
    homeArenas = new Map();
    Object.entries(teamsAdditions).forEach(([id, t]) => {
      const list = [];
      (t.arenas || []).forEach((a) => {
        const code = /^\d{3}$/.test(String(a.area_codes || "").trim()) ? Number(a.area_codes) : null;
        if (!code) return;
        const start = a.start_date ? Date.parse(a.start_date) : null;
        const end = a.end_date ? Date.parse(a.end_date) : null;
        const span = start && end ? end - start : Infinity;
        if (span <= HOME_SPAN) return;
        list.push({ code, start, end });
      });
      homeArenas.set(id, list);
    });
  }
  return homeArenas.get(String(teamId)) || [];
}

/**
 * The area codes a serial can match for a play: the codes of the team's
 * home arenas in use when the moment happened, or every home code the
 * franchise has had when the date is unknown or matches none.
 */
export function areaCodesFor(teamId, dateOfMoment) {
  const arenas = homeArenasOf(teamId);
  if (arenas.length === 0) return [];
  const t = dateOfMoment ? Date.parse(String(dateOfMoment).slice(0, 10)) : NaN;
  const atDate = Number.isNaN(t) ? [] : arenas.filter((a) => (a.start === null || t >= a.start) && (a.end === null || t <= a.end));
  const pick = atDate.length > 0 ? atDate : arenas;
  return [...new Set(pick.map((a) => a.code))];
}

/** The numeric play facts a special serial can coincide with. */
export function playSerialFacts(play) {
  return {
    jersey: Number(play.JerseyNumber) || null,
    draftYear: Number(play.DraftYear) || null,
    draftPick: Number(play.DraftSelection) || null,
    birthYear: play.Birthdate ? (Number(String(play.Birthdate).slice(0, 4)) || null) : null,
    momentYear: play.DateOfMoment ? (Number(String(play.DateOfMoment).slice(0, 4)) || null) : null,
    areaCodes: areaCodesFor(play.TeamAtMomentNBAID, play.DateOfMoment),
    // NBA at 75 is an NBA badge; WNBA moments of that season carry none
    wnba: isWnbaTeam(play.TeamAtMoment)
  };
}

/** Which special-serial kinds a serial number hits for its play/run. */
export function serialKinds(serial, pf, runSize, series) {
  const kinds = [];
  if (serial === 1) kinds.push("first");
  if (pf?.jersey && serial === pf.jersey) kinds.push("jersey");
  if (runSize && serial === runSize) kinds.push("last");
  if (pf?.draftYear && serial === pf.draftYear) kinds.push("draft");
  if (pf?.draftPick && serial === pf.draftPick) kinds.push("pick");
  if (pf?.momentYear && serial === pf.momentYear) kinds.push("moment");
  if (pf?.birthYear && serial === pf.birthYear) kinds.push("birth");
  if (pf?.areaCodes && pf.areaCodes.includes(serial)) kinds.push("area");
  // NBA 75th anniversary season: marketing "Series 3" is data series 4;
  // NBA moments only
  if (series === 4 && serial === 75 && !pf?.wnba) kinds.push("nba75");
  return kinds;
}

/**
 * Ownership summary over a group of plays (player page, team page): how
 * many moments the browsed account owns of those plays, distinct-play
 * coverage, full copies (minimum quantity across every play), the average
 * serial of the best copy (lowest owned serial per play), and any special
 * serials owned.
 *
 * index         useAccountCollection().index (serials keyed "set_play_sub")
 * playIDs       Set of numeric play ids the group covers (mismints excluded)
 * playFactsByID Map(playID -> playSerialFacts(play))
 * editionTotals Map("set_play" -> on-chain momentCount)
 * seriesBySet   Map(setID -> numeric series)
 */
export function summarizeOwnedPlays(index, playIDs, playFactsByID, editionTotals, seriesBySet) {
  const countByPlay = new Map();
  const bestByPlay = new Map();
  const specialCounts = {};
  let total = 0;
  index.serials.forEach((list, key) => {
    const [setID, playID, sub] = key.split("_").map(Number);
    if (!playIDs.has(playID)) return;
    total += list.length;
    countByPlay.set(playID, (countByPlay.get(playID) || 0) + list.length);
    const pf = playFactsByID.get(playID) || {};
    const runSize = runSizeFor(setID, sub, editionTotals.get(`${setID}_${playID}`));
    const series = seriesBySet.get(setID);
    list.forEach((raw) => {
      const s = Number(raw);
      const best = bestByPlay.get(playID);
      if (best === undefined || s < best) bestByPlay.set(playID, s);
      serialKinds(s, pf, runSize, series == null ? null : series).forEach((k) => {
        specialCounts[k] = (specialCounts[k] || 0) + 1;
      });
    });
  });
  let fullCopies = Infinity;
  playIDs.forEach((id) => { fullCopies = Math.min(fullCopies, countByPlay.get(id) || 0); });
  let bestSum = 0;
  bestByPlay.forEach((s) => { bestSum += s; });
  return {
    total,
    ownedPlays: bestByPlay.size,
    totalPlays: playIDs.size,
    fullCopies: Number.isFinite(fullCopies) ? fullCopies : 0,
    avgBestSerial: bestByPlay.size > 0 ? Math.round(bestSum / bestByPlay.size) : null,
    specialCounts
  };
}

/**
 * Mint-run size of an edition (what "last serial" means): parallels have
 * fixed run sizes; Standard in a set with parallels is the on-chain
 * edition total minus the parallel capacities (same rule as the set page).
 */
export function runSizeFor(setID, sub, editionTotal) {
  if (Number(sub) > 0) return SUBEDITION_MINT_COUNTS[sub] || null;
  const total = Number(editionTotal) || 0;
  if (!total) return null;
  const subIDs = setsParallels[String(Number(setID))];
  if (!subIDs || subIDs.length === 0) return total;
  const subSum = subIDs.reduce((s, id) => s + (SUBEDITION_MINT_COUNTS[id] || 0), 0);
  return Math.max(0, total - subSum) || null;
}
