import { useMemo } from "react";
import { Link } from "react-router-dom";
import { getAllPlaysDB, getAllTeamsDB } from "../services/db.service";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { resolveVenue, normalizeTeamName, isMismintPlay } from "../services/overrides.service";
import { DataTable } from "../components/DataTable";
import { buildTeamNameMap, ownedCountColumn } from "../utils/display.utils";
import teamsAdditions from "../../data/additions/teams.json";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";

// Arena display name for a config entry: `name` holds the historical arena
// name and `arena` the current one; resolveVenue prefers `name`, so seeding
// must match or renamed venues appear twice (one row dead at 0 plays).
const getArenaConfigName = (config) => config.name || config.arena || "";

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
    if (loading) return { list: [], totalUnique: 0, activeCount: 0, inactiveCount: 0 };

    // Create a teamNameMap to resolve on-chain HomeTeamName to teamId
    const nameMap = buildTeamNameMap(teams);
    const ownedByPlay = owned ? owned.index?.byPlay : null;

    const arenasByName = {};

    // First, initialize arenasByName from teamsAdditions to capture all defined arenas (including inactive ones)
    Object.values(teamsAdditions).forEach((team) => {
      if (!team.arenas || team.arenas.length === 0) return;

      team.arenas.forEach((arenaConfig) => {
        const configName = getArenaConfigName(arenaConfig);
        if (!configName) return;
        const normName = configName.trim().toLowerCase();
        if (!arenasByName[normName]) {
          arenasByName[normName] = {
            arena: configName,
            city: arenaConfig.city || "",
            state: arenaConfig.state || "",
            lat: arenaConfig.lat,
            lng: arenaConfig.lng,
            playIDs: new Set(),
            teams: new Set(),
            players: new Set(),
            ownedPlayIDs: new Set(),
            ownedTeams: new Set(),
            ownedPlayers: new Set()
          };
        } else {
          // If we have an existing entry, but it lacks city or state, fill them in
          if (!arenasByName[normName].city && arenaConfig.city) arenasByName[normName].city = arenaConfig.city;
          if (!arenasByName[normName].state && arenaConfig.state) arenasByName[normName].state = arenaConfig.state;
          if (arenasByName[normName].lat === undefined && arenaConfig.lat !== undefined) {
            arenasByName[normName].lat = arenaConfig.lat;
            arenasByName[normName].lng = arenaConfig.lng;
          }
        }
      });
    });

    // Next, map plays to their temporal resolved arena
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
            lat: venue.lat,
            lng: venue.lng,
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
      const sortedPlayIds = Array.from(item.playIDs).sort((a, b) => a - b);
      return {
        arena: item.arena,
        city: item.city,
        state: item.state,
        lat: item.lat,
        lng: item.lng,
        playCount: item.playIDs.size,
        playIDs: sortedPlayIds,
        teamsCount: item.teams.size,
        teamsSet: item.teams,
        playersCount: item.players.size,
        ownedPlayCount: item.ownedPlayIDs.size,
        ownedTeamsCount: item.ownedTeams.size,
        ownedPlayersCount: item.ownedPlayers.size
      };
    });

    return { list };
  }, [plays, teams, loading, owned]);

  // Only venues that actually hosted a moment; the zero-play rows (defined
  // arenas no play resolves to) stay out of sight entirely
  const filteredArenas = useMemo(
    () => arenasData.list.filter((arena) => arena.playCount > 0),
    [arenasData.list]
  );

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

  // Format table rows
  const tableRecords = useMemo(() => {
    return filteredArenas.map((venue) => {
      const locationCell = `${venue.city}, ${venue.state}`;

      const playCountCell = owned ? (
        <OwnedFraction owned={venue.ownedPlayCount} total={venue.playCount} greenWhenFull />
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
  }, [filteredArenas, owned]);

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
          records={tableRecords}
          defaultSortColumn="playCount"
          defaultSortOrder="desc"
        />
      </div>

      <style>{`
        .arenas-page-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .badge-zero-plays {
          background: rgba(244, 63, 94, 0.08);
          color: #f43f5e;
          border: 1px solid rgba(244, 63, 94, 0.15);
          font-weight: 700;
          padding: 3px 10px;
          border-radius: 6px;
          font-size: 0.8rem;
          display: inline-block;
        }
        .badge-active-plays {
          background: rgba(16, 185, 129, 0.08);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.15);
          font-weight: 700;
          padding: 3px 10px;
          border-radius: 6px;
          font-size: 0.8rem;
          display: inline-block;
        }
        .play-ids-scrollable {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          max-width: 320px;
          max-height: 48px;
          overflow-y: auto;
          padding-right: 4px;
        }
        .play-tag {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--primary-hover);
          padding: 2px 6px;
          border-radius: 4px;
          text-decoration: none;
          transition: var(--transition-smooth);
        }
        .play-tag:hover {
          background: var(--primary);
          border-color: var(--primary);
          color: #fff;
        }
      `}</style>
    </div>
  );
}
