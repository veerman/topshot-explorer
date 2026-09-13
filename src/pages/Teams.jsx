import { useMemo } from "react";
import { Link } from "react-router-dom";
import { getAllPlaysDB, getAllEditionsDB, getAllTeamsDB } from "../services/db.service";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { getTeamDetailsById, isMismintPlay } from "../services/overrides.service";
import { supplyOf, otherSupplyOf } from "../services/supply.service";
import { Supply } from "../components/Supply";
import { getLeagueName, renderEmojiName, ownedMintsColumn, ownedCountColumn, ALL_LEAGUE_OPTIONS } from "../utils/display.utils";

import { DataTable } from "../components/DataTable";
import { LeagueFilter } from "../components/LeagueFilter";
import { useUrlParam } from "../hooks/useUrlParam";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { useOwnedPct } from "../hooks/useOwnedPct";

const NO_ROWS = [];

async function loadTeamsData() {
  const [dbTeams, dbPlays, dbEditions] = await Promise.all([
    getAllTeamsDB(),
    getAllPlaysDB(),
    getAllEditionsDB()
  ]);
  return { teams: dbTeams, plays: dbPlays, editions: dbEditions };
}

export function Teams() {
  const { data, loading, loadError, retry } = useDbData(loadTeamsData, "Could not read the teams from the local database.");
  const teams = data ? data.teams : NO_ROWS;
  const plays = data ? data.plays : NO_ROWS;
  const editions = data ? data.editions : NO_ROWS;
  const [selectedLeague, setSelectedLeague] = useUrlParam("league", "all", ["all", "nba", "wnba"]);
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();

  // 3. Aggregate Teams dynamically in-memory using IndexedDB teams as source of truth
  const teamsList = useMemo(() => {
    if (teams.length === 0) return [];

    const editionsMap = {};
    const editionsOther = {};
    editions.forEach((ed) => {
      const playID = Number(ed.playID);
      editionsMap[playID] = (editionsMap[playID] || 0) + supplyOf(ed.momentCount, ed.setID, ed.playID);
      editionsOther[playID] = (editionsOther[playID] || 0) + otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
    });

    const ownedByPlay = owned ? owned.index?.byPlay : null;

    const statsMap = {};
    teams.forEach((t) => {
      statsMap[String(t.TeamAtMomentNBAID)] = {
        playIDs: new Set(),
        players: new Set(),
        ownedPlayIDs: new Set(),
        ownedPlayers: new Set(),
        names: new Set([t.TeamName || t.TeamAtMoment])
      };
    });

    plays.forEach((play) => {
      // Mismint plays (plays_exclude.json) never count toward stats
      if (isMismintPlay(play.playID)) return;
      const nbaID = play.TeamAtMomentNBAID;
      if (!nbaID) return;
      const cleanID = String(nbaID);

      if (!statsMap[cleanID]) {
        statsMap[cleanID] = {
          playIDs: new Set(),
          players: new Set(),
          ownedPlayIDs: new Set(),
          ownedPlayers: new Set(),
          names: new Set()
        };
      }

      if (play.TeamAtMoment) statsMap[cleanID].names.add(play.TeamAtMoment);
      if (play.playID) statsMap[cleanID].playIDs.add(Number(play.playID));
      if (play.FullName) statsMap[cleanID].players.add(play.FullName);
      // Owned-as-account: which of this team's plays and players the
      // browsed address holds at least one moment of
      if (ownedByPlay && (ownedByPlay.get(Number(play.playID)) || 0) > 0) {
        statsMap[cleanID].ownedPlayIDs.add(Number(play.playID));
        if (play.FullName) statsMap[cleanID].ownedPlayers.add(play.FullName);
      }
    });

    return teams.map((team) => {
      const cleanID = String(team.TeamAtMomentNBAID);
      const stats = statsMap[cleanID];

      const namesArr = Array.from(stats.names);
      const primaryName = team.TeamName || team.TeamAtMoment || namesArr[0] || "Unknown Team";
      const secondaryNames = namesArr.filter(n => n !== primaryName);

      let totalMints = 0;
      let totalOther = 0;
      let ownedMints = 0;
      stats.playIDs.forEach((pID) => {
        totalMints += (editionsMap[pID] || 0);
        totalOther += (editionsOther[pID] || 0);
        if (ownedByPlay) ownedMints += (ownedByPlay.get(pID) || 0);
      });

      // Determine League
      const league = getLeagueName(primaryName);

      return {
        id: cleanID,
        primaryName,
        secondaryNames,
        playCount: stats.playIDs.size,
        playerCount: stats.players.size,
        ownedPlayCount: stats.ownedPlayIDs.size,
        ownedPlayerCount: stats.ownedPlayers.size,
        ownedMints,
        totalMints,
        totalOther,
        league,
        CurrentTeamID: team.TeamID || team.CurrentTeamID
      };
    }).sort((a, b) => b.playCount - a.playCount); // Sort by highest play count
  }, [teams, plays, editions, owned]);

  // Separate leagues
  const nbaTeams = useMemo(() => teamsList.filter(t => t.league === "NBA"), [teamsList]);
  const wnbaTeams = useMemo(() => teamsList.filter(t => t.league === "WNBA"), [teamsList]);

  // 4. Columns definition. The count columns are keyed by their RAW
  // numeric fields (cells via render) so defaultSortColumn="playCount"
  // names a real column: the header shows the sort arrow, and a third
  // click can return to the default order.
  const columns = useMemo(() => {
    return [
      { key: "idCell", text: "NBA ID" },
      { key: "name", text: "Team Name" },
      ownedCountColumn({ key: "playCount", text: "Plays", totalField: "playCount", ownedField: "ownedPlayCount", accountMode, render: (_val, rec) => rec.playCountCell }),
      ownedCountColumn({ key: "playerCount", text: "Players", totalField: "playerCount", ownedField: "ownedPlayerCount", accountMode, render: (_val, rec) => rec.playerCountCell }),
      ownedMintsColumn({ key: "totalMints", text: "Mints", totalField: "totalMints", ownedField: "ownedMints", accountMode, pctMode, render: (_val, rec) => rec.totalMintsFormatted }),
      { key: "secondaryNamesDisplay", text: "Aka / Alternates" }
    ];
  }, [accountMode, pctMode]);

  const mapTeamsToRecords = (teams) => {
    return teams.map((team) => {
      const idCell = (
        <Link to={`/teams/${team.id}`} className="font-mono team-id-badge" style={{ display: "inline-block" }}>
          {team.id}
        </Link>
      );

      const details = getTeamDetailsById(team.id);

      const nameCell = (
        <Link to={`/teams/${team.id}`} style={{ fontWeight: "600", color: "#fff", textDecoration: "none" }} className="player-detail-link font-hover-glow">
          {renderEmojiName(details && details.emoji, team.primaryName)}
        </Link>
      );

      const secondaryNamesDisplay = team.secondaryNames.length > 0
        ? team.secondaryNames.join(", ")
        : "-";

      return {
        ...team,
        idCell,
        name: nameCell,
        playCountCell: owned
          ? <OwnedFraction owned={team.ownedPlayCount} total={team.playCount} greenWhenFull title={`${team.ownedPlayCount} of ${team.playCount} plays owned`} />
          : team.playCount,
        playerCountCell: owned
          ? <OwnedFraction owned={team.ownedPlayerCount} total={team.playerCount} greenWhenFull title={`${team.ownedPlayerCount} of ${team.playerCount} players represented`} />
          : team.playerCount,
        totalMintsFormatted: owned
          ? <OwnedFraction owned={team.ownedMints} total={team.totalMints} pct={pctMode} title={`${team.ownedMints.toLocaleString()} of ${team.totalMints.toLocaleString()} moments owned`} />
          : <Supply shown={team.totalMints} other={team.totalOther} />,
        secondaryNamesDisplay
      };
    });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nbaRecords = useMemo(() => mapTeamsToRecords(nbaTeams), [nbaTeams, pctMode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wnbaRecords = useMemo(() => mapTeamsToRecords(wnbaTeams), [wnbaTeams, pctMode]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Analyzing team databases..." />;
  }

  return (
    <div className="teams-page-container">
      {/* Page Header */}
      <div className="glass-panel info-banner">
        <h2>Teams</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Every franchise with a moment, earlier names included. Open a team for its players, plays and arena
          history.
        </p>
      </div>

      {teamsList.length === 0 ? (
        <div className="glass-panel text-center" style={{ padding: "40px" }}>
          <p className="text-muted">Loading teams...</p>
        </div>
      ) : (
        <div className="teams-sections-wrapper">
          <div className="glass-panel" style={{ padding: "16px 24px 0", marginBottom: "20px" }}>
            <LeagueFilter
              options={ALL_LEAGUE_OPTIONS}
              selected={selectedLeague}
              onSelect={setSelectedLeague}
            />
          </div>

          {/* NBA Section */}
          {(selectedLeague === "all" || selectedLeague === "nba") && (
            <div className="glass-panel mt-20 table-panel">
              <h2 className="section-title">National Basketball Association (NBA)</h2>
              <div className="mt-20">
                <DataTable
                  columns={columns}
                  records={nbaRecords}
                  defaultSortColumn="playCount"
                  defaultSortOrder="desc"
                  urlPrefix="nba"
                />
              </div>
            </div>
          )}

          {/* WNBA Section */}
          {(selectedLeague === "all" || selectedLeague === "wnba") && (
            <div className="glass-panel mt-30 table-panel">
              <h2 className="section-title">Women's National Basketball Association (WNBA)</h2>
              <div className="mt-20">
                <DataTable
                  columns={columns}
                  records={wnbaRecords}
                  defaultSortColumn="playCount"
                  defaultSortOrder="desc"
                  urlPrefix="wnba"
                />
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        .teams-page-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .section-title {
          font-size: 1.4rem;
          font-weight: 700;
          color: #fff;
          border-left: 4px solid var(--primary);
          padding-left: 12px;
        }
      `}</style>
    </div>
  );
}
