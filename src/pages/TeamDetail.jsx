import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { getAllPlaysDB, getAllSetsDB, getAllEditionsDB } from "../services/db.service";
import { DataTable } from "../components/DataTable";
import { getTeamDetailsById, getTeamNameWithEmoji, getTeamEmoji, isMismintPlay } from "../services/overrides.service";
import { supplyOf, otherSupplyOf } from "../services/supply.service";
import { Supply, SupplyWord } from "../components/Supply";
import { isWnbaTeam, renderEmojiName, playerPath, ownedMintsColumn, ownedCountColumn } from "../utils/display.utils";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { useOwnedPct } from "../hooks/useOwnedPct";
import { playSerialFacts, summarizeOwnedPlays } from "../utils/serials.utils";
import { OwnedSummaryBanner } from "../components/OwnedSummaryBanner";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { useDbData } from "../hooks/useDbData";
import { facetParam } from "../utils/query";

// Heading gradient tinted toward the team's primary colour (teams.json).
// Every colour is lifted 45% toward white first, so dark franchise
// colours (Nets black, Pacers navy) never fade the name's tail into the
// page background. Only backgroundImage is set: the global h1 rule keeps
// its background-clip: text, which a `background` shorthand would reset.
const teamHeadingStyle = (hex) => {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  const tint = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  return { backgroundImage: `linear-gradient(135deg, #fff 0%, ${tint} 100%)` };
};

const NO_ROWS = [];

async function loadTeamData() {
  const [dbPlays, dbSets, dbEditions] = await Promise.all([
    getAllPlaysDB(),
    getAllSetsDB(),
    getAllEditionsDB()
  ]);
  return { plays: dbPlays, sets: dbSets, editions: dbEditions };
}

export function TeamDetail() {
  const { teamID } = useParams();
  const { data, loading, loadError, retry } = useDbData(loadTeamData, "Could not read this team's data from the local database.");
  const plays = data ? data.plays : NO_ROWS;
  const sets = data ? data.sets : NO_ROWS;
  const editions = data ? data.editions : NO_ROWS;
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();

  // Fetch additions details
  const teamDetails = useMemo(() => {
    return getTeamDetailsById(teamID);
  }, [teamID]);

  // Filter plays and build aggregations
  const teamContext = useMemo(() => {
    if (plays.length === 0) return null;

    const filteredPlays = plays.filter(
      (play) => String(play.TeamAtMomentNBAID) === String(teamID)
    );

    if (filteredPlays.length === 0) return null;

    // Mismint plays (plays_exclude.json) never count toward stats; mismint
    // team-moment rows still render below, flagged
    const statPlays = filteredPlays.filter(
      (play) => !isMismintPlay(play.playID)
    );

    // Collect team names and unique players
    const names = new Set();
    const players = new Set();
    let league = "NBA";

    statPlays.forEach((play) => {
      if (play.TeamAtMoment) names.add(play.TeamAtMoment);
      if (play.FullName) players.add(play.FullName);

      if (isWnbaTeam(play.TeamAtMoment)) {
        league = "WNBA";
      }
    });

    const teamNames = Array.from(names);
    const primaryName = teamNames[0] || "Unknown Team";
    const alternateNames = teamNames.slice(1);

    // Sum mints and check retired status per play
    const playToMintsMap = {};
    const playToOtherMap = {}; // the number Settings does not show, for the hover swap
    const playToRetiredMap = {};
    editions.forEach((ed) => {
      const pID = Number(ed.playID);
      playToMintsMap[pID] = (playToMintsMap[pID] || 0) + supplyOf(ed.momentCount, ed.setID, ed.playID);
      playToOtherMap[pID] = (playToOtherMap[pID] || 0) + otherSupplyOf(ed.momentCount, ed.setID, ed.playID);

      if (ed.retired) {
        playToRetiredMap[pID] = true;
      }
    });

    // Total team supply, and the other number beside it
    let totalMints = 0;
    let totalOther = 0;
    statPlays.forEach((play) => {
      totalMints += (playToMintsMap[play.playID] || 0);
      totalOther += (playToOtherMap[play.playID] || 0);
    });

    // Group players similar to /players index
    const playerGroups = {};
    const teamPlays = [];

    filteredPlays.forEach((play) => {
      if (!play.FullName) {
        teamPlays.push(play);
      } else {
        // Mismint player plays stay out of roster counts entirely
        if (isMismintPlay(play.playID)) return;
        const name = play.FullName;
        if (!playerGroups[name]) {
          playerGroups[name] = {
            name,
            plays: [],
            totalMints: 0,
            totalOther: 0,
            playIDs: []
          };
        }
        playerGroups[name].plays.push(play);
        playerGroups[name].playIDs.push(Number(play.playID));
        playerGroups[name].totalMints += (playToMintsMap[play.playID] || 0);
        playerGroups[name].totalOther += (playToOtherMap[play.playID] || 0);
      }
    });

    return {
      primaryName,
      alternateNames,
      league,
      totalPlays: statPlays.length,
      totalPlayers: players.size,
      totalMints,
      totalOther,
      plays: filteredPlays,
      playToMintsMap,
      playToOtherMap,
      playToRetiredMap,
      playerGroups,
      teamPlays
    };
  }, [plays, editions, teamID]);

  // Ownership summary for the browsed account over this franchise's plays
  // (mismints excluded, same as the header stats)
  const ownedTeamSummary = useMemo(() => {
    if (!owned?.index || !teamContext) return null;
    const statPlays = teamContext.plays.filter((p) => !isMismintPlay(p.playID));
    if (statPlays.length === 0) return null;
    return summarizeOwnedPlays(
      owned.index,
      new Set(statPlays.map((p) => Number(p.playID))),
      new Map(statPlays.map((p) => [Number(p.playID), playSerialFacts(p)])),
      new Map(editions.map((e) => [String(e.id), Number(e.momentCount) || 0])),
      new Map(sets.map((s) => [Number(s.id), s.series != null ? Number(s.series) : null]))
    );
  }, [owned, teamContext, editions, sets]);

  // Grouped columns definition
  const columns = useMemo(() => {
    return [
      { key: "FullName", text: "Player Name" },
      ownedCountColumn({ key: "PlayCountCell", text: "Plays", totalField: "PlayCount", ownedField: "OwnedPlays", accountMode }),
      ownedMintsColumn({ key: "TotalMintsFormatted", text: "Mints", totalField: "TotalMints", ownedField: "OwnedMints", accountMode, pctMode }),
      { key: "HighlightPlayIDs", text: "Play IDs", align: "left" }
    ];
  }, [accountMode, pctMode]);

  // Format table rows using grouped roster logic
  const tableRecords = useMemo(() => {
    if (!teamContext) return [];

    const records = [];

    // Grouped players
    Object.values(teamContext.playerGroups).forEach((group) => {
      const playerLink = (
        <Link to={`${playerPath(group.name)}?teamnbaid=${teamID}`} className="player-detail-link">
          {group.name}
        </Link>
      );

      const playIDsLinks = (
        <div className="set-links-cell id-grid">
          {group.playIDs.map((pID) => (
            <Link key={pID} to={`/plays/${pID}`} className="set-link">
              #{pID}
            </Link>
          ))}
        </div>
      );

      // Owned-as-account annotations per roster row
      let ownedPlays = 0, ownedMints = 0;
      if (owned) {
        const byPlay = owned.index?.byPlay;
        group.playIDs.forEach((pID) => {
          const n = byPlay ? (byPlay.get(Number(pID)) || 0) : 0;
          if (n > 0) ownedPlays++;
          ownedMints += n;
        });
      }

      records.push({
        name: group.name,
        FullName: playerLink,
        PlayCount: group.plays.length,
        OwnedPlays: ownedPlays,
        PlayCountCell: owned
          ? <OwnedFraction owned={ownedPlays} total={group.plays.length} greenWhenFull />
          : group.plays.length,
        TotalMints: group.totalMints,
        OwnedMints: ownedMints,
        TotalMintsFormatted: owned
          ? <OwnedFraction owned={ownedMints} total={group.totalMints} pct={pctMode} />
          : <Supply shown={group.totalMints} other={group.totalOther} />,
        HighlightPlayIDs: playIDsLinks
      });
    });

    // Team plays listed individually as separate plain-text rows
    teamContext.teamPlays.forEach((play) => {
      const playID = play.playID;
      const isMismint = isMismintPlay(playID);
      const totalMints = teamContext.playToMintsMap[playID] || 0;
      const totalOther = teamContext.playToOtherMap[playID] || 0;

      const playerLink = (
        <span style={{ fontStyle: "italic", color: "var(--text-muted)" }}>
          Team Play
          {isMismint && <span className="mini-badge-mismint" title="This play is a mismint!" style={{ marginLeft: "6px" }}>Mismint ⚠️</span>}
        </span>
      );

      const playIDsLinks = (
        <div className="set-links-cell">
          <Link to={`/plays/${playID}`} className="set-link">
            #{playID}
          </Link>
        </div>
      );

      const ownedOfPlay = owned ? (owned.index?.byPlay.get(Number(playID)) || 0) : 0;
      records.push({
        name: `team-play-${playID}`,
        FullName: playerLink,
        PlayCount: 1,
        OwnedPlays: ownedOfPlay > 0 ? 1 : 0,
        PlayCountCell: owned
          ? <OwnedFraction owned={ownedOfPlay > 0 ? 1 : 0} total={1} greenWhenFull />
          : 1,
        TotalMints: totalMints,
        OwnedMints: ownedOfPlay,
        TotalMintsFormatted: owned
          ? <OwnedFraction owned={ownedOfPlay} total={totalMints} pct={pctMode} />
          : <Supply shown={totalMints} other={totalOther} />,
        HighlightPlayIDs: playIDsLinks
      });
    });

    // Sort: most plays to least (PlayCount desc), and if equal, by mints highest to lowest (TotalMints desc)
    records.sort((a, b) => {
      if (b.PlayCount !== a.PlayCount) {
        return b.PlayCount - a.PlayCount;
      }
      return b.TotalMints - a.TotalMints;
    });

    return records;
  }, [teamContext, teamID, owned, pctMode]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Retrieving team profile and highlight rosters..." />;
  }

  if (!teamContext) {
    return (
      <div className="glass-panel text-center" style={{ padding: "60px 20px" }}>
        <h3>⚠️ Team Profile Not Discovered</h3>
        <p className="text-muted mt-8">
          No plays mapped to Team NBA ID <strong>{teamID}</strong> were discovered. 
          Make sure database sync has run successfully.
        </p>
        <Link to="/teams" className="btn-primary mt-20" style={{ display: "inline-flex" }}>
          ← Back to Teams Overview
        </Link>
      </div>
    );
  }

  return (
    <div className="team-detail-container">
      {/* Back Navigation */}
      <div className="d-flex align-center gap-10" style={{ marginBottom: "20px" }}>
        <Link to="/teams" className="text-muted">← Back to Teams Overview</Link>
      </div>

      {/* Side-by-Side Header Layout */}
      <div className="team-header-layout">
        {/* Team Dashboard Panel */}
        <div className="glass-panel team-header-card flex-2">
          <div className="d-flex align-center justify-between flex-wrap gap-10">
            <div>
              <div className="d-flex align-center gap-10 flex-wrap">
                <span className={`badge ${teamContext.league === "NBA" ? "badge-nba" : "badge-wnba"}`}>
                  {teamContext.league}
                </span>
                <span className="team-id-badge">NBA ID: {teamID}</span>
              </div>
              {/* Structured emoji + name so the h1 gradient text-fill
                  cannot bleach the emoji white; the gradient itself leans
                  into the team's primary colour */}
              <h1 className="team-title mt-8" style={teamHeadingStyle((getTeamDetailsById(teamID) || {}).color)}>
                {renderEmojiName(getTeamEmoji(teamContext.primaryName), teamContext.primaryName)}
              </h1>
              {teamContext.alternateNames.length > 0 && (
                <p className="text-muted mt-4">
                  Also tracked as: {teamContext.alternateNames.map(getTeamNameWithEmoji).join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* Aggregated Stats Row */}
          <div className="team-stats-row mt-30">
            {/* Browsing as an account the count reads owned/total, so the
                banner below never repeats it */}
            <div className="team-stat-item" title={ownedTeamSummary ? "Plays with at least one owned moment, out of this team's plays" : undefined} style={ownedTeamSummary ? { cursor: "help" } : undefined}>
              <span className="label">Plays</span>
              <span className="value">
                {ownedTeamSummary ? (
                  ownedTeamSummary.totalPlays > 0 && ownedTeamSummary.ownedPlays === ownedTeamSummary.totalPlays ? (
                    <span className="owned-complete">{ownedTeamSummary.ownedPlays}/{ownedTeamSummary.totalPlays}<span className="owned-stat-check" title="Complete">✓</span></span>
                  ) : <>{ownedTeamSummary.ownedPlays}/{ownedTeamSummary.totalPlays}</>
                ) : teamContext.totalPlays}
              </span>
            </div>
            <div className="team-stat-item">
              <span className="label">Players</span>
              <span className="value">{teamContext.totalPlayers}</span>
            </div>
            <div className="team-stat-item">
              <span className="label"><SupplyWord remaining="Remaining" minted="Minted" /></span>
              <span className="value"><Supply shown={teamContext.totalMints} other={teamContext.totalOther} /></span>
            </div>
          </div>

          {ownedTeamSummary && (
            <OwnedSummaryBanner
              summary={ownedTeamSummary}
              // Renamed franchises span several TeamAtMoment strings; the
              // account Team facet is multi-select, so pass them all
              link={`/account/${owned.address}?${facetParam("team", [teamContext.primaryName, ...teamContext.alternateNames])}`}
            />
          )}
        </div>

        {/* Team Info & Arena card */}
        {teamDetails && (
          <div className="glass-panel team-arena-card flex-1">
            <h3>Team Info & Arena</h3>
            <div className="info-grid mt-15">
              {teamDetails.arena && (
                <div className="info-row">
                  <span className="info-label">Arena</span>
                  <span className="info-value">{teamDetails.arena}</span>
                </div>
              )}
              {(teamDetails.city || teamDetails.state) && (
                <div className="info-row">
                  <span className="info-label">Location</span>
                  <span className="info-value">
                    {[teamDetails.city, teamDetails.state].filter(Boolean).join(", ")}
                  </span>
                </div>
              )}
              {teamDetails.area_codes && (
                <div className="info-row">
                  <span className="info-label">Area Codes</span>
                  <span className="info-value">{teamDetails.area_codes}</span>
                </div>
              )}
              {teamDetails.lat !== undefined && teamDetails.lng !== undefined && (
                <div className="info-row">
                  <span className="info-label">Coordinates</span>
                  <span className="info-value font-mono" style={{ fontSize: "0.85rem" }}>
                    {Math.abs(teamDetails.lat).toFixed(4)}° {teamDetails.lat >= 0 ? "N" : "S"}, {Math.abs(teamDetails.lng).toFixed(4)}° {teamDetails.lng >= 0 ? "E" : "W"}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Plays Grouped Table */}
      <div className="glass-panel mt-20">
        <h3>Roster</h3>

        <div className="mt-20">
          <DataTable
            columns={columns}
            records={tableRecords}
            keyColumn="name"
            defaultSortColumn="PlayCount"
            defaultSortOrder="desc"
          />
        </div>
      </div>

      <style>{`
        .team-detail-container {
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        }
        .team-header-layout {
          display: flex;
          gap: 20px;
          flex-wrap: wrap;
        }
        .flex-2 {
          flex: 2;
          min-width: 320px;
        }
        .flex-1 {
          flex: 1;
          min-width: 280px;
        }
        .team-header-card {
          padding: 32px;
          position: relative;
        }
        .team-arena-card {
          padding: 24px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(10px);
          display: flex;
          flex-direction: column;
        }
        .team-arena-card h3 {
          font-size: 1.1rem;
          font-weight: 700;
          color: #fff;
          margin: 0 0 12px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          padding-bottom: 8px;
        }
        .team-title {
          font-size: 2.5rem;
          font-weight: 800;
          color: #fff;
        }
        .team-id-badge {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          color: var(--primary-hover);
          background: rgba(139, 92, 246, 0.1);
          padding: 3px 8px;
          border-radius: 4px;
          font-weight: 600;
        }
        .team-stats-row {
          display: flex;
          align-items: center;
          gap: 40px;
          flex-wrap: wrap;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          padding-top: 24px;
        }
        .team-stat-item {
          display: flex;
          flex-direction: column;
        }
        .team-stat-item .label {
          font-size: 0.8rem;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .team-stat-item .value {
          font-size: 1.8rem;
          font-weight: 700;
          color: #fff;
        }
      `}</style>
    </div>
  );
}
