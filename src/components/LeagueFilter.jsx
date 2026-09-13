/**
 * Segmented league filter control (same look as the Players page control).
 * options: [{ value, label, count?, title? }]; count, when given, renders in
 * the label. `children` render in the same row after the buttons, for pages
 * that add further filters (the Players page honors) without stacking a
 * second bordered bar.
 */
export function LeagueFilter({ options, selected, onSelect, children }) {
  return (
    <div className="d-flex align-center gap-15 mb-20 flex-wrap" style={{ paddingBottom: "16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      <span className="text-muted" style={{ fontSize: "0.9rem", fontWeight: "600" }}>Filter League:</span>
      <div style={{ display: "flex", gap: "6px", background: "rgba(0,0,0,0.2)", padding: "4px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)", flexWrap: "wrap" }}>
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            title={opt.title}
            style={{
              padding: "6px 16px",
              borderRadius: "6px",
              border: "none",
              background: selected === opt.value ? "var(--primary)" : "transparent",
              color: "#fff",
              cursor: "pointer",
              fontWeight: "600",
              fontSize: "0.85rem",
              transition: "all 0.2s",
              whiteSpace: "nowrap"
            }}
          >
            {opt.label}{opt.count !== undefined ? ` (${opt.count})` : ""}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
