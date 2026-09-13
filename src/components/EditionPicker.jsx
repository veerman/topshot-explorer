import { useEffect, useMemo, useState } from "react";
import { useFacetFilters, cascadeOf, writeFilters } from "../hooks/useFacetFilters";
import { toQuery } from "../utils/query";
import { MultiSelect } from "./MultiSelect";

/**
 * Filter down to one edition: the facet row (player, team, set, series,
 * tier, play type, year) and the list of matches, one selected. Cube Lab
 * had this first; the Frame Annotator uses the same picker to reach an
 * edition's videos. The facets and the chosen edition ride in the URL
 * (replaceState, beside whatever else the page keeps there).
 *
 * `editions` come from buildEditionList: every edition with registered
 * media, newest play first, with the facts the facets need.
 */
const EMPTY_FILTERS = { player: [], team: [], set: [], series: [], tier: [], type: [], year: [] };
const FACET_KEYS = Object.keys(EMPTY_FILTERS);
const FACET_LABELS = { player: "Player", team: "Team", set: "Set", series: "Series", tier: "Tier", type: "Play type", year: "Year" };
const TIERS = ["common", "fandom", "rare", "legendary", "ultimate"];
const MAX_LISTED = 80;

/** Every edition with registered media, newest play first (the identity
 *  context `names` is buildIdentityContext(plays, sets)) */
export function buildEditionList(ipfsRecords, names) {
  const out = [];
  ipfsRecords.forEach((rec) => {
    const setID = Number(rec.setID), playID = Number(rec.playID);
    const f = names.factsOf(setID, playID);
    if (!f.play || f.mismint) return;
    out.push({
      key: `${setID}_${playID}`,
      setID, playID,
      cids: rec.cids,
      play: f.play,
      setName: f.setName,
      series: f.series,
      player: f.player,
      team: f.team,
      tier: (f.tier || "").toLowerCase(),
      ptype: f.ptype,
      year: f.year
    });
  });
  out.sort((a, b) => b.playID - a.playID || a.setID - b.setID);
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line under a row: set, play type, year, tier */
export const editionSubtitle = (e) => [e.setName, e.ptype, e.year, e.tier ? cap(e.tier) : ""].filter(Boolean).join(" · ");

/**
 * The picker's state and its two panels. Returns { filters, list } as
 * elements to place, `selected` (the chosen match, or the first match so
 * the page is never empty), `matched`, and `setSelectedKey`.
 */
export function useEditionPicker(editions, { urlParam = "edition" } = {}) {
  const { filters, setFilter, clearFilters, anyFilter } = useFacetFilters(EMPTY_FILTERS);
  const [selectedKey, setSelectedKey] = useState(() => new URLSearchParams(window.location.search).get(urlParam) || "");

  const facetData = useMemo(() => {
    const opts = Object.fromEntries(FACET_KEYS.map((k) => [k, new Set()]));
    const matched = [];
    const multi = (key) => (v) => filters[key].length === 0 || (Boolean(v) && filters[key].includes(v));
    editions.forEach((e) => {
      const f = { player: e.player, team: e.team, set: e.setName, series: e.series != null ? String(e.series) : "", tier: e.tier, type: e.ptype, year: e.year };
      const pass = Object.fromEntries(FACET_KEYS.map((k) => [k, multi(k)(f[k])]));
      const { matched: ok, offer } = cascadeOf(pass, FACET_KEYS);
      if (ok) matched.push(e);
      FACET_KEYS.forEach((k) => { if (offer(k) && f[k]) opts[k].add(f[k]); });
    });
    return { opts, matched };
  }, [editions, filters]);

  // The selection, or the first match when none (or one that fell out
  // of the matches), so the page always has an edition to show
  const selected = useMemo(() => {
    const hit = selectedKey ? facetData.matched.find((e) => e.key === selectedKey) : null;
    return hit || facetData.matched[0] || null;
  }, [facetData, selectedKey]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    FACET_KEYS.forEach((k) => params.delete(k));
    params.delete(urlParam);
    writeFilters(params, filters, EMPTY_FILTERS);
    if (selected) params.set(urlParam, selected.key);
    const qs = toQuery(params);
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [filters, selected, urlParam]);

  const alpha = (a, b) => a.localeCompare(b);
  const numeric = (a, b) => Number(a) - Number(b);
  const options = (key) => {
    const vals = [...facetData.opts[key]];
    if (key === "series" || key === "year") vals.sort(numeric);
    else if (key === "tier") vals.sort((a, b) => TIERS.indexOf(a) - TIERS.indexOf(b));
    else vals.sort(alpha);
    return vals.map((v) => [v, key === "tier" ? cap(v) : key === "series" ? `Series ${v}` : v]);
  };

  const filtersEl = (
    <div className="glass-panel edition-picker-filters">
      {FACET_KEYS.map((k) => {
        const opts = options(k);
        return (opts.length > 1 || filters[k].length > 0)
          ? <MultiSelect key={k} label={FACET_LABELS[k]} values={filters[k]} options={opts} onChange={(vals) => setFilter(k, vals)} />
          : null;
      })}
      {anyFilter && (
        <button type="button" className="edition-picker-clear" onClick={clearFilters}>Clear ✖</button>
      )}
      <span className="text-muted edition-picker-count">
        {facetData.matched.length.toLocaleString()} of {editions.length.toLocaleString()} editions
      </span>
    </div>
  );

  const listEl = (
    <div className="glass-panel edition-picker-list">
      {facetData.matched.slice(0, MAX_LISTED).map((e) => (
        <button
          type="button"
          key={e.key}
          className={`edition-picker-row${selected && selected.key === e.key ? " is-selected" : ""}`}
          onClick={() => setSelectedKey(e.key)}
          aria-pressed={selected && selected.key === e.key ? "true" : "false"}
        >
          <span className="edition-picker-row-main">{e.player || "Team moment"}</span>
          <span className="edition-picker-row-sub text-muted">{editionSubtitle(e)}</span>
          <span className="edition-picker-row-id font-mono text-muted">{e.key}</span>
        </button>
      ))}
      {facetData.matched.length === 0 && (
        <p className="text-muted edition-picker-more">No edition matches those filters.</p>
      )}
      {facetData.matched.length > MAX_LISTED && (
        <p className="text-muted edition-picker-more">First {MAX_LISTED} shown; narrow the filters for the rest.</p>
      )}
      {PICKER_STYLES}
    </div>
  );

  return { filters: filtersEl, list: listEl, selected, matched: facetData.matched, setSelectedKey };
}

// A plain element, not a component, so the file stays hook-and-helper only
const PICKER_STYLES = (
    <style>{`
      .edition-picker-filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 10px;
        padding: 12px 16px;
      }
      .edition-picker-clear {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #fff;
        border-radius: 8px;
        padding: 4px 10px;
        font: inherit;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .edition-picker-clear:hover {
        border-color: var(--primary);
      }
      .edition-picker-count {
        margin-left: auto;
        font-size: 0.82rem;
        white-space: nowrap;
      }
      .edition-picker-list {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 80vh;
        overflow-y: auto;
      }
      .edition-picker-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-rows: auto auto;
        gap: 0 8px;
        text-align: left;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 6px 10px;
        color: #fff;
        cursor: pointer;
        font: inherit;
      }
      .edition-picker-row:hover {
        background: rgba(139, 92, 246, 0.08);
      }
      /* The chosen row: outlined box plus a leading marker, never colour alone */
      .edition-picker-row.is-selected {
        border-color: var(--primary);
        background: rgba(139, 92, 246, 0.12);
      }
      .edition-picker-row.is-selected .edition-picker-row-main::before {
        content: "▶ ";
      }
      .edition-picker-row-main {
        font-weight: 600;
        font-size: 0.9rem;
        overflow-wrap: anywhere;
      }
      .edition-picker-row-id {
        grid-row: 1 / span 2;
        grid-column: 2;
        align-self: center;
        font-size: 0.72rem;
      }
      .edition-picker-row-sub {
        font-size: 0.76rem;
        overflow-wrap: anywhere;
      }
      .edition-picker-more {
        font-size: 0.78rem;
        padding: 8px 10px;
        margin: 0;
      }
    `}</style>
);
