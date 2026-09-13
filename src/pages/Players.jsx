import React, { useCallback, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getAllPlaysDB, getAllEditionsDB, getAllTeamsDB } from "../services/db.service";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { DataTable } from "../components/DataTable";
import { getTeamNameWithEmoji, getTeamEmoji, isMismintPlay, getPlayerHonors, getCalculatedPlayTags, buildTsdIndex, buildMintClock } from "../services/overrides.service";
import { supplyOf, otherSupplyOf } from "../services/supply.service";
import { Supply } from "../components/Supply";
import { buildTeamNameMap, isWnbaTeam, playerPath, ownedMintsColumn, ownedCountColumn, ALL_LEAGUE_OPTIONS } from "../utils/display.utils";
import { LeagueFilter } from "../components/LeagueFilter";
import { useUrlParam } from "../hooks/useUrlParam";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { useOwnedPct } from "../hooks/useOwnedPct";

// Stable empty fallbacks so memos keyed on the data slices do not churn
// while the first load is in flight
const NO_ROWS = [];
const NO_MAP = {};

// Player-level honor filters. hof/mvp/roy are absolute career facts from
// data/awards (a 2011 MVP matches with no 2011 moment); allstar and
// champion are derived from the player's moments, so a title winner with
// no moment from a title season does not match. Filters stack: a player
// must carry every selected honor. Everyone here was a rookie once, so no
// rookie filter.
const HONORS = [
  { key: "hof", label: "Hall of Fame", title: "Naismith Hall of Fame inductees (player category); a career honor, whatever moments they have" },
  { key: "mvp", label: "MVP", title: "Won a league MVP award, NBA or WNBA, in any season" },
  { key: "roy", label: "Rookie of the Year", title: "Won Rookie of the Year, NBA or WNBA" },
  { key: "allstar", label: "All-Star", title: "Has a moment with an All-Star squad" },
  { key: "champion", label: "Champion", title: "Has a moment from a season their team won the title" }
];
const HONOR_KEYS = new Set(HONORS.map((h) => h.key));

const parseHonors = (raw) =>
  new Set(String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter((k) => HONOR_KEYS.has(k)));

async function loadPlayersData() {
  const [dbPlays, dbEditions, dbTeams] = await Promise.all([
    getAllPlaysDB(),
    getAllEditionsDB(),
    getAllTeamsDB()
  ]);
  return { plays: dbPlays, editions: dbEditions, teamNameMap: buildTeamNameMap(dbTeams) };
}

export function Players() {
  const { data, loading, loadError, retry } = useDbData(loadPlayersData, "Could not read the players from the local database.");
  const plays = data ? data.plays : NO_ROWS;
  const editions = data ? data.editions : NO_ROWS;
  const teamNameMap = data ? data.teamNameMap : NO_MAP;
  const [selectedLeague, setSelectedLeague] = useUrlParam("league", "all", ["all", "nba", "wnba"]);
  // Multi-value honor selection, comma-joined in ?honors= (useUrlParam is
  // single-value); unknown keys read as unselected, none selected removes
  // the key
  const [searchParams, setSearchParams] = useSearchParams();
  const honorsRaw = searchParams.get("honors") || "";
  const selectedHonors = useMemo(() => parseHonors(honorsRaw), [honorsRaw]);
  const toggleHonor = useCallback((key) => {
    // Build from the LIVE location, not the router's copy: DataTable writes
    // its own params via history.replaceState, which the router never sees
    // (same caveat as useUrlParam)
    const params = new URLSearchParams(window.location.search);
    const current = parseHonors(params.get("honors"));
    if (current.has(key)) current.delete(key); else current.add(key);
    const next = HONORS.map((h) => h.key).filter((k) => current.has(k)).join(",");
    if (next) params.set("honors", next); else params.delete("honors");
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();

  // Aggregate stats by Player Name (FullName)
  const playersList = useMemo(() => {
    if (plays.length === 0) return [];

    // For the Champion honor: the Championship Year badge is computed per
    // play, so build the shared indexes once (both are cached on the plays
    // array) and stop checking a player once one play qualifies
    const tsdIndex = buildTsdIndex(plays);
    const mintClock = buildMintClock(plays);

    const playersMap = {};

    plays.forEach((play) => {
      // Mismint plays (plays_exclude.json) never count toward stats
      if (isMismintPlay(play.playID)) return;
      const name = play.FullName;
      const playID = play.playID;
      const teamName = play.TeamAtMoment;

      if (!name) return; // skip if no player name is found

      if (!playersMap[name]) {
        playersMap[name] = {
          name,
          playIDs: new Set(),
          teams: new Set(),
          league: "NBA", // fallback default
          champion: false
        };
      }

      if (playID) playersMap[name].playIDs.add(Number(playID));
      if (teamName) {
        playersMap[name].teams.add(teamName);
        if (isWnbaTeam(teamName)) {
          playersMap[name].league = "WNBA";
        }
      }
      if (!playersMap[name].champion && getCalculatedPlayTags(play, null, tsdIndex, mintClock).includes("Championship Year")) {
        playersMap[name].champion = true;
      }
    });

    // Sum supply per playID from the editions store, and the number
    // Settings does not show beside it, for the hover swap
    const editionsMap = {};
    const editionsOther = {};
    editions.forEach((ed) => {
      const pID = Number(ed.playID);
      editionsMap[pID] = (editionsMap[pID] || 0) + supplyOf(ed.momentCount, ed.setID, ed.playID);
      editionsOther[pID] = (editionsOther[pID] || 0) + otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
    });

    return Object.values(playersMap).map((player) => {
      // Sum mint sizes for all of this player's plays
      let totalMints = 0;
      let totalOther = 0;
      player.playIDs.forEach((pID) => {
        totalMints += (editionsMap[pID] || 0);
        totalOther += (editionsOther[pID] || 0);
      });

      const teams = Array.from(player.teams);
      const honors = getPlayerHonors(player.name);

      return {
        name: player.name,
        playCount: player.playIDs.size,
        playIDs: Array.from(player.playIDs),
        totalMints,
        totalOther,
        league: player.league,
        teams,
        hof: honors.hof,
        mvp: honors.mvp,
        roy: honors.roy,
        allStar: teams.some((t) => getTeamEmoji(t, teamNameMap[t.toLowerCase().trim()]) === "⭐"),
        champion: player.champion
      };
    });
  }, [plays, editions, teamNameMap]);

  // Define columns for DataTable
  const columns = useMemo(() => {
    return [
      { key: "FullName", text: "Player Name" },
      { key: "League", text: "League" },
      // In account mode, sorting and column filters (e.g. ">0") use the
      // OWNED numerator, not the total; Mints sorts by percentage in % view
      ownedCountColumn({ key: "PlayCount", text: "Plays", totalField: "PlayCountSort", ownedField: "PlayCountOwned", accountMode }),
      ownedMintsColumn({ key: "TotalMints", text: "Mints", totalField: "TotalMintsSort", ownedField: "TotalMintsOwned", accountMode, pctMode }),
      { key: "Teams", text: "Teams" }
    ];
  }, [accountMode, pctMode]);

  // Filter players on the league selector and the honor toggles (honors
  // stack: every selected one must apply)
  const filteredPlayers = useMemo(() => {
    return playersList.filter((player) => {
      if (selectedLeague === "nba" && player.league !== "NBA") return false;
      if (selectedLeague === "wnba" && player.league !== "WNBA") return false;
      if (selectedHonors.has("hof") && !player.hof) return false;
      if (selectedHonors.has("mvp") && !player.mvp) return false;
      if (selectedHonors.has("roy") && !player.roy) return false;
      if (selectedHonors.has("allstar") && !player.allStar) return false;
      if (selectedHonors.has("champion") && !player.champion) return false;
      return true;
    });
  }, [playersList, selectedLeague, selectedHonors]);

  // Format table rows
  const tableRecords = useMemo(() => {
    return filteredPlayers.map((player) => {
      const playerLink = (
        <Link to={playerPath(player.name)} className="player-detail-link">
          {player.name}
        </Link>
      );

      const leagueBadge = (
        <span className={`badge ${player.league === "NBA" ? "badge-nba" : "badge-wnba"}`}>
          {player.league}
        </span>
      );

      // All-Star squads (Team LeBron, Team Wilson, ...) sort after the
      // real franchises and carry an (All-Star) note; the sort is stable,
      // so the franchise order itself is untouched
      const teamsList = (player.teams || [])
        .map((teamName) => {
          const teamId = teamNameMap[teamName.toLowerCase().trim()];
          return { teamName, teamId, allStar: getTeamEmoji(teamName, teamId) === "⭐" };
        })
        .sort((a, b) => Number(a.allStar) - Number(b.allStar));
      const chunks = [];
      for (let i = 0; i < teamsList.length; i += 3) {
        chunks.push(teamsList.slice(i, i + 3));
      }

      const teamsCell = teamsList.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {chunks.map((chunk, cIdx) => (
            <div key={cIdx} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              {chunk.map(({ teamName, teamId, allStar }, idx) => {
                const nameWithEmoji = getTeamNameWithEmoji(teamName, teamId);
                const label = (
                  <>
                    {nameWithEmoji}
                    {allStar && <span className="text-muted" style={{ fontWeight: 400 }}> (All-Star)</span>}
                  </>
                );
                return (
                  <React.Fragment key={teamName}>
                    {idx > 0 && <span style={{ color: "var(--text-muted)", marginRight: "4px" }}>,</span>}
                    {teamId ? (
                      <Link to={`/teams/${teamId}`} className="font-hover-glow" style={{ color: "#fff", fontWeight: "500", textDecoration: "none", whiteSpace: "nowrap" }}>
                        {label}
                      </Link>
                    ) : (
                      <span style={{ whiteSpace: "nowrap" }}>{label}</span>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <span className="text-muted">-</span>
      );

      // Owned-as-account annotations: distinct plays owned / total plays,
      // and moments owned / total mints
      let playCountCell = player.playCount;
      let mintsCell = <Supply shown={player.totalMints} other={player.totalOther} />;
      let ownedPlaysNum = 0, ownedMintsNum = 0;
      if (owned) {
        const byPlay = owned.index?.byPlay;
        player.playIDs.forEach((pID) => {
          const n = byPlay ? (byPlay.get(Number(pID)) || 0) : 0;
          if (n > 0) ownedPlaysNum++;
          ownedMintsNum += n;
        });
        playCountCell = <OwnedFraction owned={ownedPlaysNum} total={player.playCount} greenWhenFull title={`${ownedPlaysNum} of ${player.playCount} plays owned`} />;
        mintsCell = <OwnedFraction owned={ownedMintsNum} total={player.totalMints} pct={pctMode} title={`${ownedMintsNum.toLocaleString()} of ${player.totalMints.toLocaleString()} moments owned`} />;
      }

      return {
        name: player.name, // retained for key identification
        FullName: playerLink,
        League: leagueBadge,
        PlayCount: playCountCell,
        PlayCountSort: player.playCount,
        PlayCountOwned: ownedPlaysNum,
        TotalMints: mintsCell,
        TotalMintsSort: player.totalMints,
        TotalMintsOwned: ownedMintsNum,
        Teams: teamsCell
      };
    });
  }, [filteredPlayers, teamNameMap, owned, pctMode]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Loading and indexing players registry..." />;
  }

  return (
    <div className="players-page-container">
      {/* Page Header */}
      <div className="glass-panel info-banner">
        <h2>Players</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Everyone with a moment, NBA and WNBA. Open a player for their plays, teams, badges and bio.
        </p>
      </div>

      {/* Main Players DataTable */}
      <div className="glass-panel mt-20">
        <LeagueFilter
          options={ALL_LEAGUE_OPTIONS}
          selected={selectedLeague}
          onSelect={setSelectedLeague}
        >
          {/* Multi-toggle, unlike the league segment: several honors can
              be lit at once and each narrows further */}
          <span className="text-muted" style={{ fontSize: "0.9rem", fontWeight: "600" }} title="Filters stack: a player must carry every selected honor">Honors:</span>
          <div style={{ display: "flex", gap: "6px", background: "rgba(0,0,0,0.2)", padding: "4px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)", flexWrap: "wrap" }}>
            {HONORS.map((h) => (
              <button
                key={h.key}
                onClick={() => toggleHonor(h.key)}
                title={h.title}
                aria-pressed={selectedHonors.has(h.key)}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: selectedHonors.has(h.key) ? "var(--primary)" : "transparent",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: "600",
                  fontSize: "0.85rem",
                  transition: "background 0.2s",
                  whiteSpace: "nowrap"
                }}
              >
                {h.label}
              </button>
            ))}
          </div>
        </LeagueFilter>

        <DataTable
          columns={columns}
          records={tableRecords}
          keyColumn="name"
          defaultSortColumn="PlayCount"
          defaultSortOrder="desc"
        />
      </div>
    </div>
  );
}
