import { useState, useEffect, useRef } from "react";

/**
 * Compact multi-select for facet filter bars: a chip button opening a
 * checklist (purple tint while active, outside-click closes). Values are
 * strings; an empty selection means "everything". Long option lists get
 * a search box. Shared by the account page and the offers page.
 */
export function MultiSelect({ label, values, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  // Long lists (players, teams) get a search box; short ones stay plain
  const searchable = options.length > 15;
  const q = query.trim().toLowerCase();
  const shown = searchable && q ? options.filter(([, text]) => String(text).toLowerCase().includes(q)) : options;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
        style={{
          padding: "3px 8px", fontSize: "0.82rem", background: values.length ? "rgba(139, 92, 246, 0.15)" : "rgba(255,255,255,0.05)",
          border: `1px solid ${values.length ? "rgba(139, 92, 246, 0.5)" : "rgba(255,255,255,0.15)"}`,
          color: values.length ? "var(--primary-hover)" : "#fff", borderRadius: "4px", cursor: "pointer", whiteSpace: "nowrap"
        }}
      >
        {label}{values.length > 0 ? ` (${values.length})` : ""} ▾
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40,
          background: "#17141f", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "6px",
          padding: "6px 8px", maxHeight: "280px", overflowY: "auto", minWidth: "190px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
        }}>
          {values.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{ background: "none", border: "none", color: "var(--primary-hover)", cursor: "pointer", fontSize: "0.75rem", padding: "2px 0 6px", display: "block" }}
            >
              ✕ Clear selection
            </button>
          )}
          {searchable && (
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              style={{
                width: "100%", boxSizing: "border-box", marginBottom: "6px", padding: "3px 6px",
                fontSize: "0.78rem", background: "rgba(255,255,255,0.06)", color: "#fff",
                border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px"
              }}
            />
          )}
          {shown.map(([val, text]) => (
            <label key={val} style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "0.8rem", padding: "3px 2px", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={values.includes(val)}
                onChange={(e) => onChange(e.target.checked ? [...values, val] : values.filter((v) => v !== val))}
                style={{ cursor: "pointer", accentColor: "var(--primary)" }}
              />
              {text}
            </label>
          ))}
          {shown.length === 0 && <div className="text-muted" style={{ fontSize: "0.75rem" }}>{options.length === 0 ? "No options under the current filters" : "No matches"}</div>}
        </div>
      )}
    </span>
  );
}
