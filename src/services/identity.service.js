import { editionBadges } from "./autograph.service";
/*
 * The facts behind components/MomentIdentity.jsx: one context over the
 * local plays and sets, and factsOf(setID, playID) for any edition.
 */
import {
  applyPlayOverrides, getCalculatedPlayTags, buildTsdIndex, buildMintClock,
  withTags, editionTags, isMismintPlay
} from "./overrides.service";
import { commentaryFor, withCommentary } from "./commentary.service";
import { getEditionTier } from "./set.status";
import { getLeagueName } from "../utils/display.utils";

// No local metadata (a serial-level offer, another collection): every
// fact blank, so callers can spread it without null checks
export const BLANK_IDENTITY = {
  play: null, setName: "", series: null, player: "", team: "", league: "",
  tier: "", ptype: "", year: "", badges: [], mismint: false
};

/**
 * Facts context over the local plays and sets (IndexedDB records, raw):
 * factsOf(setID, playID) compiles the play with its overrides and derives
 * its badges (play tags, this edition's reward tags, its narrated cut),
 * cached per edition. Build it once per load (useMemo / state), since the
 * debut index and mint clock read every play.
 */
export function buildIdentityContext(plays, sets) {
  const all = plays || [];
  const playMap = new Map(all.map((p) => [Number(p.playID), p]));
  const setMap = new Map((sets || []).map((s) => [Number(s.id ?? s.setID), s]));
  const tsdIndex = buildTsdIndex(all);
  const mintClock = buildMintClock(all);
  const cache = new Map();
  const factsOf = (setID, playID) => {
    const sid = Number(setID), pid = Number(playID);
    const key = `${sid}_${pid}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const sRec = setMap.get(sid);
    const raw = playMap.get(pid);
    const play = raw ? applyPlayOverrides({ playID: pid, ...raw }) : null;
    const team = (play?.TeamAtMoment || "").trim();
    const facts = {
      play,
      setName: sRec?.setName || sRec?.name || `Set #${sid}`,
      series: sRec?.series != null ? Number(sRec.series) : null,
      player: (play?.FullName || "").trim(),
      team,
      league: team ? getLeagueName(team) : "",
      tier: getEditionTier(sid, pid) || "",
      ptype: (play?.PlayCategory || play?.PlayType || "").trim(),
      year: play?.DateOfMoment ? String(play.DateOfMoment).slice(0, 4) : "",
      badges: play
        ? editionBadges(withCommentary(withTags(getCalculatedPlayTags(play, null, tsdIndex, mintClock), editionTags(sid, pid)), Boolean(commentaryFor(sid, pid))), sid, pid)
        : [],
      mismint: isMismintPlay(pid)
    };
    cache.set(key, facts);
    return facts;
  };
  return { plays: playMap, sets: setMap, tsdIndex, mintClock, factsOf };
}

/** Column headings matching EditionCells, for the caller's <thead> */
export const EDITION_HEADINGS = ["Set", "Player", "Subedition", "Play"];
