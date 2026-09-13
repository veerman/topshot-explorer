import { Link } from "react-router-dom";
import { SPECIAL_LABELS } from "../utils/serials.utils";

/**
 * One figure in an ownership banner: a short muted label over the number
 * (the same shape as the page headers' stat strips), an optional green
 * complete box with a ✓. Shared by the detail pages' banner below and the
 * set page's per-variant version.
 */
export function OwnedStat({ n, label, title, check = false }) {
  const figure = typeof n === "number" ? n.toLocaleString() : n;
  return (
    <div className="stat-item" title={title} style={title ? { cursor: "help" } : undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {check ? (
          <span className="owned-complete">{figure}<span className="owned-stat-check" title="Complete">✓</span></span>
        ) : figure}
      </span>
    </div>
  );
}

/** A wrapping row of OwnedStat figures */
export function OwnedStrip({ children }) {
  return <div className="stat-strip stat-strip-sm">{children}</div>;
}

/** Special serials owned, one chip each ("Jersey number ×3"), or null */
export function OwnedSpecials({ specialCounts }) {
  const specials = Object.keys(SPECIAL_LABELS).filter((k) => specialCounts[k]);
  if (specials.length === 0) return null;
  return (
    <div className="mt-12">
      <div className="stat-label">Specials</div>
      <div className="special-chips">
        {specials.map((k) => (
          <span key={k} className="special-chip">
            {SPECIAL_LABELS[k]} <span className="special-chip-count">×{specialCounts[k].toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Green ownership banner for detail pages (player, team), fed by
 * summarizeOwnedPlays. The page itself says what the numbers are of, and
 * its header's play count already reads owned/total while browsing as an
 * account, so the banner states only what is new: the total, complete
 * copies, the average serial, specials. The set page renders its own
 * per-variant version; all share the .owned-set-banner styling in index.css.
 */
export function OwnedSummaryBanner({ summary, link }) {
  if (!summary) return null;
  return (
    <div className="owned-set-banner mt-20">
      <div className="d-flex align-center justify-between flex-wrap gap-10">
        <h4>{summary.total.toLocaleString()} owned</h4>
        {summary.total > 0 && link && (
          <Link to={link} style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}>
            Account table →
          </Link>
        )}
      </div>
      {summary.total > 0 ? (
        <>
          <OwnedStrip>
            {summary.fullCopies > 0 && (
              <OwnedStat
                n={summary.fullCopies}
                label={summary.fullCopies === 1 ? "Complete copy" : "Complete copies"}
                title="Whole runs of every play here: the lowest count across the plays"
              />
            )}
            {summary.avgBestSerial != null && (
              <OwnedStat n={`#${summary.avgBestSerial.toLocaleString()}`} label="Avg serial" title="Average of your lowest serial per play" />
            )}
          </OwnedStrip>
          <OwnedSpecials specialCounts={summary.specialCounts} />
        </>
      ) : (
        <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>None owned.</p>
      )}
    </div>
  );
}
