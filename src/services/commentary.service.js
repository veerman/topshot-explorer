// Narrated cuts of specific editions from the original nbatopshot.com
// (data/commentary.json: hotlinks to Dapper-hosted files, nothing in the
// bucket). Keyed by set + play, so this is EDITION-level context: it never
// enters the calculated play tags, the homepage matrices, or the account
// facets. Pages that show an edition (set rows, the edition page) and the
// Plays page (any edition of the play) add the badge themselves.
import commentary from "../../data/commentary.json";

export const COMMENTARY_TAG = "Commentary";

const PLAYS_WITH_COMMENTARY = new Set(
  Object.keys(commentary)
    .filter((k) => k !== "_meta")
    .map((k) => Number(k.split("_")[1]))
);

/** The narrated cut for one edition, or null: { narrator, player, avatar, video } */
export function commentaryFor(setID, playID) {
  return commentary[`${Number(setID)}_${Number(playID)}`] || null;
}

/** True when at least one edition of the play has a narrated cut */
export function playHasCommentary(playID) {
  return PLAYS_WITH_COMMENTARY.has(Number(playID));
}

/** A play's tag list plus the Commentary badge when `has` is true (never
 *  mutates the input: the tag lists may be shared) */
export function withCommentary(tags, has) {
  return has ? [...tags, COMMENTARY_TAG] : tags;
}
