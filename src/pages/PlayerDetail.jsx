import React, { useMemo } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { getAllPlaysDB, getAllSetsDB, getAllEditionsDB, getAllTeamsDB } from "../services/db.service";
import { harmonizePlayerProfiles } from "../services/relationship.service";
import { DataTable } from "../components/DataTable";
import { getTeamNameWithEmoji, getTeamEmoji, getTeamDetailsById, isMismintPlay } from "../services/overrides.service";
import { supplyOf, otherSupplyOf } from "../services/supply.service";
import { Supply, SupplyWord } from "../components/Supply";
import { buildTeamNameMap, isWnbaTeam, renderTeamLink, renderEmojiName, formatHeight, playerNameFromParam, calendarDateCell } from "../utils/display.utils";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction, OwnedPctToggle } from "../components/OwnedFraction";
import { useOwnedPct } from "../hooks/useOwnedPct";
import { playSerialFacts, summarizeOwnedPlays } from "../utils/serials.utils";
import { OwnedSummaryBanner } from "../components/OwnedSummaryBanner";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { useDbData } from "../hooks/useDbData";

const NO_ROWS = [];
const NO_MAP = {};

async function loadPlayerData() {
  const [dbPlays, dbSets, dbEditions, dbTeams] = await Promise.all([
    getAllPlaysDB(),
    getAllSetsDB(),
    getAllEditionsDB(),
    getAllTeamsDB()
  ]);
  // Harmonize static profile properties dynamically across plays first
  return {
    plays: harmonizePlayerProfiles(dbPlays),
    sets: dbSets,
    editions: dbEditions,
    teamNameMap: buildTeamNameMap(dbTeams)
  };
}

export function PlayerDetail() {
  const { playerName } = useParams();
  const location = useLocation();
  const queryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const teamNbaIdParam = queryParams.get("teamnbaid");

  const filteredTeamDetails = useMemo(() => {
    return teamNbaIdParam ? getTeamDetailsById(teamNbaIdParam) : null;
  }, [teamNbaIdParam]);

  const { data, loading, loadError, retry } = useDbData(loadPlayerData, "Could not read this player's data from the local database.");
  const plays = data ? data.plays : NO_ROWS;
  const sets = data ? data.sets : NO_ROWS;
  const editions = data ? data.editions : NO_ROWS;
  const teamNameMap = data ? data.teamNameMap : NO_MAP;
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();

  // Decode and Normalize player name lookup (supports both %20 and underscores)
  const targetPlayerName = useMemo(() => playerNameFromParam(playerName), [playerName]);

  // Filter plays and build physical/draft profile aggregations
  const playerContext = useMemo(() => {
    if (plays.length === 0 || !targetPlayerName) return null;

    const filteredPlays = plays.filter((play) => {
      const name = play.FullName;
      return name && name.trim().toLowerCase() === targetPlayerName.toLowerCase();
    });

    if (filteredPlays.length === 0) return null;

    // Aggregate Profile Metadata (scans plays to gather the most complete values)
    let position = "";
    let height = "";
    let weight = "";
    let birthdate = "";
    let birthplace = "";
    let experience = "";
    let draftYear = "";
    let draftRound = "";
    let draftSelection = "";
    let draftTeam = "";
    const teams = new Set();
    const jerseys = new Set();
    let league = "NBA";

    // Build sets play-ID mapping
    const playToSetsMap = {};
    sets.forEach((set) => {
      if (set.playIDs) {
        set.playIDs.forEach((pID) => {
          if (!playToSetsMap[pID]) playToSetsMap[pID] = [];
          playToSetsMap[pID].push({
            id: set.id,
            name: set.setName,
            series: set.series,
            locked: set.locked
          });
        });
      }
    });

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

    filteredPlays.forEach((play) => {
      // Pick first non-empty bio value. Check for harmonizer's merged conflicting values first.
      if (!position) position = play.PlayerPosition || play.PrimaryPosition;
      if (!height && play.Height && play.Height !== "0") height = play.Height;
      if (!weight && play.Weight && play.Weight !== "0") weight = play.Weight;
      
      if (!birthdate) birthdate = play.Birthdate_merged || play.Birthdate;
      if (!birthplace) birthplace = play.Birthplace_merged || play.Birthplace;
      if (!experience) experience = play.TotalYearsExperience;
      
      if (!draftYear && play.DraftYear && play.DraftYear !== "0") draftYear = play.DraftYear_merged || play.DraftYear;
      if (!draftRound) draftRound = play.DraftRound_merged || play.DraftRound;
      if (!draftSelection && play.DraftSelection && play.DraftSelection !== "0") draftSelection = play.DraftSelection_merged || play.DraftSelection;
      if (!draftTeam) draftTeam = play.DraftTeam_merged || play.DraftTeam;

      if (play.TeamAtMoment) {
        teams.add(play.TeamAtMoment);
        if (isWnbaTeam(play.TeamAtMoment)) {
          league = "WNBA";
        }
      }

      if (play.JerseyNumber && play.JerseyNumber !== "0" && play.JerseyNumber !== "N/A") {
        jerseys.add(String(play.JerseyNumber).trim());
      }
    });

    // Sum total supply for this player, and the other number beside it
    let totalMints = 0;
    let totalOther = 0;
    filteredPlays.forEach((play) => {
      totalMints += (playToMintsMap[play.playID] || 0);
      totalOther += (playToOtherMap[play.playID] || 0);
    });

    // Dynamic Team Breakouts
    const teamBreakouts = {};
    filteredPlays.forEach((play) => {
      const tName = play.TeamAtMoment || "Unknown Team";
      const pID = Number(play.playID);
      if (!teamBreakouts[tName]) {
        teamBreakouts[tName] = {
          name: tName,
          playCount: 0,
          mintCount: 0
        };
      }
      teamBreakouts[tName].playCount += 1;
      teamBreakouts[tName].mintCount += (playToMintsMap[pID] || 0);
    });

    const teamBreakoutsArr = Object.values(teamBreakouts).sort((a, b) => b.mintCount - a.mintCount);
    const jerseyNumbers = Array.from(jerseys).sort((a, b) => Number(a) - Number(b));

    return {
      name: filteredPlays[0].FullName || targetPlayerName,
      league,
      teams: Array.from(teams),
      jerseyNumbers,
      teamBreakouts: teamBreakoutsArr,
      // Mismint plays stay listed (flagged) but never count toward stats
      totalPlays: filteredPlays.filter((p) => !isMismintPlay(p.playID)).length,
      totalMints,
      totalOther,
      profile: {
        position,
        height,
        weight,
        birthdate,
        birthplace,
        experience,
        draftYear,
        draftRound,
        draftSelection,
        draftTeam
      },
      plays: filteredPlays,
      playToSetsMap,
      playToMintsMap,
      playToOtherMap,
      playToRetiredMap
    };
  }, [plays, sets, editions, targetPlayerName]);

  // Ownership summary for the browsed account over this player's plays
  // (mismints excluded, same as the header stats)
  const ownedPlayerSummary = useMemo(() => {
    if (!owned?.index || !playerContext) return null;
    const statPlays = playerContext.plays.filter((p) => !isMismintPlay(p.playID));
    if (statPlays.length === 0) return null;
    return summarizeOwnedPlays(
      owned.index,
      new Set(statPlays.map((p) => Number(p.playID))),
      new Map(statPlays.map((p) => [Number(p.playID), playSerialFacts(p)])),
      new Map(editions.map((e) => [String(e.id), Number(e.momentCount) || 0])),
      new Map(sets.map((s) => [Number(s.id), s.series != null ? Number(s.series) : null]))
    );
  }, [owned, playerContext, editions, sets]);

  // Table columns definition
  const columns = useMemo(() => {
    return [
      { key: "playID", text: "Play ID", sortValue: (_val, rec) => rec.playID_raw },
      { key: "TeamAtMoment", text: "Team" },
      { key: "PlayCategory", text: "Category" },
      { key: "NbaSeason", text: "Season" },
      // In account mode, sorting and column filters (e.g. ">0") use the
      // OWNED numerator, not the total; Mint Size sorts by percentage in % view
      { key: "MintSize", text: "Mint Size", align: "right", sortValue: (_val, rec) => (accountMode ? (pctMode ? (rec.MintSizeSort > 0 ? rec.MintSizeOwned / rec.MintSizeSort : 0) : rec.MintSizeOwned) : rec.MintSizeSort), filterValue: (_val, rec) => (accountMode ? rec.MintSizeOwned : rec.MintSizeSort), headerControl: accountMode ? <OwnedPctToggle /> : undefined },
      { key: "Status", text: "Status" },
      { key: "SetIDs", text: "Set Links" }
    ];
  }, [accountMode, pctMode]);

  // Format table rows
  const tableRecords = useMemo(() => {
    if (!playerContext) return [];

    let playsToRender = playerContext.plays;
    if (teamNbaIdParam) {
      playsToRender = playsToRender.filter(
        (play) => String(play.TeamAtMomentNBAID) === String(teamNbaIdParam)
      );
    }

    return playsToRender.map((play) => {
      const playID = play.playID;
      const isMismint = isMismintPlay(playID);
      const totalMints = playerContext.playToMintsMap[playID] || 0;
      const totalOther = playerContext.playToOtherMap[playID] || 0;
      const isRetired = playerContext.playToRetiredMap[playID] || false;

      // 1. Play details link
      const playIDLink = (
        <Link to={`/plays/${playID}`} className="player-detail-link" style={{ fontFamily: "var(--font-mono)", fontWeight: "600" }}>
          #{playID}
          {isMismint && <span className="mini-badge-mismint" title="This play is a mismint!">⚠️</span>}
        </Link>
      );

      // 2. Set Links element
      const matchingSets = playerContext.playToSetsMap[playID] || [];
      const setLinks = matchingSets.length > 0 ? (
        <div className="set-links-cell">
          {matchingSets.map((s, idx) => (
            <React.Fragment key={s.id}>
              {idx > 0 && ", "}
              <Link to={`/sets/${s.id}`} className="set-link" title={`${s.name} (Series ${s.series})`}>
                {s.id}
              </Link>
            </React.Fragment>
          ))}
        </div>
      ) : (
        <span className="text-muted">-</span>
      );

      // 3. Status badges
      const statusBadge = isRetired ? (
        <span className="badge badge-retired">Retired</span>
      ) : (
        <span className="badge badge-active">Active</span>
      );

      const ownedOfPlay = owned ? (owned.index?.byPlay.get(Number(playID)) || 0) : 0;

      return {
        ...play,
        playID: playIDLink,
        playID_raw: Number(playID),
        TeamAtMoment: play.TeamAtMoment
          ? renderEmojiName(getTeamEmoji(play.TeamAtMoment, play.TeamAtMomentNBAID), play.TeamAtMoment)
          : <span className="text-muted">-</span>,
        MintSize: owned
          ? <OwnedFraction owned={ownedOfPlay} total={totalMints} pct={pctMode} title={`${ownedOfPlay.toLocaleString()} of ${totalMints.toLocaleString()} moments owned`} />
          : <Supply shown={totalMints} other={totalOther} />,
        MintSizeSort: totalMints,
        MintSizeOwned: ownedOfPlay,
        Status: statusBadge,
        SetIDs: setLinks
      };
    });
  }, [playerContext, teamNbaIdParam, owned, pctMode]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Retrieving player profile and on-court metrics..." />;
  }

  if (!playerContext) {
    return (
      <div className="glass-panel text-center" style={{ padding: "60px 20px" }}>
        <h3>⚠️ Player Profile Not Found</h3>
        <p className="text-muted mt-8">
          No plays mapped to Player Name <strong>"{targetPlayerName}"</strong> were found.
          Make sure database sync has run successfully.
        </p>
        <Link to="/players" className="btn-primary mt-20" style={{ display: "inline-flex" }}>
          ← Back to Players Overview
        </Link>
      </div>
    );
  }

  const { profile } = playerContext;

  return (
    <div className="player-detail-container">
      {/* Back Navigation */}
      <div className="d-flex align-center gap-10" style={{ marginBottom: "20px" }}>
        <Link to="/players" className="text-muted">← Back to Players Overview</Link>
      </div>

      {/* Filter Alert Banner */}
      {teamNbaIdParam && (
        <div className="glass-panel filter-banner">
          <div className="d-flex align-center justify-between flex-wrap gap-10">
            <span className="filter-alert-text">
              Filtered by roster: Showing only <strong>{getTeamNameWithEmoji(filteredTeamDetails?.name || "selected team", teamNbaIdParam)}</strong> moments
            </span>
            <Link to={`/players/${playerName}`} className="btn-clear-filter font-hover-glow">
              Show All Moments ✖
            </Link>
          </div>
        </div>
      )}

      {/* Header Profile Dashboard */}
      <div className="glass-panel player-header-card mt-20">
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <div className="d-flex align-center gap-10 flex-wrap">
              <span className={`badge ${playerContext.league === "NBA" ? "badge-nba" : "badge-wnba"}`}>
                {playerContext.league}
              </span>
              {profile.position && <span className="badge badge-position">{profile.position}</span>}
            </div>
            <h1 className="player-title mt-8">{playerContext.name}</h1>
            <p className="text-muted mt-4" style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
              {playerContext.teams.length > 0 ? (
                playerContext.teams.map((t, idx) => (
                  <React.Fragment key={t}>
                    {idx > 0 && <span style={{ color: "var(--text-muted)", margin: "0 4px" }}>•</span>}
                    {renderTeamLink(t, teamNameMap, { style: { color: "var(--text-muted)" } })}
                  </React.Fragment>
                ))
              ) : (
                <span>-</span>
              )}
            </p>
          </div>
        </div>

        {/* Highlight Aggregations */}
        <div className="player-stats-row mt-30">
          {/* Browsing as an account the count reads owned/total, so the
              banner below never repeats it */}
          <div className="player-stat-item" title={ownedPlayerSummary ? "Plays with at least one owned moment, out of this player's plays" : undefined} style={ownedPlayerSummary ? { cursor: "help" } : undefined}>
            <span className="label">Plays</span>
            <span className="value">
              {ownedPlayerSummary ? (
                ownedPlayerSummary.totalPlays > 0 && ownedPlayerSummary.ownedPlays === ownedPlayerSummary.totalPlays ? (
                  <span className="owned-complete">{ownedPlayerSummary.ownedPlays}/{ownedPlayerSummary.totalPlays}<span className="owned-stat-check" title="Complete">✓</span></span>
                ) : <>{ownedPlayerSummary.ownedPlays}/{ownedPlayerSummary.totalPlays}</>
              ) : playerContext.totalPlays}
            </span>
          </div>
          <div className="player-stat-item">
            <span className="label"><SupplyWord remaining="Remaining" minted="Minted" /></span>
            <span className="value"><Supply shown={playerContext.totalMints} other={playerContext.totalOther} /></span>
          </div>
        </div>

        {ownedPlayerSummary && (
          <OwnedSummaryBanner
            summary={ownedPlayerSummary}
            link={`/account/${owned.address}?player=${encodeURIComponent(playerContext.name)}`}
          />
        )}
      </div>

      {/* Profile & Biography Details grids */}
      <div className="player-grids-row mt-20">
        {/* Profile Card */}
        <div className="glass-panel flex-1">
          <h3>Profile</h3>
          <div className="info-grid mt-20">
            <div className="info-row">
              <span className="info-label">Jersey Numbers</span>
              <span className="info-value font-mono">
                {playerContext.jerseyNumbers.length > 0 ? playerContext.jerseyNumbers.map(n => `#${n}`).join(", ") : "-"}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">Experience</span>
              <span className="info-value">
                {profile.experience ? `${profile.experience} Years` : "Rookie"}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">Height</span>
              <span className="info-value">{formatHeight(profile.height)}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Weight</span>
              <span className="info-value">{profile.weight ? `${profile.weight} lbs` : "-"}</span>
            </div>
          </div>
        </div>

        {/* Biography Card */}
        <div className="glass-panel flex-1">
          <h3>Biography</h3>
          <div className="info-grid mt-20">
            <div className="info-row">
              <span className="info-label">Birthdate</span>
              <span className="info-value">
                {/* calendarDateCell links only when a leading YYYY-MM-DD
                    parses; other formats used to produce
                    /calendar/undefined-undefined */}
                {profile.birthdate ? calendarDateCell(profile.birthdate, profile.birthdate, { bold: false }) : "-"}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">Birthplace</span>
              <span className="info-value">{profile.birthplace || "-"}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Draft Year</span>
              <span className="info-value">{profile.draftYear || "Undrafted"}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Draft Round</span>
              <span className="info-value">{profile.draftRound || "-"}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Draft Selection</span>
              <span className="info-value">
                {profile.draftSelection ? (profile.draftSelection.includes("/") ? profile.draftSelection : `Pick #${profile.draftSelection}`) : "-"}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">Drafting Team</span>
              <span className="info-value">{renderTeamLink(profile.draftTeam, teamNameMap)}</span>
            </div>
          </div>
        </div>

        {/* Team Breakouts Grid Panel */}
        {playerContext.teamBreakouts.length > 0 && (
          <div className="glass-panel flex-1" style={{ minWidth: "100%" }}>
            <h3>Teams</h3>
            <div className="team-breakouts-row mt-20">
              {playerContext.teamBreakouts.map((tb) => {
                const teamId = teamNameMap[tb.name.toLowerCase().trim()];
                return (
                  <div key={tb.name} className="team-breakout-card glass-panel">
                    <div className="tb-team-name">
                      {teamId ? (
                        <Link to={`/teams/${teamId}`} className="font-hover-glow" style={{ color: "#fff", fontWeight: "700", textDecoration: "none" }}>
                          {getTeamNameWithEmoji(tb.name, teamId)}
                        </Link>
                      ) : (
                        <span>{getTeamNameWithEmoji(tb.name)}</span>
                      )}
                    </div>
                    <div className="tb-stats-grid mt-12">
                      <div>
                        <span className="tb-label">Plays:</span>
                        <strong className="tb-val ml-4">{tb.playCount}</strong>
                      </div>
                      <div>
                        <span className="tb-label">Mints:</span>
                        <strong className="tb-val ml-4" style={{ color: "var(--primary-hover)" }}>{tb.mintCount.toLocaleString()}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Plays Editions Table */}
      <div className="glass-panel mt-20">
        <h3>Plays</h3>

        <div className="mt-20">
          <DataTable
            columns={columns}
            records={tableRecords}
            keyColumn="playID_raw"
            defaultSortColumn="playID"
            defaultSortOrder="desc"
          />
        </div>
      </div>

      <style>{`
        .player-detail-container {
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        }
        .player-header-card {
          padding: 32px;
          position: relative;
        }
        .badge-position {
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          font-weight: 600;
        }
        .jersey-badge {
          background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
          color: #fff;
          font-family: var(--font-mono);
          font-size: 0.8rem;
          font-weight: 700;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 8px var(--primary-glow);
          transition: var(--transition-smooth);
        }
        .jersey-badge:hover {
          transform: scale(1.1);
        }
        .player-stats-row {
          display: flex;
          align-items: center;
          gap: 40px;
          flex-wrap: wrap;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          padding-top: 24px;
        }
        .player-stat-item {
          display: flex;
          flex-direction: column;
        }
        .player-stat-item .label {
          font-size: 0.8rem;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .player-stat-item .value {
          font-size: 1.8rem;
          font-weight: 700;
          color: #fff;
        }
        .player-grids-row {
          display: flex;
          gap: 20px;
          flex-wrap: wrap;
        }
        .flex-1 {
          flex: 1;
          min-width: 320px;
        }
        .text-conflict {
          color: #f59e0b !important;
          font-weight: 600;
          font-style: italic;
        }
        .team-breakouts-row {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }
        .team-breakout-card {
          margin: 0;
          padding: 16px;
          border: 1px solid rgba(255,255,255,0.05);
        }
        .tb-team-name {
          font-weight: 700;
          font-size: 0.95rem;
          color: #fff;
        }
        .tb-stats-grid {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
          border-top: 1px solid rgba(255,255,255,0.04);
          padding-top: 8px;
        }
        .tb-label {
          color: var(--text-muted);
        }
        .tb-val {
          color: #fff;
        }
        .ml-4 {
          margin-left: 4px;
        }
        .badge-retired {
          background: rgba(245, 158, 11, 0.08);
          color: #f59e0b;
          border: 1px solid rgba(245, 158, 11, 0.2);
        }
        .badge-active {
          background: rgba(16, 185, 129, 0.08);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.2);
        }
        .filter-banner {
          background: rgba(245, 158, 11, 0.08);
          border: 1px solid rgba(245, 158, 11, 0.2);
          padding: 12px 20px;
          border-radius: 8px;
          display: block;
        }
        .filter-alert-text {
          color: #f59e0b;
          font-weight: 500;
          font-size: 0.95rem;
        }
        .btn-clear-filter {
          color: #fff;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          padding: 4px 12px;
          border-radius: 6px;
          font-size: 0.85rem;
          font-weight: 600;
          text-decoration: none;
          transition: var(--transition-smooth);
        }
        .btn-clear-filter:hover {
          background: rgba(255, 255, 255, 0.2);
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.1);
        }
      `}</style>
    </div>
  );
}
