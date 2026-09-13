import { Link } from "react-router-dom";
import { getArenaTwitterURL, formatHeight } from "../utils/display.utils";

/**
 * The information groups the play and edition pages share, one component
 * each so the two pages stay identical: Editorial (full width; hidden when
 * there is nothing to say), Profile, Biography, Autograph (only when there
 * is one), Supplement (full width). A page lays them out in its
 * .detail-sections-grid in that order.
 */

/** A muted dash for an empty value */
const dash = <span className="text-muted">-</span>;

export function EditorialSection({ headline, description, arena, dateOfMoment }) {
  const venueUrl = arena && arena.arena && dateOfMoment ? getArenaTwitterURL(arena, dateOfMoment) : "";
  if (!headline && !description && !venueUrl) return null;
  return (
    <div className="glass-panel detail-span-all">
      <h3>Editorial Context</h3>
      <div className="info-grid mt-20">
        {headline && (
          <div className="info-row">
            <span className="info-label">Headline</span>
            <span className="info-value editorial-headline">{headline}</span>
          </div>
        )}
        {description && (
          <div className="info-row info-row-stacked">
            <span className="info-label">Description</span>
            <span className="info-value editorial-description">{description}</span>
          </div>
        )}
        {venueUrl && (
          <div className="info-row">
            <span className="info-label">Venue Search</span>
            <span className="info-value venue-search">
              <a href={venueUrl} target="_blank" rel="noopener noreferrer" className="arena-twitter-link" title="Search X for posts near this arena on game day">
                {arena.arena} ↗
              </a>
              <span className="venue-assumed" title="The arena is the home team's venue on that date, not recorded on chain">assumed</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProfileSection({ play }) {
  const p = play || {};
  return (
    <div className="glass-panel">
      <h3>Profile</h3>
      <div className="info-grid mt-20">
        <div className="info-row">
          <span className="info-label">Jersey Number</span>
          <span className="info-value font-mono">{p.JerseyNumber || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Experience</span>
          <span className="info-value">{Number(p.TotalYearsExperience) > 0 ? `${Number(p.TotalYearsExperience)} Years` : (play ? "Rookie" : dash)}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Player Position</span>
          <span className="info-value">{p.PlayerPosition || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Primary Position</span>
          <span className="info-value">{p.PrimaryPosition || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Height</span>
          <span className="info-value">{play ? formatHeight(p.Height) : dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Weight</span>
          <span className="info-value">{p.Weight ? `${p.Weight} lbs` : dash}</span>
        </div>
      </div>
    </div>
  );
}

export function BiographySection({ play, renderTeamLink }) {
  const p = play || {};
  const birthdate = (() => {
    if (!p.Birthdate) return dash;
    const parts = p.Birthdate.split("-");
    return parts.length === 3
      ? <Link to={`/calendar/${parts[1]}-${parts[2]}`} className="date-calendar-link">{p.Birthdate}</Link>
      : p.Birthdate;
  })();
  return (
    <div className="glass-panel">
      <h3>Biography</h3>
      <div className="info-grid mt-20">
        <div className="info-row">
          <span className="info-label">Birthdate</span>
          <span className="info-value">{birthdate}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Birthplace</span>
          <span className="info-value">{p.Birthplace || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Draft Year</span>
          <span className="info-value">{p.DraftYear || "Undrafted"}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Draft Round</span>
          <span className="info-value">{p.DraftRound || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Draft Selection</span>
          <span className="info-value">{p.DraftSelection ? `Pick #${p.DraftSelection}` : dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Drafting Team</span>
          <span className="info-value">{(play && renderTeamLink && renderTeamLink(p.DraftTeam)) || dash}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Only when there is an autograph to show. `status` is the value of the
 * Type row (a badge, or a muted note such as "Not on this parallel");
 * `signedOn` lists where the signature is (edition names on the play
 * page, parallel names on the edition page).
 */
export function AutographSection({ status, signedOn, signer, date }) {
  if (!status) return null;
  return (
    <div className="glass-panel">
      <h3>Autograph</h3>
      <div className="info-grid mt-20">
        <div className="info-row">
          <span className="info-label">Autograph Type</span>
          <span className="info-value">{status}</span>
        </div>
        {signedOn && (
          <div className="info-row">
            <span className="info-label">Signed On</span>
            <span className="info-value">{signedOn}</span>
          </div>
        )}
        <div className="info-row">
          <span className="info-label">Signer</span>
          <span className="info-value">{signer || dash}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Date</span>
          <span className="info-value">{date || dash}</span>
        </div>
      </div>
    </div>
  );
}

const labelOf = (key) => key
  .replace(/_/g, " ")
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .trim()
  .split(" ")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(" ");

export function SupplementSection({ data }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <div className="glass-panel detail-span-all">
      <h3>Supplement Off-Chain Data</h3>
      <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
        These attributes were compiled from the off-chain plays addition file:
      </p>
      <div className="info-grid mt-20">
        {Object.entries(data).map(([key, val]) => {
          let displayVal;
          if (key === "tags" && Array.isArray(val)) {
            displayVal = (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {val.map((t) => (
                  <span className="badge badge-parallel" key={t} style={{ fontSize: "0.75rem", padding: "2px 8px", textTransform: "none" }}>{t}</span>
                ))}
              </div>
            );
          } else if (typeof val === "object") {
            displayVal = JSON.stringify(val);
          } else {
            displayVal = String(val);
          }
          return (
            <div className="info-row" key={key}>
              <span className="info-label">{labelOf(key)}</span>
              <span className="info-value" style={{ color: "var(--primary-hover)", fontWeight: "600" }}>{displayVal}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
