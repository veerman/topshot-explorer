import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getAllPlaysDB, getAllTeamsDB } from "../services/db.service";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { resolveVenue, normalizeTeamName, isMismintPlay } from "../services/overrides.service";
import { DataTable } from "../components/DataTable";
import { buildTeamNameMap, ownedCountColumn } from "../utils/display.utils";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";

const NO_ROWS = [];

async function loadArenasData() {
  const [dbPlays, dbTeams] = await Promise.all([getAllPlaysDB(), getAllTeamsDB()]);
  return { plays: dbPlays, teams: dbTeams };
}

export function Arenas() {
  const { data, loading, loadError, retry } = useDbData(loadArenasData, "Could not read the arenas data from the local database.");
  const plays = data ? data.plays : NO_ROWS;
  const teams = data ? data.teams : NO_ROWS;
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);

  // 3. Compile the arenas and map plays to them
  const arenasData = useMemo(() => {
    if (loading) return { list: [] };

    // Create a teamNameMap to resolve on-chain HomeTeamName to teamId
    const nameMap = buildTeamNameMap(teams);
    const ownedByPlay = owned ? owned.index?.byPlay : null;

    const arenasByName = {};

    // Each play counts at the arena its home team played in on that date
    plays.forEach((play) => {
      // Mismint plays (plays_exclude.json) never count toward stats
      if (isMismintPlay(play.playID)) return;
      if (!play.HomeTeamName) return;
      const homeTeamId = nameMap[play.HomeTeamName.trim().toLowerCase()];
      if (!homeTeamId) return;

      const venue = resolveVenue(homeTeamId, play.DateOfMoment);
      if (venue && venue.arena) {
        const normName = venue.arena.trim().toLowerCase();
        if (!arenasByName[normName]) {
          arenasByName[normName] = {
            arena: venue.arena,
            city: venue.city || "",
            state: venue.state || "",
            playIDs: new Set(),
            teams: new Set(),
            players: new Set(),
            ownedPlayIDs: new Set(),
            ownedTeams: new Set(),
            ownedPlayers: new Set()
          };
        }

        arenasByName[normName].playIDs.add(Number(play.playID));

        if (play.HomeTeamName) {
          arenasByName[normName].teams.add(normalizeTeamName(play.HomeTeamName));
        }
        if (play.AwayTeamName) {
          arenasByName[normName].teams.add(normalizeTeamName(play.AwayTeamName));
        }
        if (play.FullName) {
          arenasByName[normName].players.add(play.FullName);
        }
        // Owned-as-account: the same tallies over only the plays the
        // browsed address holds a moment of
        if (ownedByPlay && (ownedByPlay.get(Number(play.playID)) || 0) > 0) {
          arenasByName[normName].ownedPlayIDs.add(Number(play.playID));
          if (play.HomeTeamName) arenasByName[normName].ownedTeams.add(normalizeTeamName(play.HomeTeamName));
          if (play.AwayTeamName) arenasByName[normName].ownedTeams.add(normalizeTeamName(play.AwayTeamName));
          if (play.FullName) arenasByName[normName].ownedPlayers.add(play.FullName);
        }
      }
    });

    // Convert grouped map to list
    const list = Object.values(arenasByName).map((item) => {
      return {
        arena: item.arena,
        city: item.city,
        state: item.state,
        playCount: item.playIDs.size,
        teamsCount: item.teams.size,
        teamsSet: item.teams,
        playersCount: item.players.size,
        ownedPlayCount: item.ownedPlayIDs.size,
        ownedTeamsCount: item.ownedTeams.size,
        ownedPlayersCount: item.ownedPlayers.size
      };
    });

    // Alphabetical underneath, so arenas tied on the sorted column keep a
    // fixed order (the table's sort is stable)
    list.sort((x, y) => x.arena.localeCompare(y.arena));
    return { list };
  }, [plays, teams, loading, owned]);

  // Define columns for DataTable
  const columns = useMemo(() => {
    return [
      { key: "arenaCell", text: "Arena Venue" },
      { key: "locationCell", text: "Location" },
      // Keyed by the RAW numeric fields (cells via render) so the default
      // sort names a real column: arrow shown, third click returns to it
      ownedCountColumn({ key: "playCount", text: "Plays", totalField: "playCount", ownedField: "ownedPlayCount", accountMode, render: (_val, rec) => rec.playCountCell }),
      ownedCountColumn({ key: "teamsCount", text: "Teams", totalField: "teamsCount", ownedField: "ownedTeamsCount", accountMode, render: (_val, rec) => rec.teamsCountCell }),
      ownedCountColumn({ key: "playersCount", text: "Players", totalField: "playersCount", ownedField: "ownedPlayersCount", accountMode, render: (_val, rec) => rec.playersCountCell })
    ];
  }, [accountMode]);

  const navigate = useNavigate();
  // Format table rows
  const tableRecords = useMemo(() => {
    return arenasData.list.map((venue) => {
      const locationCell = `${venue.city}, ${venue.state}`;

      const playCountCell = owned ? (
        <OwnedFraction owned={venue.ownedPlayCount} total={venue.playCount} greenWhenFull to={`/arenas/${encodeURIComponent(venue.arena.replace(/\s+/g, "_"))}?f_Owned=0`} />
      ) : (
        <span style={{ color: "#fff", fontWeight: "600" }}>
          {venue.playCount}
        </span>
      );

      const teamsCountCell = owned ? (
        <OwnedFraction owned={venue.ownedTeamsCount} total={venue.teamsCount} greenWhenFull />
      ) : (
        <span style={{ color: "#fff", fontWeight: "600" }}>
          {venue.teamsCount}
        </span>
      );

      const playersCountCell = owned ? (
        <OwnedFraction owned={venue.ownedPlayersCount} total={venue.playersCount} greenWhenFull />
      ) : (
        <span style={{ color: "#fff", fontWeight: "600" }}>
          {venue.playersCount}
        </span>
      );

      const arenaUrlName = encodeURIComponent(venue.arena.replace(/\s+/g, "_"));
      const arenaCell = (
        <Link
          to={`/arenas/${arenaUrlName}`}
          className="player-detail-link font-hover-glow"
          style={{ fontWeight: "600", color: "var(--primary-hover)", textDecoration: "none" }}
        >
          {venue.arena}
        </Link>
      );

      return {
        id: venue.arena.toLowerCase().trim(),
        // The whole row opens the arena
        _clickable: true,
        _rowTo: `/arenas/${arenaUrlName}`,
        arenaCell,
        locationCell,
        playCount: venue.playCount,
        playCountCell,
        teamsCount: venue.teamsCount,
        teamsCountCell,
        playersCount: venue.playersCount,
        playersCountCell,
        ownedPlayCount: venue.ownedPlayCount,
        ownedTeamsCount: venue.ownedTeamsCount,
        ownedPlayersCount: venue.ownedPlayersCount
      };
    });
  }, [arenasData.list, owned]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Analyzing play coordinates and resolving temporal arenas..." />;
  }

  return (
    <div className="arenas-page-container">
      {/* Page Header */}
      <div className="glass-panel info-banner">
        <h2>Arenas</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Where each moment happened. The arena comes from the home team and the game date, under the name it
          carried at the time. Open an arena for every play captured there.
        </p>
      </div>

      {/* Tabular Data Table */}
      <div className="glass-panel mt-20 table-panel">
        <DataTable
          columns={columns}
          ownedFilter={owned ? "playCount" : ""}
          records={tableRecords}
          defaultSortColumn="playCount"
          defaultSortOrder="desc"
          onRowClick={(rec) => navigate(rec._rowTo)}
        />
      </div>

      <style>{`
        .arenas-page-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
      `}</style>
    </div>
  );
}
