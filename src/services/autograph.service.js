import autographs from "../../data/autographs.json";

/**
 * Which parallels of an edition carry the printed autograph.
 *
 * The chain flags an autograph on the PLAY (PlayerAutographType), one
 * value shared by every edition and parallel of that play. The signature
 * is a fact of one edition: in a set with parallels usually only the
 * rarest parallel is signed, and some signed plays carry no chain flag
 * at all. data/autographs.json (from Atlas, `npm run atlas:autographs`)
 * lists the signed subedition ids per edition, so the Autograph badge is
 * derived per parallel from it: a play carries the badge when any of its
 * editions is signed, and an edition or parallel view keeps it only where
 * it applies (editionBadges). The chain flag is a check on the Corrections
 * page (audit.service detectAutographFindings).
 */
const keyOf = (setID, playID) => `${Number(setID)}_${Number(playID)}`;

/** The signed subedition ids of an edition (0 = Standard), or null */
export function signedSubs(setID, playID) {
  return autographs.editions[keyOf(setID, playID)] || null;
}

/** Whether an edition (sub null: any parallel) or one parallel is signed */
export function isSigned(setID, playID, sub = null) {
  const subs = signedSubs(setID, playID);
  if (!subs) return false;
  return sub === null || sub === undefined ? true : subs.includes(Number(sub));
}

let signedPlays = null;
/** Whether any edition of the play is signed */
export function playSigned(playID) {
  if (!signedPlays) {
    signedPlays = new Set();
    Object.keys(autographs.editions).forEach((k) => signedPlays.add(k.split("_")[1]));
  }
  return signedPlays.has(String(Number(playID)));
}

/**
 * A play's badges narrowed to one edition (sub null) or one parallel:
 * Autograph stays only where the signature is. Every other badge is a
 * fact of the play or the edition and passes through.
 */
export function editionBadges(tags, setID, playID, sub = null) {
  if (!tags || tags.length === 0 || !tags.includes("Autograph")) return tags;
  if (isSigned(setID, playID, sub)) return tags;
  return tags.filter((t) => t !== "Autograph");
}

/** When the signed parallels were read from Atlas (ISO timestamp, or "") */
export function autographsAsOf() {
  return autographs.asOf || "";
}
