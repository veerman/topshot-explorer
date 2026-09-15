import { Link } from "react-router-dom";
import { badgeDef } from "../services/overrides.service";
import { editionSortKey } from "../utils/display.utils";

/*
 * The Editions column of a one-row-per-play table (Plays, a player's
 * plays): one line per edition of the play, named after its set, each
 * opening that edition, with the edition id in the hover text. A play not
 * yet in any set has no edition: its cell shows "?_<play id>" and opens
 * the play instead.
 *
 * Records carry: playID (string), playID_raw (number), matchingSets (from
 * editionRowFacts, highest set id first), and optionally rewardBySet
 * (set id -> reward badge names) and isMismint.
 */

/** Sets of a play in the column's descending order (highest set id first) */
export const setsByIdDesc = (sets) => (sets || []).slice().sort((a, b) => Number(b.id) - Number(a.id));

/**
 * The record fields the column and the row click need: the searchable
 * edition ids and set names under the column key, and the row's target.
 * A row with one edition (or none) opens it as a whole; with several,
 * only the set names are links.
 */
export function editionRowFacts(matchingSets, playID) {
  const single = matchingSets.length === 1;
  return {
    matchingSets,
    EditionIDs: matchingSets.length > 0
      ? [...matchingSets.map((s) => `${s.id}_${playID}`), ...matchingSets.map((s) => s.name)]
      : [`?_${playID}`],
    _clickable: matchingSets.length <= 1,
    _rowTo: matchingSets.length > 1 ? null : (single ? `/editions/${matchingSets[0].id}_${playID}` : `/plays/${playID}`)
  };
}

export function editionsColumn({ mismintBadge = false } = {}) {
  return {
    key: "EditionIDs",
    text: "Editions",
    // The app-wide edition order: play id, then set id (one row per play,
    // so the row sorts on its play id; a play in no set has no set id)
    sortValue: (_val, rec) => editionSortKey(rec.matchingSets?.[0]?.id, rec.playID_raw),
    // A plain-number filter matches ANY of the play's set IDs exactly; text
    // filters run on the ids and names ("_123" finds every edition of play 123)
    filterValue: (_val, rec) => (rec.matchingSets || []).map((s) => Number(s.id)),
    render: (_val, rec, { sortColumn, sortOrder }) => {
      // Lines follow the column's direction by set id (descending, the
      // default, while another column sorts the table)
      const matchingSets = rec.matchingSets || [];
      const ascending = sortColumn === "EditionIDs" && sortOrder === "asc";
      const ordered = ascending ? [...matchingSets].reverse() : matchingSets;
      const mismint = mismintBadge && rec.isMismint
        ? <span className="mini-badge-mismint" title="This play is a mismint!">Mismint ⚠️</span>
        : null;
      if (matchingSets.length === 0) {
        return (
          <div className="set-links-cell">
            <Link to={`/plays/${rec.playID}`} className="set-link" title={`Play ${rec.playID} is not in any set yet, so it has no edition; opens the play`}>
              ?_{rec.playID}
            </Link>
            {mismint}
          </div>
        );
      }
      return (
        <div className="set-links-cell" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {ordered.map((s) => {
            const editionID = `${s.id}_${rec.playID}`;
            // A reward badge belongs to ONE edition, not the play: its
            // glyph marks that edition
            const reward = rec.rewardBySet && rec.rewardBySet[s.id];
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "2px", whiteSpace: "nowrap" }}>
                <Link to={`/editions/${editionID}`} className="set-link" title={`Edition ${editionID}: ${s.name} (Series ${s.series})${reward ? `; ${reward.join(", ")}` : ""}`}>
                  {s.name}
                </Link>
                {reward && (
                  <span className="set-link-mark" title={`Edition ${editionID}: ${reward.join(", ")}`}>
                    {reward.map((t) => (badgeDef(t) || {}).emoji || "").join("")}
                  </span>
                )}
              </div>
            );
          })}
          {mismint}
        </div>
      );
    }
  };
}
