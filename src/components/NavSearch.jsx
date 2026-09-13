import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { loadSearchIndex, searchIndex, resetSearchIndex } from "../services/search.service";
import { useReloadOnSyncComplete } from "../hooks/useSyncStatus";

const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};

/**
 * Quick search in the navbar: closed, one magnifying glass; open, a box
 * across the bar with the matches under it. Type a name (player, team,
 * set, arena) or an id (play, set, edition) and each match says what it
 * is and opens its page. Enter opens the highlighted match, the arrows
 * move the highlight, Escape closes; "/" anywhere on a page opens it.
 * open/onOpen/onClose live in the navbar (the open box follows the same
 * closes-on-navigation rule as Look up).
 */
export function NavSearch({ open, onOpen, onClose }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState(false);
  const [active, setActive] = useState(0);
  const [listOpen, setListOpen] = useState(false);

  // The index is built on first open and reused; a finished sync pass
  // rebuilds it on the next open, so new plays and sets are searchable
  useEffect(() => {
    if (!open || index) return undefined;
    let live = true;
    loadSearchIndex()
      .then((idx) => { if (live) setIndex(idx); })
      .catch(() => { if (live) setIndexError(true); });
    return () => { live = false; };
  }, [open, index]);
  useReloadOnSyncComplete(() => { resetSearchIndex(); setIndex(null); });

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && !open && !isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpen]);

  const shown = useMemo(() => searchIndex(index, query), [index, query]);
  const current = Math.min(active, Math.max(0, shown.length - 1));

  const go = useCallback((r) => {
    if (!r) return;
    setQuery("");
    setListOpen(false);
    onClose();
    navigate(r.href);
  }, [onClose, navigate]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setListOpen(true); setActive(Math.min(current + 1, shown.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(current - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); go(shown[current]); }
  };

  if (!open) {
    return (
      <div className="nav-search-wrap">
        <button type="button" className="nav-search-open-btn" onClick={onOpen} title="Search players, teams, sets and arenas (/)" aria-label="Search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
          </svg>
        </button>
      </div>
    );
  }

  const trimmed = query.trim();
  let note = null;
  if (trimmed) {
    if (indexError) note = "Search is not available right now.";
    else if (!index) note = "Loading...";
    else if (index.entries.length === 0) note = "Nothing to search yet: the database is still syncing.";
    else if (shown.length === 0) note = "No player, team, set, arena or id matches that.";
  }

  return (
    <form
      className="nav-search-wrap nav-dropdown-wrapper open"
      onSubmit={(e) => { e.preventDefault(); go(shown[current]); }}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setListOpen(false); }}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Player, team, set, arena or id"
        className="form-control nav-search-input"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setListOpen(true); }}
        onFocus={() => setListOpen(true)}
        autoComplete="off"
        spellCheck={false}
        aria-label="Search"
      />
      <button type="button" className="nav-lookup-close" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
      {listOpen && trimmed && (
        <div className="nav-dropdown-menu nav-recent-menu nav-search-menu" tabIndex={-1} role="listbox">
          {note ? (
            <div className="nav-account-menu-note" style={{ paddingTop: "8px" }}>{note}</div>
          ) : shown.map((r, i) => (
            <button
              key={`${r.kind}:${r.href}`}
              type="button"
              role="option"
              aria-selected={i === current}
              className={`dropdown-item nav-search-result${i === current ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              title={`Open the ${r.kind.toLowerCase()} page`}
            >
              <span className="nav-search-kind">{r.kind}</span>
              <span className="nav-search-name">{r.name}</span>
              {r.detail && <span className="nav-search-detail">{r.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
