import { useEffect, useState } from "react";
import teamsData from "../../data/additions/teams.json";
import uiEmojis from "./ui-emojis.json";
import catalog from "./emoji-catalog.json";
import twemojiUrl from "./fonts/TwemojiMozilla.ttf?url";
import openmojiColorUrl from "./fonts/OpenMoji-color-colr0_svg.woff2?url";
import openmojiBlackUrl from "./fonts/OpenMoji-black-glyf.woff2?url";

// Dev-only emoji family comparison lab. Route is registered only when
// import.meta.env.DEV is true, so this module, its JSON manifest and the
// bundled test fonts are all tree-shaken out of production builds.

const GOOGLE_EMOJI_CSS =
  "https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&family=Noto+Emoji:wght@500&display=swap";

const FAMILIES = [
  { key: "notoColor", label: "Noto Color Emoji", stack: "'Noto Color Emoji', sans-serif", note: "Google/Android style; what the app ships (as a self-hosted subset). Webfont from Google Fonts (COLRv1: Chrome/Edge/Firefox yes, Safari no)." },
  { key: "twemoji", label: "Twemoji (Mozilla)", stack: "'Twemoji Test', sans-serif", note: "Flat Twitter style, COLRv0 (all modern browsers); the shipped family's Safari lane. Bundled locally." },
  { key: "openColor", label: "OpenMoji Color", stack: "'OpenMoji Color Test', sans-serif", note: "Hand-drawn open-source set, COLRv0. Bundled locally." },
  { key: "system", label: "System (Segoe)", stack: "'Segoe UI Emoji', 'Apple Color Emoji', sans-serif", note: "Whatever the viewer's OS provides. Varies by machine." },
  { key: "notoMono", label: "Noto Emoji (mono)", stack: "'Noto Emoji', sans-serif", note: "Monochrome outline set, renders in text color. Webfont from Google Fonts." },
  { key: "openBlack", label: "OpenMoji Black", stack: "'OpenMoji Black Test', sans-serif", note: "Outline edition of OpenMoji, renders in text color. Bundled locally." }
];

const ORDER_STORAGE_KEY = "emojiLabColumnOrder";

// Which column is being dragged; transient interaction state, never rendered
const dragState = { key: null };

function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY));
    if (Array.isArray(saved)) {
      const valid = saved.filter((k) => FAMILIES.some((f) => f.key === k));
      const missing = FAMILIES.map((f) => f.key).filter((k) => !valid.includes(k));
      return [...valid, ...missing];
    }
  } catch { /* fresh browser or malformed storage: use default order */ }
  return FAMILIES.map((f) => f.key);
}

function collectTeams() {
  const byEmoji = new Map();
  Object.entries(teamsData).forEach(([id, t]) => {
    if (!t || !t.emoji) return;
    const name = t.name || t.teamName || t.team || `#${id}`;
    if (!byEmoji.has(t.emoji)) byEmoji.set(t.emoji, []);
    byEmoji.get(t.emoji).push(name);
  });
  return Array.from(byEmoji.entries()).map(([emoji, names]) => ({
    e: emoji,
    label: names.slice(0, 3).join(", ") + (names.length > 3 ? ` (+${names.length - 3})` : "")
  }));
}

export default function EmojiLab() {
  const [fontsReady, setFontsReady] = useState(false);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState(loadOrder);
  const [dropTarget, setDropTarget] = useState(null);
  const teams = collectTeams();

  const families = order
    .map((k) => FAMILIES.find((f) => f.key === k))
    .filter(Boolean);

  const moveColumn = (fromKey, toKey) => {
    if (!fromKey || fromKey === toKey) return;
    setOrder((prev) => {
      const next = prev.filter((k) => k !== fromKey);
      next.splice(next.indexOf(toKey), 0, fromKey);
      try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Search the full Unicode catalog (~1800 entries) for candidates the app
  // does NOT use yet. Matches by name substring, or renders pasted emoji
  // directly. Emoji already in use are labelled as such.
  const usedSet = new Set([
    ...teams.map((t) => t.e),
    ...uiEmojis.map((u) => u.e)
  ]);
  const trimmed = query.trim();
  let searchRows = [];
  if (trimmed) {
    const q = trimmed.toLowerCase();
    const pasted = trimmed.codePointAt(0) > 0xff
      ? [{ e: trimmed, n: "(pasted)" }]
      : [];
    searchRows = [
      ...pasted,
      ...catalog.filter((c) => c.n.toLowerCase().includes(q))
    ].slice(0, 48).map((c) => ({
      e: c.e,
      label: `${c.n}${usedSet.has(c.e) ? " · ALREADY IN USE" : ""}`
    }));
  }

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = GOOGLE_EMOJI_CSS;
    document.head.appendChild(link);
    // Report when the test fonts have actually arrived, so a cell that looks
    // identical to System is a real result, not a font still in flight
    const ready = document.fonts && document.fonts.ready
      ? document.fonts.ready
      : Promise.resolve();
    ready.then(() => setFontsReady(true));
    return () => document.head.removeChild(link);
  }, []);

  const renderSection = (title, rows, labelHeader) => (
    <div className="glass-panel" style={{ marginTop: "20px", padding: "24px" }}>
      <h3>{title}</h3>
      <div style={{ overflowX: "auto", marginTop: "16px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>{labelHeader}</th>
              {families.map((f) => (
                <th
                  key={f.key}
                  title={`${f.note} — drag to reorder`}
                  draggable
                  onDragStart={() => { dragState.key = f.key; }}
                  onDragOver={(e) => { e.preventDefault(); setDropTarget(f.key); }}
                  onDragLeave={() => setDropTarget((t) => (t === f.key ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault();
                    moveColumn(dragState.key, f.key);
                    dragState.key = null;
                    setDropTarget(null);
                  }}
                  onDragEnd={() => { dragState.key = null; setDropTarget(null); }}
                  style={{
                    ...thStyle,
                    textAlign: "center",
                    cursor: "grab",
                    borderLeft: dropTarget === f.key
                      ? "2px solid var(--primary)"
                      : "2px solid transparent"
                  }}
                >
                  <span style={{ opacity: 0.4, marginRight: "5px" }}>⠿</span>
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.e + row.label}>
                <td style={{ ...tdStyle, color: "var(--text-muted)", fontSize: "0.8rem", maxWidth: "220px" }}>
                  <span style={{ color: "#fff", fontSize: "0.9rem" }}>{row.label}</span>
                </td>
                {families.map((f) => (
                  <td key={f.key} style={{ ...tdStyle, textAlign: "center" }}>
                    <span style={{ fontFamily: f.stack, fontSize: "1.9rem", lineHeight: 1 }}>{row.e}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
      <style>{`
        @font-face {
          font-family: 'Twemoji Test';
          src: url('${twemojiUrl}') format('truetype');
        }
        @font-face {
          font-family: 'OpenMoji Color Test';
          src: url('${openmojiColorUrl}') format('woff2');
        }
        @font-face {
          font-family: 'OpenMoji Black Test';
          src: url('${openmojiBlackUrl}') format('woff2');
        }
      `}</style>

      <div className="glass-panel" style={{ padding: "24px" }}>
        <h2>🧪 Emoji Family Lab (dev only)</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.9rem" }}>
          Every emoji the app uses, rendered in each candidate family. Drag column headers to
          reorder for side-by-side comparison (order is remembered). Test fonts:{" "}
          <strong style={{ color: fontsReady ? "var(--status-success)" : "var(--status-mismint)" }}>
            {fontsReady ? "loaded" : "still loading..."}
          </strong>
        </p>
        <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
          Reading results: a cell identical to the System column may mean the family lacks that glyph
          and the browser silently fell back, check the newest emoji (🪄 🦖 🪽) and the text-style
          pictographs (⚔️ ⚜️ ⚙️) first, since those are where families differ most.
        </p>
        <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
          Shipped today: a self-hosted Noto Color Emoji subset, with a Twemoji COLRv0 subset as the
          Safari lane (both in <code>public/fonts/</code>). When new emoji are added to the app,
          regenerate the subsets or those glyphs silently fall back to system rendering.
        </p>
        <p className="text-muted mt-8" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
          {navigator.userAgent}
        </p>
      </div>

      <div className="glass-panel" style={{ marginTop: "20px", padding: "24px" }}>
        <h3>🔎 Candidate Search</h3>
        <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
          Search the full Unicode emoji catalog ({catalog.length.toLocaleString()} entries) by name
          (try "lynx", "wave", "hat"), or paste an emoji directly. First 48 matches shown.
        </p>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search names, e.g. "cat", "storm", "ball"...'
          style={{
            marginTop: "12px", width: "100%", maxWidth: "420px", padding: "10px 14px",
            background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "8px", color: "#fff", fontSize: "0.95rem", outline: "none"
          }}
        />
      </div>
      {searchRows.length > 0 && renderSection(`Results (${searchRows.length})`, searchRows, "Name")}

      {renderSection(`🛡️ Team Emojis (${teams.length})`, teams, "Team(s)")}
      {renderSection(
        `🎛️ UI Emojis (${uiEmojis.length})`,
        uiEmojis.map((u) => ({ e: u.e, label: `${u.e} · ${u.files.join(", ")}` })),
        "Emoji · used in"
      )}
    </div>
  );
}

const thStyle = {
  padding: "10px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  color: "var(--text-muted)",
  fontSize: "0.8rem",
  textAlign: "left",
  whiteSpace: "nowrap"
};
const tdStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.04)"
};
