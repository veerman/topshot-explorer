import { Link } from "react-router-dom";
import { useOwnedPct, toggleOwnedPct } from "../hooks/useOwnedPct";

/*
 * owned-over-total cell used across list pages when an account context is
 * set. Rendered as a stacked, right-justified fraction (numerator above a
 * thin bar, total beneath it) so digits line up down a column. Hovering
 * shows the percentage. With `pct` (Mints columns honouring the shared %
 * toggle) it renders the percentage instead and the tooltip carries the
 * raw fraction. `complete` (owned === total, total > 0) renders inside the green
 * .owned-complete box only when greenWhenFull is passed: owning every EDITION of a set is
 * meaningful, owning as many MOMENTS as the mint count is not (150 copies
 * of one LeBron is not the set).
 */
function pctString(owned, total) {
  const pct = total > 0 ? (owned / total) * 100 : 0;
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
}

/** With `to`, the fraction is a link (the list pages open the detail
 *  page on its missing rows: ?f_<owned column>=0). */
export function OwnedFraction({ owned, total, greenWhenFull = false, title, pct = false, to }) {
  const complete = greenWhenFull && total > 0 && owned >= total;
  const pctText = pctString(owned, total);
  const fracText = `${Number(owned).toLocaleString()}/${Number(total).toLocaleString()}`;
  const color = complete ? "var(--status-success)" : owned > 0 ? "#fff" : "var(--text-muted)";

  if (pct) {
    return (
      <span
        className={`font-mono owned-fraction${complete ? " owned-complete" : ""}`}
        title={title ? `${title} (${fracText})` : fracText}
        style={{ color, fontWeight: 600, cursor: "help" }}
      >
        {pctText}
      </span>
    );
  }

  const Tag = to ? Link : "span";
  return (
    <Tag
      {...(to ? { to } : {})}
      className={`font-mono owned-fraction${complete ? " owned-complete" : ""}${to ? " owned-fraction-link" : ""}`}
      title={to ? `${title ? `${title} (${pctText}). ` : ""}Click to see what is missing` : (title ? `${title} (${pctText})` : pctText)}
      style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25, verticalAlign: "middle", cursor: to ? "pointer" : "help", textDecoration: "none" }}
    >
      <span
        style={{
          color,
          fontWeight: 600,
          borderBottom: `1px solid ${complete ? "var(--status-success)" : "rgba(255, 255, 255, 0.28)"}`,
          paddingBottom: "1px",
          minWidth: "100%",
          textAlign: "right"
        }}
      >
        {Number(owned).toLocaleString()}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: "0.82em", paddingTop: "1px", textAlign: "right" }}>
        {Number(total).toLocaleString()}
      </span>
    </Tag>
  );
}

/*
 * The subtle % chip that lives in a Mints column header while browsing as
 * an account. One click flips every Mints fraction in the app between
 * fraction and percentage.
 */
export function OwnedPctToggle() {
  const pct = useOwnedPct();
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); toggleOwnedPct(); }}
      title={pct ? "Show owned/total fractions" : "Show owned percentages"}
      style={{
        background: pct ? "rgba(139, 92, 246, 0.25)" : "rgba(255, 255, 255, 0.06)",
        color: pct ? "var(--primary-hover)" : "var(--text-muted)",
        border: "1px solid " + (pct ? "rgba(139, 92, 246, 0.5)" : "rgba(255, 255, 255, 0.12)"),
        borderRadius: "4px",
        fontSize: "0.7em",
        fontWeight: 700,
        lineHeight: 1,
        padding: "2px 4px",
        cursor: "pointer"
      }}
    >
      %
    </button>
  );
}
