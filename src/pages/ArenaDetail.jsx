import { useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { getAllPlaysDB, getAllTeamsDB, getAllSetsDB } from "../services/db.service";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { resolveVenue, normalizeTeamName, buildTsdIndex, buildMintClock } from "../services/overrides.service";
import { buildTeamNameMap, buildSeriesSeasonMap } from "../utils/display.utils";
import { DataTable } from "../components/DataTable";
import { playTableColumns, buildPlayRecord, buildPlayToSets } from "../components/PlayTable";
import { useAccountCollection } from "../hooks/useAccountCollection";
import playsExclude from "../../data/plays_exclude.json";

const NO_ROWS = [];

async function loadArenaData() {
  const [dbPlays, dbTeams, dbSets] = await Promise.all([getAllPlaysDB(), getAllTeamsDB(), getAllSetsDB()]);
  return { plays: dbPlays, teams: dbTeams, sets: dbSets };
}

export function ArenaDetail() {
  const { arenaName } = useParams();
  const displayArenaName = decodeURIComponent(arenaName).replace(/_/g, " ");

  const { data, loading, loadError, retry } = useDbData(loadArenaData, "Could not read this arena's data from the local database.");
  const plays = data ? data.plays : NO_ROWS;
  const teams = data ? data.teams : NO_ROWS;
  const sets = data ? data.sets : NO_ROWS;
  const owned = useAccountCollection();
  const navigate = useNavigate();

  // 3. Resolve Home Team Name Map
  const nameMap = useMemo(() => buildTeamNameMap(teams), [teams]);

  // 4. Filter plays occurring at this physical venue
  const filteredPlays = useMemo(() => {
    if (plays.length === 0 || Object.keys(nameMap).length === 0) return [];

    const matched = [];
    plays.forEach((play) => {
      if (!play.HomeTeamName) return;
      const homeTeamId = nameMap[play.HomeTeamName.trim().toLowerCase()];
      if (!homeTeamId) return;

      const venue = resolveVenue(homeTeamId, play.DateOfMoment);
      if (
        venue &&
        venue.arena &&
        venue.arena.toLowerCase().trim() === displayArenaName.toLowerCase().trim()
      ) {
        matched.push({
          ...play,
          resolvedVenue: venue,
          homeTeamId
        });
      }
    });
    return matched;
  }, [plays, nameMap, displayArenaName]);

  // 5. Gather unique details for the header cards
  const metrics = useMemo(() => {
    const uniqueTeamsSet = new Set();
    let homeWins = 0;
    let awayWins = 0;

    filteredPlays.forEach((play) => {
      if (play.HomeTeamName) uniqueTeamsSet.add(normalizeTeamName(play.HomeTeamName));
      if (play.AwayTeamName) uniqueTeamsSet.add(normalizeTeamName(play.AwayTeamName));

      const homeScore = parseInt(play.HomeTeamScore) || 0;
      const awayScore = parseInt(play.AwayTeamScore) || 0;
      if (homeScore > awayScore) homeWins++;
      else if (awayScore > homeScore) awayWins++;
    });

    // Lookup static details from additions config if no plays found yet
    let cityState = "Unknown Location";
    let coords = "";
    const activeVenue = filteredPlays[0]?.resolvedVenue;
    if (activeVenue) {
      cityState = `${activeVenue.city}, ${activeVenue.state}`;
      if (activeVenue.lat !== undefined) {
        coords = `${activeVenue.lat}, ${activeVenue.lng}`;
      }
    }

    return {
      total: filteredPlays.length,
      uniqueTeams: uniqueTeamsSet.size,
      homeWins,
      awayWins,
      cityState,
      coords
    };
  }, [filteredPlays]);

  // 6. The shared one-row-per-play table (PlayTable), as on the Plays page.
  // Debut index and mint clock run over ALL plays so badges never depend
  // on the venue filter.
  const columns = useMemo(() => playTableColumns({ teamNameMap: nameMap, owned }), [nameMap, owned]);
  const playToSets = useMemo(() => buildPlayToSets(sets), [sets]);
  const tsdIndex = useMemo(() => buildTsdIndex(plays), [plays]);
  const mintClock = useMemo(() => buildMintClock(plays), [plays]);
  const seriesSeasonMap = useMemo(() => buildSeriesSeasonMap(plays, playToSets), [plays, playToSets]);
  const tableRecords = useMemo(
    () => filteredPlays.map((play) => buildPlayRecord(play, { playToSets, seriesSeasonMap, tsdIndex, mintClock, owned })),
    [filteredPlays, playToSets, seriesSeasonMap, tsdIndex, mintClock, owned]
  );

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message={`Scanning offline databases for plays at ${displayArenaName}...`} />;
  }

  return (
    <div className="arena-detail-container">
      {/* Back navigation */}
      <div style={{ marginBottom: "16px" }}>
        <Link to="/arenas" className="btn-filter" style={{ display: "inline-flex", textDecoration: "none" }}>
          ← Back to Arenas
        </Link>
      </div>

      {/* Header Glass Card */}
      <div className="glass-panel info-banner">
        <div className="d-flex align-center gap-10">
          <span style={{ fontSize: "2rem" }}>🏟️</span>
          <div>
            <h2>{displayArenaName}</h2>
            <p className="text-muted mt-4" style={{ fontSize: "1rem" }}>
              {metrics.cityState} {metrics.coords && `| Coordinates: ${metrics.coords}`}
            </p>
          </div>
        </div>
      </div>

      {/* Stats Cards Row */}
      <div className="metrics-grid mt-20">
        <div className="glass-panel metric-card glow-purple">
          <span className="metric-title font-mono">Total Plays</span>
          <span className="metric-val">{metrics.total}</span>
          <span className="metric-sub text-muted">Moments recorded in this venue</span>
        </div>
        <div className="glass-panel metric-card glow-green">
          <span className="metric-title font-mono">Unique Teams</span>
          <span className="metric-val" style={{ color: "#10b981" }}>{metrics.uniqueTeams}</span>
          <span className="metric-sub text-muted">Teams played home or away</span>
        </div>
        <div className="glass-panel metric-card glow-blue">
          <span className="metric-title font-mono">Home Wins</span>
          <span className="metric-val" style={{ color: "#60a5fa" }}>{metrics.homeWins}</span>
          <span className="metric-sub text-muted">Total games won by home hosts</span>
        </div>
        <div className="glass-panel metric-card glow-red">
          <span className="metric-title font-mono">Away Wins</span>
          <span className="metric-val" style={{ color: "#f43f5e" }}>{metrics.awayWins}</span>
          <span className="metric-sub text-muted">Total games won by visitors</span>
        </div>
      </div>

      {/* Table Explorer */}
      <div className="glass-panel mt-20 table-panel">
        <h3 style={{ marginBottom: "16px", fontSize: "1.2rem", fontWeight: "700", color: "#fff" }}>
          Play Highlights List
        </h3>
        {metrics.total === 0 ? (
          <div style={{ padding: "40px", textAlign: "center" }}>
            <p className="text-muted">No moments recorded in this arena.</p>
          </div>
        ) : (
          <DataTable
            columns={columns}
            ownedFilter={owned ? "Owned" : ""}
            records={tableRecords}
            keyColumn="playID_raw"
            defaultSortColumn="DateOfMomentLocal"
            defaultSortOrder="desc"
            mismints={playsExclude}
            onRowClick={(rec) => navigate(rec._rowTo)}
          />
        )}
      </div>

      <style>{`
        .arena-detail-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 20px;
        }
        .metric-card {
          padding: 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .metric-title {
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
        }
        .metric-val {
          font-size: 2.2rem;
          font-weight: 800;
          color: #fff;
          margin: 4px 0;
        }
        .metric-sub {
          font-size: 0.8rem;
        }
        .glow-purple {
          border-bottom: 3px solid var(--primary);
        }
        .glow-green {
          border-bottom: 3px solid #10b981;
        }
        .glow-blue {
          border-bottom: 3px solid #3b82f6;
        }
        .glow-red {
          border-bottom: 3px solid #f43f5e;
        }
        .btn-filter {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 0.85rem;
          cursor: pointer;
          transition: var(--transition-smooth);
          font-weight: 500;
        }
        .btn-filter:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }
      `}</style>
    </div>
  );
}
