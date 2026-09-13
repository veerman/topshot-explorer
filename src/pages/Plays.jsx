import React, { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { getAllPlaysDB, getAllSetsDB, getAllTeamsDB } from "../services/db.service";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";
import { useLoad } from "../hooks/useLoad";
import { LoadError } from "../components/LoadError";

import { parseMomentDate, buildTsdIndex, buildMintClock, getCalculatedPlayTags, momentContext, parentSeason, isMismintPlay, withTags, playEditionTags, playRewardEditions, badgeDef, compareBadges, getSeriesInfo, mintEra, MINT_ERAS } from "../services/overrides.service";
import { useUrlParam } from "../hooks/useUrlParam";
import { buildTeamNameMap, scrubSentinels, blankZeroedFields, buildMatchupSides, renderMatchupCell, getLeagueName, formatDateISO, buildSeriesSeasonMap, seasonHintForPlay, getSeasonFallback, renderSeasonChip, playerPath } from "../utils/display.utils";
import playsExclude from "../../data/plays_exclude.json";
import { LeagueFilter } from "../components/LeagueFilter";
import { Badges } from "../components/Badges";
import { MultiSelect } from "../components/MultiSelect";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { useFacetFilters, writeFilters, cascadeOf } from "../hooks/useFacetFilters";
import { playHasCommentary, withCommentary } from "../services/commentary.service";
import { toQuery } from "../utils/query";

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
  const accountMode = Boolean(owned);

  // 3. Load Plays from IndexedDB. Reload once whenever a sync pass finishes.
  const loadPlays = async () => {
      try {
        const [records, sets, allTeams] = await Promise.all([
          getAllPlaysDB(),
          getAllSetsDB(),
          getAllTeamsDB()
        ]);
        setPlays(records);

        // Build playID -> [setID] mapping from the offline sets store
        const mapping = {};
        sets.forEach((set) => {
          if (set.playIDs) {
            set.playIDs.forEach((playID) => {
              if (!mapping[playID]) mapping[playID] = [];
              mapping[playID].push({
                id: set.id,
                name: set.setName,
                series: set.series,
                locked: set.locked
              });
            });
          }
        });
        setPlayToSets(mapping);

        setTeamNameMap(buildTeamNameMap(allTeams));
        setLoadError("");
      } catch (err) {
        console.error("Failed to load plays/sets from IndexedDB:", err);
        setLoadError("Could not read the plays from the local database.");
      }
  };

  useLoad(loadPlays, []);
  useReloadOnSyncComplete(loadPlays);

  // 4. Columns Definition (Simplified to exactly 9 fields, in specified order)
  const columns = useMemo(() => {
    return [
      // Only while browsing as an account: how many of this play's moments
      // the address owns, across every set and parallel
      ...(owned ? [{
        key: "Owned",
        text: "Owned",
        align: "right",
        sortValue: (_val, rec) => rec.Owned,
        render: (val) => (val > 0
          ? <span className="font-mono" style={{ color: "#fff", fontWeight: 600 }}>{Number(val).toLocaleString()}</span>
          : <span className="text-muted">·</span>)
      }] : []),
      {
        key: "playID",
        text: "Play ID",
        sortValue: (val, rec) => rec.playID_raw,
        render: (val) => (
          <Link to={`/plays/${val}`} className="font-mono team-id-badge" style={{ display: "inline-block" }}>
            {val}
          </Link>
        )
      },
      {
        key: "SetIDs",
        text: "Set IDs",
        sortValue: (val, rec) => rec.matchingSets?.[0]?.id || 0,
        // A plain-number filter matches ANY of the play's set IDs exactly
        filterValue: (val, rec) => (rec.matchingSets || []).map((s) => Number(s.id)),
        render: (val, rec) => {
          const matchingSets = rec.matchingSets || [];
          if (matchingSets.length === 0) return <span className="text-muted">-</span>;

          // Split matching sets into chunks of 3 per line
          const chunks = [];
          for (let i = 0; i < matchingSets.length; i += 3) {
            chunks.push(matchingSets.slice(i, i + 3));
          }

          return (
            <div className="set-links-cell" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {chunks.map((chunk, cIdx) => (
                <div key={cIdx} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                  {chunk.map((s, idx) => {
                    // A reward badge belongs to ONE edition, not the play:
                    // its glyph marks that set id
                    const reward = rec.rewardBySet && rec.rewardBySet[s.id];
                    return (
                      <React.Fragment key={s.id}>
                        {idx > 0 && ", "}
                        <Link to={`/editions/${s.id}_${rec.playID}`} className="set-link" title={`Edition ${s.id}_${rec.playID}: ${s.name} (Series ${s.series})${reward ? `; ${reward.join(", ")}` : ""}`}>
                          {s.id}
                        </Link>
                        {reward && (
                          <span className="set-link-mark" title={`Edition ${s.id}_${rec.playID}: ${reward.join(", ")}`}>
                            {reward.map((t) => (badgeDef(t) || {}).emoji || "").join("")}
                          </span>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        }
      },
      {
        key: "FullName",
        text: "Player Name",
        render: (val, rec) => {
          // A team moment is named after its team and links to the team page
          const playerName = val && val.trim() !== "" ? val.trim() : "";
          const teamName = rec.TeamAtMoment && rec.TeamAtMoment.trim() !== "" ? rec.TeamAtMoment.trim() : "";
          const displayName = playerName || teamName || "Team Moment";
          const teamId = !playerName && teamName ? teamNameMap[teamName.toLowerCase()] : null;
          const target = playerName
            ? playerPath(playerName)
            : (teamId ? `/teams/${teamId}` : null);
          const inner = (
            <>
              {displayName}
              {rec.isMismint && <span className="mini-badge-mismint" title="This play is a mismint!">Mismint ⚠️</span>}
            </>
          );
          const nameEl = target ? (
            <Link to={target} className="player-detail-link font-hover-glow">{inner}</Link>
          ) : (
            <span className="player-detail-link">{inner}</span>
          );
          // Badges sit on their own line directly under the name; a reward
          // badge's hover names the edition that earned it
          return (
            <div className="name-cell">
              {nameEl}
              <Badges tags={rec.badges} titles={rec.badgeTitles} />
            </div>
          );
        }
      },
      {
        key: "PlayCategory",
        text: "Category"
      },
      {
        key: "DateOfMomentLocal",
        text: "Date",
        // Undated plays sort on their synthetic end-of-season instant, so
        // they file in at the tail of their season instead of clumping at
        // the top or bottom
        sortValue: (val, rec) => rec.DateOfMoment || (rec.seasonFallback ? rec.seasonFallback.sortDate : ""),
        render: (val, rec) => {
          if (!rec.DateOfMoment) {
            return rec.seasonFallback ? renderSeasonChip(rec.seasonFallback) : "-";
          }
          const dObj = parseMomentDate(rec.DateOfMoment);
          if (!dObj) return rec.DateOfMoment;
          // Calendar keys come from the stored Eastern-time date string so
          // they always match the calendar page grouping
          const dateMatch = String(rec.DateOfMoment).match(/^(\d{4})-(\d{2})-(\d{2})/);
          const dateKey = dateMatch
            ? `${dateMatch[2]}-${dateMatch[3]}`
            : `${String(dObj.getMonth() + 1).padStart(2, "0")}-${String(dObj.getDate()).padStart(2, "0")}`;

          const dateStr = formatDateISO(dObj);

          return (
            <Link to={`/calendar/${dateKey}`} className="date-calendar-link font-hover-glow" style={{ textDecoration: "none" }}>
              <span style={{ display: "none" }}>{rec.DateOfMoment}</span>
              <span style={{ fontWeight: "600" }}>{dateStr}</span>
            </Link>
          );
        }
      },
      {
        // Stacked box-score cell (away on top, home below, US convention).
        // rec.matchup holds a plain-text version so search/filters still
        // match team names and scores.
        key: "matchup",
        align: "center",
        text: "Matchup",
        sortValue: (val, rec) => rec.AwayTeamName || "",
        render: (val, rec) => renderMatchupCell(buildMatchupSides(rec, teamNameMap))
      }
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamNameMap, accountMode]);

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
    const qs = toQuery(params);
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
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

  // 5. Normalization & Row Formatting (Extremely fast, returning lightweight JSON objects)
  const tableRecords = useMemo(() => {
    return leagueFilteredPlays.map((meta) => {
      const playID = meta.playID;
      const isMismint = isMismintPlay(playID);

      // Normalization fixes
      const metadata = blankZeroedFields(
        scrubSentinels(meta),
        ["HomeTeamScore", "AwayTeamScore", "DraftYear", "Weight"]
      );

      if (metadata.Birthplace) {
        metadata.Birthplace = metadata.Birthplace.split(",")
          .map((item) => item.trim())
          .filter((item) => item)
          .join(", ");
      }

      // Plain-text mirror of the stacked matchup cell so search and the
      // per-column filter can match team names and scores
      const matchup = [metadata.AwayTeamName, metadata.AwayTeamScore, metadata.HomeTeamName, metadata.HomeTeamScore]
        .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
        .join(" ");

      const matchingSets = playToSets[playID] || [];

      // Format local moment date display string (for search)
      let DateOfMomentLocal = "";
      let seasonFallback = null;
      if (metadata.DateOfMoment) {
        const dObj = parseMomentDate(metadata.DateOfMoment);
        if (dObj) {
          DateOfMomentLocal = formatDateISO(dObj);
        } else {
          DateOfMomentLocal = metadata.DateOfMoment;
        }
      } else {
        seasonFallback = getSeasonFallback(metadata, seasonHintForPlay(metadata, matchingSets, seriesSeasonMap));
        // Searchable text for the chip ("2022-23 season" matches searches)
        if (seasonFallback) DateOfMomentLocal = `${seasonFallback.season} season`;
      }

      // Edition-level badges, by the set that earned them: the hover text
      // per badge ("Challenge Reward: Holo MMXX (4_133)") and the marks
      // beside the set ids
      const rewardEditions = playRewardEditions(playID);
      let badgeTitles = null, rewardBySet = null;
      if (rewardEditions.length > 0) {
        badgeTitles = {}; rewardBySet = {};
        const setName = (sid) => (matchingSets.find((s) => Number(s.id) === sid) || {}).name || `Set #${sid}`;
        rewardEditions.forEach(({ setID, tags }) => {
          rewardBySet[setID] = tags;
          tags.forEach((t) => {
            const where = `${setName(setID)} (${setID}_${playID})`;
            badgeTitles[t] = badgeTitles[t] ? `${badgeTitles[t]}, ${where}` : `${t}: ${where}`;
          });
        });
      }

      return {
        ...metadata,
        playID_raw: Number(playID),
        playID: String(playID),
        isMismint,
        matchingSets,
        badgeTitles,
        rewardBySet,
        DateOfMomentLocal,
        seasonFallback,
        matchup,
        Owned: owned ? (owned.index?.byPlay.get(Number(playID)) || 0) : undefined,
        // Derived tags (badges on the front end), from the compiled play,
        // plus Commentary when any edition of the play has a narrated cut
        // Plus the edition-level tags of any of its editions (reward sets)
        badges: withCommentary(withTags(getCalculatedPlayTags(meta, null, tsdIndex, mintClock), playEditionTags(playID)), playHasCommentary(playID))
      };
    });
  }, [leagueFilteredPlays, playToSets, seriesSeasonMap, tsdIndex, mintClock, owned]);

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
          Every play: the player, the game, the date, and the sets it appears in.
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
                  {filteredRecords.length.toLocaleString()} of {tableRecords.length.toLocaleString()} plays match
                </span>
              )}
            </LeagueFilter>
            {(seasonFilter || contextFilter || seriesFilter || eraFilter) && (
              <div className="plays-filter-indicator">
                <span>
                  Displaying <strong>{filteredRecords.length.toLocaleString()}</strong> plays for{" "}
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
              records={filteredRecords}
              keyColumn="playID_raw"
              defaultSortColumn="playID_raw"
              defaultSortOrder="desc"
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
