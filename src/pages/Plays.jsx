import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { getAllPlaysDB, getAllSetsDB, getAllTeamsDB } from "../services/db.service";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";
import { useLoad } from "../hooks/useLoad";
import { LoadError } from "../components/LoadError";

import { buildTsdIndex, buildMintClock, momentContext, parentSeason, compareBadges, getSeriesInfo, mintEra, MINT_ERAS } from "../services/overrides.service";
import { useUrlParam } from "../hooks/useUrlParam";
import { buildTeamNameMap, getLeagueName, buildSeriesSeasonMap } from "../utils/display.utils";
import playsExclude from "../../data/plays_exclude.json";
import { LeagueFilter } from "../components/LeagueFilter";
import { MultiSelect } from "../components/MultiSelect";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { useFacetFilters, writeFilters, cascadeOf } from "../hooks/useFacetFilters";
import { toQuery, replaceQuery } from "../utils/query";
import { playTableColumns, buildPlayRecord, buildPlayToSets } from "../components/PlayTable";

// The tag-consistency audit lives on the Corrections page (Open Findings tab),
// backed by detectTagMismatches in audit.service.js.

// Badge names in the ?badge= deep link compare with spaces and punctuation
// ignored, so "rookie-mint" and "Rookie Mint" are the same badge
const normBadge = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Facet filters, the play-level subset of the account page's bar (no
// series/set/tier/serial facets here: a play is not an edition). Each
// rides in the URL under its key, comma-joined, in the account page's
// format; ?badge= doubles as the home page's deep link.
const EMPTY_FILTERS = { type: [], year: [], player: [], team: [], badge: [] };
const FACET_KEYS = Object.keys(EMPTY_FILTERS);
// The facet values of one table record (the account page's playFacts)
const factsOf = (rec) => ({
  type: (rec.PlayCategory || rec.PlayType || "").trim(),
  year: rec.DateOfMoment ? String(rec.DateOfMoment).slice(0, 4) : "",
  player: (rec.FullName || "").trim(),
  team: (rec.TeamAtMoment || "").trim()
});

export function Plays() {
  const [plays, setPlays] = useState([]);
  const [playToSets, setPlayToSets] = useState({});
  const syncState = useSyncStatus();
  const [teamNameMap, setTeamNameMap] = useState({});
  const [loadError, setLoadError] = useState("");
  const owned = useAccountCollection();

  // 3. Load Plays from IndexedDB. Reload once whenever a sync pass finishes.
  const loadPlays = async () => {
      try {
        const [records, sets, allTeams] = await Promise.all([
          getAllPlaysDB(),
          getAllSetsDB(),
          getAllTeamsDB()
        ]);
        setPlays(records);

        setPlayToSets(buildPlayToSets(sets));

        setTeamNameMap(buildTeamNameMap(allTeams));
        setLoadError("");
      } catch (err) {
        console.error("Failed to load plays/sets from IndexedDB:", err);
        setLoadError("Could not read the plays from the local database.");
      }
  };

  useLoad(loadPlays, []);
  useReloadOnSyncComplete(loadPlays);

  // 4. Columns: the shared one-row-per-play table (PlayTable)
  const columns = useMemo(() => playTableColumns({ teamNameMap, owned }), [teamNameMap, owned]);

  // League filter: a play's league comes from its team at moment (non-WNBA
  // teams bucket as NBA, matching the Players/Teams pages)
  // Deep links from the Seasons page: ?league=nba&season=2024-25&context=Playoffs
  // (context = a momentContext label, or "Undated" for plays without one),
  // and from the homepage matrices: ?series=5 (plays that sit in a set of
  // that series) and ?era=season|historical (mintEra)
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const seasonFilter = (searchParams.get("season") || "").trim();
  const contextFilter = (searchParams.get("context") || "").trim();
  const seriesFilter = (searchParams.get("series") || "").trim();
  const eraParam = (searchParams.get("era") || "").trim().toLowerCase();
  const eraFilter = MINT_ERAS.includes(eraParam) ? eraParam : "";
  const ERA_TEXT = { season: "in-season mints", historical: "historical mints" };
  const [selectedLeague, setSelectedLeague] = useUrlParam("league", "all", ["all", "nba", "wnba"]);
  const { filters, setFilter, clearFilters, anyFilter } = useFacetFilters(EMPTY_FILTERS);

  // Facets ride in the URL beside the league tab. Written from the LIVE
  // location (the tab and DataTable write their own params), so nothing
  // is dropped; replaceState keeps Back leaving the page, not the filters.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    FACET_KEYS.forEach((k) => params.delete(k));
    writeFilters(params, filters, EMPTY_FILTERS);
    replaceQuery(params);
  }, [filters]);

  // Debut index and mint clock over ALL plays (not the league-filtered
  // view), so a player's badges never change with the filter
  const tsdIndex = useMemo(() => buildTsdIndex(plays), [plays]);
  const mintClock = useMemo(() => buildMintClock(plays), [plays]);

  const leagueFilteredPlays = useMemo(() => {
    let out = plays;
    if (selectedLeague !== "all") {
      const target = selectedLeague === "nba" ? "NBA" : "WNBA";
      out = out.filter((p) => getLeagueName(p.TeamAtMoment) === target);
    }
    // Summer Leagues file under the season they precede, as on the Seasons page
    if (seasonFilter) out = out.filter((p) => parentSeason(p.NbaSeason) === seasonFilter);
    if (contextFilter) {
      out = out.filter((p) => {
        const ctx = momentContext(p);
        return contextFilter === "Undated" ? !ctx : Boolean(ctx && ctx.context === contextFilter);
      });
    }
    if (seriesFilter) out = out.filter((p) => (playToSets[p.playID] || []).some((s) => String(s.series) === seriesFilter));
    if (eraFilter) out = out.filter((p) => mintEra(p, mintClock) === eraFilter);
    return out;
  }, [plays, playToSets, selectedLeague, seasonFilter, contextFilter, seriesFilter, eraFilter, mintClock]);
  // Drops the season/context/series deep-link filters; the league tab and
  // the facets stay. Built from the live location for the same reason as
  // above.
  const handleClearFilter = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("season");
    params.delete("context");
    params.delete("series");
    params.delete("era");
    const qs = toQuery(params);
    navigate({ pathname: window.location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
  };

  // Majority season per series, for undated plays with no season field
  const seriesSeasonMap = useMemo(() => buildSeriesSeasonMap(plays, playToSets), [plays, playToSets]);

  // 5. Rows, through the shared builder (PlayTable)
  const tableRecords = useMemo(
    () => leagueFilteredPlays.map((meta) => buildPlayRecord(meta, { playToSets, seriesSeasonMap, tsdIndex, mintClock, owned })),
    [leagueFilteredPlays, playToSets, seriesSeasonMap, tsdIndex, mintClock, owned]
  );

  // Badge names in the URL compare with spaces and punctuation ignored
  // ("rookie-mint" from the home page is the "Rookie Mint" badge), so the
  // selected values resolve to the badge's own spelling once plays are in
  const badgeCanon = useMemo(() => {
    const m = new Map();
    tableRecords.forEach((rec) => rec.badges.forEach((t) => m.set(normBadge(t), t)));
    return m;
  }, [tableRecords]);
  useEffect(() => {
    if (badgeCanon.size === 0 || filters.badge.length === 0) return;
    const canon = filters.badge.map((b) => badgeCanon.get(normBadge(b)) || b);
    if (canon.some((b, i) => b !== filters.badge[i])) setFilter("badge", canon);
  }, [badgeCanon, filters.badge, setFilter]);

  const passFns = useMemo(() => {
    const badgeWanted = new Set(filters.badge.map(normBadge));
    const multi = (key) => (v) => filters[key].length === 0 || (Boolean(v) && filters[key].includes(v));
    return {
      type: multi("type"),
      year: multi("year"),
      player: multi("player"),
      team: multi("team"),
      badge: (tags) => badgeWanted.size === 0 || tags.some((t) => badgeWanted.has(normBadge(t)))
    };
  }, [filters]);

  // Options per facet plus the plays matching every filter, under the
  // shared cascade rule (a facet keeps offering its own alternatives)
  const facetData = useMemo(() => {
    const opts = { type: new Set(), year: new Set(), player: new Set(), team: new Set(), badge: new Set() };
    const matched = new Set();
    tableRecords.forEach((rec) => {
      const f = factsOf(rec);
      const pass = { type: passFns.type(f.type), year: passFns.year(f.year), player: passFns.player(f.player), team: passFns.team(f.team), badge: passFns.badge(rec.badges) };
      const { matched: ok, offer } = cascadeOf(pass, FACET_KEYS);
      if (ok) matched.add(rec.playID_raw);
      if (offer("type") && f.type) opts.type.add(f.type);
      if (offer("year") && f.year) opts.year.add(f.year);
      if (offer("player") && f.player) opts.player.add(f.player);
      if (offer("team") && f.team) opts.team.add(f.team);
      if (offer("badge")) rec.badges.forEach((t) => opts.badge.add(t));
    });
    return { opts, matched };
  }, [tableRecords, passFns]);
  const filteredRecords = useMemo(
    () => (anyFilter ? tableRecords.filter((rec) => facetData.matched.has(rec.playID_raw)) : tableRecords),
    [tableRecords, anyFilter, facetData]
  );

  // A facet renders once it has a choice to offer (or holds a selection)
  const msFacet = (label, key, options) => ((options.length > 1 || filters[key].length > 0)
    ? <MultiSelect label={label} values={filters[key]} options={options} onChange={(vals) => setFilter(key, vals)} />
    : null);
  const alpha = (a, b) => a.localeCompare(b);

  return (
    <div className="plays-container">
      {/* Header Panel */}
      <div className="glass-panel info-banner">
        <h2>Plays</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Every play: the player, the game, the date, and its editions.
        </p>

        {/* Only in the empty state; once the table is up, its removal would
            jump the page, and the navbar pill already shows sync status */}
        {syncState.isSyncing && plays.length === 0 && (
          <div style={{ marginTop: "16px" }}>
            <div className="d-flex justify-between" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
              <span className="text-muted">{syncState.stage}</span>
              <span>{syncState.progressPercent}%</span>
            </div>
            <div className="sync-bar-container">
              <div
                className="sync-bar-fill"
                style={{ width: `${syncState.progressPercent}%` }}
              ></div>
            </div>
          </div>
        )}
      </div>

      {/* Plays Datatable */}
      <div className="glass-panel table-panel" style={{ marginTop: "20px" }}>
        {loadError && plays.length === 0 ? (
          <LoadError message={loadError} onRetry={loadPlays} />
        ) : plays.length === 0 ? (
          <div className="loader-container">
            <div className="spinner"></div>
            <p>Database is empty. Waiting for Sync Coordinator to fetch data...</p>
            {syncState.isSyncing && (
              <p className="text-muted" style={{ fontSize: "0.85rem", marginTop: "8px" }}>
                Progress: {syncState.progressPercent}% - {syncState.stage}
              </p>
            )}
          </div>
        ) : (
          <>
            <LeagueFilter
              options={[
                { value: "all", label: "All" },
                { value: "nba", label: "NBA" },
                { value: "wnba", label: "WNBA" }
              ]}
              selected={selectedLeague}
              onSelect={setSelectedLeague}
            >
              {msFacet("Type", "type", [...facetData.opts.type].sort(alpha).map((t) => [t, t]))}
              {msFacet("Year", "year", [...facetData.opts.year].sort().reverse().map((y) => [y, y]))}
              {msFacet("Player", "player", [...facetData.opts.player].sort(alpha).map((p) => [p, p]))}
              {msFacet("Team", "team", [...facetData.opts.team].sort(alpha).map((t) => [t, t]))}
              {msFacet("Badge", "badge", [...facetData.opts.badge].sort(compareBadges).map((b) => [b, b]))}
              {anyFilter && (
                <button
                  className="btn-primary"
                  style={{ padding: "3px 10px", fontSize: "0.8rem", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", boxShadow: "none" }}
                  onClick={clearFilters}
                >
                  ✕ Clear
                </button>
              )}
              {anyFilter && (
                <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                  Filtered from {tableRecords.length.toLocaleString()} plays
                </span>
              )}
            </LeagueFilter>
            {(seasonFilter || contextFilter || seriesFilter || eraFilter) && (
              <div className="plays-filter-indicator">
                <span>
                  Displaying plays for{" "}
                  <strong>{[
                    selectedLeague !== "all" ? selectedLeague.toUpperCase() : "",
                    seriesFilter ? `${(getSeriesInfo(seriesFilter) || {}).name || `Series ${seriesFilter}`} sets` : "",
                    eraFilter ? ERA_TEXT[eraFilter] : "",
                    seasonFilter,
                    contextFilter
                  ].filter(Boolean).join(" · ")}</strong>
                </span>
                <button onClick={handleClearFilter} className="clear-filter-inline">Show All Plays ✖</button>
              </div>
            )}
            {/* Largest table in the app, so it keeps a middle step between 100
                and rendering all ~8.5k rows at once. */}
            <DataTable
              columns={columns}
              ownedFilter={owned ? "Owned" : ""}
              records={filteredRecords}
              keyColumn="playID_raw"
              defaultSortColumn="EditionIDs"
              defaultSortOrder="desc"
              onRowClick={(rec) => navigate(rec._rowTo)}
              pageSizeOptions={[100, 1000, "All"]}
              mismints={playsExclude}
            />
          </>
        )}
      </div>

      <style>{`
        .plays-container {
          width: 100%;
          max-width: 100%;
          margin: 0 auto;
        }
        .plays-filter-indicator {
          background: rgba(139, 92, 246, 0.05);
          border: 1px solid rgba(139, 92, 246, 0.15);
          padding: 12px 18px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          margin-bottom: 20px;
          font-size: 0.95rem;
          color: #fff;
        }
        .plays-filter-indicator .clear-filter-inline {
          background: transparent;
          border: 1px solid rgba(139, 92, 246, 0.4);
          color: var(--primary-hover);
          padding: 6px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.85rem;
        }
        .plays-filter-indicator .clear-filter-inline:hover {
          background: rgba(139, 92, 246, 0.15);
        }
        .sync-banner {
          background: linear-gradient(135deg, rgba(139, 92, 246, 0.05) 0%, rgba(59, 130, 246, 0.05) 100%);
        }
        .team-at-moment {
          font-weight: 700;
        }
        .winner-highlight {
          border: 1px solid rgba(16, 185, 129, 0.25);
          background: rgba(16, 185, 129, 0.08);
          padding: 2px 8px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          color: #34d399;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
