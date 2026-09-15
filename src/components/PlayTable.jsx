import { Link } from "react-router-dom";
import { Badges } from "./Badges";
import { editionsColumn, editionRowFacts, setsByIdDesc } from "./EditionsColumn";
import { parseMomentDate, isMismintPlay, getCalculatedPlayTags, withTags, playEditionTags, playRewardEditions } from "../services/overrides.service";
import { playHasCommentary, withCommentary } from "../services/commentary.service";
import { scrubSentinels, blankZeroedFields, buildMatchupSides, renderMatchupCell, formatDateISO, seasonHintForPlay, getSeasonFallback, renderSeasonChip, playerPath, buildPlayToSets } from "../utils/display.utils";
import { toQuery } from "../utils/query";

/*
 * The one-row-per-play table (Plays, an arena's plays): its columns and
 * its row builder, so every page that lists plays reads the same way.
 * Columns: Owned (while browsing as an account), Editions, Player Name
 * with badges, Category, Date, Matchup. A row opens its edition when the
 * play has exactly one (see EditionsColumn).
 */

export { buildPlayToSets };

/**
 * The Owned column, only while browsing as an account: how many of this
 * play's moments the address owns, across every set and parallel. The
 * count opens the collection filtered to this play (and its set, when it
 * has one); the cell stays out of the row's own click. In the Missing
 * view (the column's filter is "0") a zero reads as 0, not as a dot.
 */
export function ownedPlaysColumn() {
  return {
    key: "Owned",
    text: "Owned",
    align: "right",
    noRowClick: true,
    sortValue: (_val, rec) => rec.Owned,
    render: (val, rec, { filters } = {}) => (val > 0
      ? <Link to={rec.ownedTo} className="font-mono" style={{ color: "#fff", fontWeight: 600 }} title="Open these moments in the collection">{Number(val).toLocaleString()}</Link>
      : <span className="text-muted font-mono">{filters && filters.Owned === "0" ? "0" : "·"}</span>)
  };
}

/** The record fields behind the Owned column: the count and its link */
export function ownedPlayFacts(playID, matchingSets, owned) {
  if (!owned) return { Owned: undefined, ownedTo: null };
  const params = new URLSearchParams({ play: String(playID) });
  if (matchingSets.length === 1) params.set("set", String(matchingSets[0].id));
  return {
    Owned: owned.index?.byPlay.get(Number(playID)) || 0,
    ownedTo: `/account/${owned.address}?${toQuery(params)}`
  };
}

export function playTableColumns({ teamNameMap, owned }) {
  return [
    ...(owned ? [ownedPlaysColumn()] : []),
    editionsColumn(),
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
}

/**
 * One table record from a compiled play. ctx: playToSets (buildPlayToSets),
 * seriesSeasonMap (buildSeriesSeasonMap), tsdIndex and mintClock (over ALL
 * plays, so badges never depend on the page's filter), owned (the account
 * collection hook's value, or null).
 */
export function buildPlayRecord(meta, { playToSets, seriesSeasonMap, tsdIndex, mintClock, owned }) {
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

  // Highest set id first, the descending order of the edition column;
  // the season hint below keeps the store's order (lowest set first)
  const storeSets = playToSets[playID] || [];
  const matchingSets = setsByIdDesc(storeSets);

  // Format local moment date display string (for search)
  let DateOfMomentLocal = "";
  let seasonFallback = null;
  if (metadata.DateOfMoment) {
    const dObj = parseMomentDate(metadata.DateOfMoment);
    DateOfMomentLocal = dObj ? formatDateISO(dObj) : metadata.DateOfMoment;
  } else {
    seasonFallback = getSeasonFallback(metadata, seasonHintForPlay(metadata, storeSets, seriesSeasonMap));
    // Searchable text for the chip ("2022-23 season" matches searches)
    if (seasonFallback) DateOfMomentLocal = `${seasonFallback.season} season`;
  }

  // Edition-level badges, by the set that earned them: the hover text
  // per badge ("Challenge Reward: Holo MMXX (4_133)") and the marks
  // beside the set names
  const rewardEditions = playRewardEditions(playID);
  let badgeTitles = null, rewardBySet = null;
  if (rewardEditions.length > 0) {
    badgeTitles = {}; rewardBySet = {};
    const setName = (sid) => (matchingSets.find((s) => Number(s.id) === sid) || {}).name || `Set ${sid}`;
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
    ...editionRowFacts(matchingSets, playID),
    ...ownedPlayFacts(playID, matchingSets, owned),
    badgeTitles,
    rewardBySet,
    DateOfMomentLocal,
    seasonFallback,
    matchup,
    // Derived tags (badges on the front end), from the compiled play, plus
    // the edition-level tags of any of its editions (reward sets), plus
    // Commentary when any edition of the play has a narrated cut
    badges: withCommentary(withTags(getCalculatedPlayTags(meta, null, tsdIndex, mintClock), playEditionTags(playID)), playHasCommentary(playID))
  };
}
