/**
 * The first sync's progress, for a page that has nothing to show yet.
 * Pages render it only in their empty state: unmounting it under a
 * populated table would jump the page, and the navbar pill already shows
 * sync status. `panel` draws it as its own tinted panel.
 */
export function SyncProgress({ state, panel = false, className = "" }) {
  return (
    <div
      className={[panel ? "glass-panel" : "", className].filter(Boolean).join(" ")}
      style={panel ? { background: "rgba(139, 92, 246, 0.05)", borderColor: "var(--primary)" } : { marginTop: "16px" }}
    >
      <div className="d-flex justify-between" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
        <span className="text-muted">Syncing from the Flow Blockchain: <strong>{state.stage}</strong></span>
        <span>{state.progressPercent}%</span>
      </div>
      <div className="sync-bar-container">
        <div className="sync-bar-fill" style={{ width: `${state.progressPercent}%` }}></div>
      </div>
    </div>
  );
}
