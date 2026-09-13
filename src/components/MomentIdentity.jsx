import { Link } from "react-router-dom";
import { Badges } from "./Badges";
import { subeditionLabel } from "../services/fcl.service";
import { editionBadges } from "../services/autograph.service";
import { playSummary, playerPath } from "../utils/display.utils";

/*
 * How a moment or edition identifies itself wherever it appears outside
 * its own page (the Offers tables, the Live feed): the ONE order is
 *
 *   id · set · player (badges beneath) · parallel · play (date · category) · #serial
 *
 * which merges what the Plays page (Play ID, Set IDs, Player, Category,
 * Date) and the set page (Edition ID, Full Name, Subedition) already do.
 * Offers and Live both render it as table cells, reading the same facts
 * from buildIdentityContext (services/identity.service.js), so the pages
 * cannot drift.
 */

const dash = <span className="text-muted">-</span>;

const editionKey = (setID, playID, subID) => `${Number(setID)}_${Number(playID)}${subID > 0 ? `_${Number(subID)}` : ""}`;

/** The player's name (linked) with the mismint marker; a team moment
 *  shows its team; nothing known shows a dash */
function PlayerName({ facts, linkClass, onClick }) {
  if (!facts || (!facts.player && !facts.team)) return dash;
  const inner = (
    <>
      {facts.player || facts.team}
      {facts.mismint && <span className="mini-badge-mismint" title="This play is a mismint!">Mismint ⚠️</span>}
    </>
  );
  return facts.player
    ? <Link to={playerPath(facts.player)} className={linkClass || "player-detail-link font-hover-glow"} onClick={onClick}>{inner}</Link>
    : <span className={linkClass || "player-detail-link"}>{inner}</span>;
}

/**
 * Table form: the four edition columns after the id, in order
 *   Set | Player (badges beneath) | Subedition | Play
 * `sub` is the Subedition cell's content when the caller knows better
 * than the plain subedition id (an offer that accepts Any parallel);
 * without facts (no local metadata) every cell is a dash.
 */
export function EditionCells({ facts, setID, playID, subID, sub, onClick }) {
  const f = facts || null;
  const subCell = sub !== undefined ? sub
    : subID > 0 ? <Link to={`/editions/${editionKey(setID, playID, subID)}`} onClick={onClick}>{subeditionLabel(Number(subID))}</Link>
    : dash;
  return (
    <>
      <td>{f && f.setName ? <Link to={`/sets/${Number(setID)}`} onClick={onClick}>{f.setName}</Link> : dash}</td>
      <td>
        {f && (f.player || f.team) ? (
          <div className="name-cell">
            <PlayerName facts={f} onClick={onClick} />
            <Badges tags={subID === undefined || subID === null ? f.badges : editionBadges(f.badges, setID, playID, subID)} />
          </div>
        ) : dash}
      </td>
      <td>{f ? subCell : dash}</td>
      <td>{f && f.play ? <Link to={`/plays/${Number(playID)}`} onClick={onClick}>{playSummary(f.play, Number(playID))}</Link> : dash}</td>
    </>
  );
}
