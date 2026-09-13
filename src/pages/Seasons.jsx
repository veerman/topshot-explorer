import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { LeagueFilter } from "../components/LeagueFilter";
import { useUrlParam } from "../hooks/useUrlParam";
import { getAllPlaysDB } from "../services/db.service";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";
import { LoadError } from "../components/LoadError";
import { momentContext, seasonWindows, parentSeason, NBA_CUP_CONTEXT, OUTSIDE_SEASON_WINDOWS } from "../services/overrides.service";
import { getLeagueName } from "../utils/display.utils";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { isMismintPlay } from "../services/ipfs.analysis";

/*
 * Seasons: one league at a time (never mixed), every season that has
 * moments, newest first, with a count of moments per game context (from
 * data/additions/seasons.json via momentContext). Summer Leagues file under
 * the season they precede. Each count deep-links to the Plays page filtered
 * to exactly those moments.
 */

// [context label from momentContext, column header, calendar window key].
// Columns render in order of how many plays they hold (biggest first, so
// Regular leads and Playoffs follows), except the two "unexplained" buckets
// (Off-cal., Undated) which always sit at the very end.
const CONTEXTS = [
  ["Preseason", "Preseason", "preseason"],
  ["Regular Season", "Regular", "regular"],
  [NBA_CUP_CONTEXT, "NBA Cup", "cup"],
  ["Commissioner's Cup Final", "Comm. Cup", "commissioners_cup"],
  ["All-Star", "All-Star", "allstar"],
  ["Play-In", "Play-In", "playin"],
  ["Playoffs", "Playoffs", "playoffs"],
  ["Summer League", "Summer", null],
  [OUTSIDE_SEASON_WINDOWS, "Off-cal.", null],
  ["Undated", "Undated", null]
];

const LEAGUES = ["nba", "wnba"];
const TAIL_CONTEXTS = new Set([OUTSIDE_SEASON_WINDOWS, "Undated"]);

function seasonSortKey(season) {
  const m = String(season).match(/^(\d{4})/);
  return m ? Number(m[1]) : 0;
}

function windowText(w) {
  if (!w) return "";
  if (Array.isArray(w)) return `${w[0]} to ${w[1]}`;
  if (typeof w === "object") {
    const nights = w.group_nights || [];
    const knockout = w.knockout || [];
    const parts = [];
    if (nights.length) parts.push(`group nights ${nights[0]} to ${nights[nights.length - 1]}`);
    if (knockout.length) parts.push(`knockout ${knockout[0].date} to ${knockout[knockout.length - 1].date}`);
    return parts.join("; ");
  }
  return String(w);
}

export function Seasons() {
  const [plays, setPlays] = useState([]);
  const [loadError, setLoadError] = useState("");
  const syncState = useSyncStatus();
  const [selectedLeague, setSelectedLeague] = useUrlParam("league", "nba", LEAGUES);
  const leagueName = selectedLeague === "wnba" ? "WNBA" : "NBA";
  const owned = useAccountCollection();

  // State is set from the promise callback, never synchronously in an effect
  const loadPlays = () => getAllPlaysDB()
    .then((records) => { setPlays(records); setLoadError(""); })
    .catch((err) => {
      console.error("Failed to load plays for the Seasons page:", err);
      setLoadError("Could not read the plays from the local database.");
    });

  useEffect(() => {
    loadPlays();
  }, []);

  useReloadOnSyncComplete(loadPlays);

  // One row per league + season; counts per context label
  const rows = useMemo(() => {
    const map = new Map();
    let noSeason = 0;
    plays.forEach((p) => {
      // Mismint plays (plays_exclude.json) never count toward stats
      if (isMismintPlay(p.playID)) return;
      const season = parentSeason(p.NbaSeason);
      if (!season) { noSeason++; return; }
      const league = getLeagueName(p.TeamAtMoment);
      const id = `${league}|${season}`;
      const row = map.get(id) || { id, league, season, sortKey: seasonSortKey(season), total: 0, counts: {}, ownedCounts: {}, ownedTotal: 0 };
      const ctx = momentContext(p);
      const label = ctx ? ctx.context : "Undated";
      row.counts[label] = (row.counts[label] || 0) + 1;
      row.total++;
      // Owned-as-account: distinct plays owned become the numerator
      if (owned && (owned.index?.byPlay.get(Number(p.playID)) || 0) > 0) {
        row.ownedCounts[label] = (row.ownedCounts[label] || 0) + 1;
        row.ownedTotal++;
      }
      map.set(id, row);
    });
    return { rows: [...map.values()], noSeason };
  }, [plays, owned]);

  const visibleRows = useMemo(() => {
    const list = rows.rows.filter((r) => r.league === leagueName);
    // Flatten counts onto the record so DataTable search/sort see plain values
    return list.map((r) => {
      const rec = { ...r };
      CONTEXTS.forEach(([label]) => { rec[label] = r.counts[label] || 0; });
      return rec;
    });
  }, [rows, leagueName]);

  const accountMode = Boolean(owned);

  const columns = useMemo(() => {
    const columnTotal = (label) => visibleRows.reduce((sum, r) => sum + (r.counts[label] || 0), 0);
    const withData = CONTEXTS.filter(([label]) => columnTotal(label) > 0);
    const present = [
      ...withData.filter(([label]) => !TAIL_CONTEXTS.has(label)).sort((a, b) => columnTotal(b[0]) - columnTotal(a[0])),
      ...withData.filter(([label]) => TAIL_CONTEXTS.has(label))
    ];
    const countCell = (label, key) => (val, rec) => {
      const n = rec.counts[label] || 0;
      if (n === 0) return <span className="text-muted">·</span>;
      const w = key ? (seasonWindows(rec.league, rec.season) || {})[key] : null;
      const title = w ? `${label}: ${windowText(w)}` : label;
      return (
        <Link
          to={`/plays?league=${selectedLeague}&season=${encodeURIComponent(rec.season)}&context=${encodeURIComponent(label)}`}
          className="season-count font-mono font-hover-glow"
          title={title}
        >
          {accountMode
            ? <OwnedFraction owned={rec.ownedCounts[label] || 0} total={n} greenWhenFull />
            : n.toLocaleString()}
        </Link>
      );
    };
    return [
      {
        key: "season",
        text: "Season",
        sortValue: (val, rec) => rec.sortKey,
        // Links to the same place the Total column does: every moment of
        // the season
        render: (val, rec) => (
          <Link
            to={`/plays?league=${selectedLeague}&season=${encodeURIComponent(rec.season)}`}
            className="season-count season-cell font-hover-glow"
            title="All moments from this season"
          >
            {rec.season}
          </Link>
        )
      },
      ...present.map(([label, header, key]) => ({
        key: label,
        text: header,
        align: "right",
        // In account mode, sorting and column filters (e.g. ">0") use the
        // OWNED numerator, not the total
        sortValue: (val, rec) => (accountMode ? (rec.ownedCounts[label] || 0) : (rec.counts[label] || 0)),
        filterValue: (val, rec) => (accountMode ? (rec.ownedCounts[label] || 0) : (rec.counts[label] || 0)),
        render: countCell(label, key)
      })),
      {
        key: "total",
        text: "Total",
        align: "right",
        sortValue: (val, rec) => (accountMode ? (rec.ownedTotal || 0) : rec.total),
        filterValue: (val, rec) => (accountMode ? (rec.ownedTotal || 0) : rec.total),
        render: (val, rec) => (
          <Link
            to={`/plays?league=${selectedLeague}&season=${encodeURIComponent(rec.season)}`}
            className="season-count font-mono font-hover-glow"
            title="All moments from this season"
          >
            {accountMode
              ? <OwnedFraction owned={rec.ownedTotal || 0} total={rec.total} greenWhenFull />
              : rec.total.toLocaleString()}
          </Link>
        )
      }
    ];
  }, [visibleRows, selectedLeague, accountMode]);

  return (
    <div className="seasons-container">
      <div className="glass-panel info-banner">
        <h2>Seasons</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Moments by season and game context, from each season's calendar. Click a count to see those plays.
        </p>
      </div>

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
                { value: "nba", label: "NBA" },
                { value: "wnba", label: "WNBA" }
              ]}
              selected={selectedLeague}
              onSelect={setSelectedLeague}
            />
            <DataTable
              key={selectedLeague}
              columns={columns}
              records={visibleRows}
              defaultSortColumn="season"
              defaultSortOrder="desc"
            />
            {rows.noSeason > 0 && (
              <p className="text-muted" style={{ fontSize: "0.8rem", marginTop: "12px" }}>
                {rows.noSeason.toLocaleString()} plays carry no season and are not listed.
              </p>
            )}
          </>
        )}
      </div>

      <style>{`
        .seasons-container {
          width: 100%;
          max-width: 100%;
          margin: 0 auto;
        }
        /* Many narrow numeric columns: let headers wrap and keep cell
           padding tight so the table fits without a horizontal scrollbar */
        .seasons-container table th {
          white-space: normal;
          line-height: 1.2;
        }
        .seasons-container table th,
        .seasons-container table td {
          padding-left: 8px;
          padding-right: 8px;
        }
        @media (max-width: 1100px) {
          .seasons-container table th,
          .seasons-container table td {
            padding-left: 4px;
            padding-right: 4px;
          }
          .seasons-container table th {
            font-size: 0.7rem;
          }
          .seasons-container table td {
            font-size: 0.82rem;
          }
        }
        @media (max-width: 860px) {
          .seasons-container table th,
          .seasons-container table td {
            padding-left: 3px;
            padding-right: 3px;
          }
          .seasons-container table th {
            font-size: 0.64rem;
          }
          .seasons-container table td {
            font-size: 0.76rem;
          }
        }
        .season-cell {
          white-space: nowrap;
        }
        /* Link color everywhere a cell is clickable, so counts read as
           links at a glance (they were white before, indistinguishable
           from plain text) */
        .season-count {
          color: var(--primary-hover);
          text-decoration: none;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
