import { Link } from "react-router-dom";
import leagues from "../../data/leagues.json";
import { getTeamEmoji, resolveVenue, parseMomentDate, getAdditionsTeamNameMap, isHistoricalTeamName, isSentinelValue } from "../services/overrides.service";
import { OwnedPctToggle } from "../components/OwnedFraction";

/**
 * Shared page-level display helpers. These were previously duplicated (with
 * slight drift) across most pages; every page now imports them from here.
 */

/**
 * Player detail route for a player name: spaces become underscores, then
 * URL-encoded. Previously written out inline at 14 call sites in 11 files
 * (a couple of which forgot the trim). playerNameFromParam is the decode
 * twin used by the route itself.
 */
export function playerPath(name) {
  return `/players/${encodeURIComponent(String(name).trim().replace(/\s+/g, "_"))}`;
}

export function playerNameFromParam(param) {
  if (!param) return "";
  return decodeURIComponent(param).replace(/_/g, " ").trim();
}

/**
 * USD with thousands separators, cents kept ("$1,234.50"). For whole-dollar
 * amounts prefer formatOfferAmount in offers.service (that one drops cents).
 */
export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Compact relative age from a millisecond delta: "12s", "5m", "3h", "2d".
 */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Color for an IPFS coverage percentage: green when complete, red when
 * nothing, amber in between (the Sets page convention, also used by Home).
 */
export function coveragePctColor(pct) {
  return pct >= 100 ? "var(--status-success)" : pct === 0 ? "var(--status-danger)" : "var(--status-mismint)";
}

/** The standard All/NBA/WNBA LeagueFilter options (three pages shared it). */
export const ALL_LEAGUE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "nba", label: "NBA" },
  { value: "wnba", label: "WNBA" }
];

/** "MM-DD" calendar key from a date string's leading YYYY-MM-DD, or null. */
export function calendarKey(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : null;
}

/**
 * Calendar-linked date cell: the visible label links to /calendar/MM-DD.
 * With hiddenSortValue, the raw string rides along invisibly so
 * DataTable's text index sorts and searches on the full ISO value (the
 * trick Plays and ArenaDetail each hand-rolled). Returns the plain label
 * when the date has no leading YYYY-MM-DD to key on.
 */
export function calendarDateCell(rawDate, label, { hiddenSortValue = null, bold = true } = {}) {
  const key = calendarKey(rawDate);
  const text = label ?? String(rawDate || "-");
  if (!key) return text;
  return (
    <Link to={`/calendar/${key}`} className="date-calendar-link font-hover-glow" style={{ textDecoration: "none" }}>
      {hiddenSortValue != null && <span style={{ display: "none" }}>{hiddenSortValue}</span>}
      <span style={bold ? { fontWeight: "600" } : undefined}>{text}</span>
    </Link>
  );
}

/**
 * DataTable column for an owned/total mints fraction. The app-wide rule,
 * previously restated verbatim on six columns: in account mode, sorting
 * and column filters (e.g. ">0") use the OWNED numerator, not the total,
 * except % view sorts by the percentage; the header carries the % toggle.
 */
export function ownedMintsColumn({ key, text, totalField, ownedField, accountMode, pctMode, align = "right", ...rest }) {
  return {
    key,
    text,
    align,
    sortValue: (_val, rec) => (accountMode
      ? (pctMode ? (rec[totalField] > 0 ? (rec[ownedField] || 0) / rec[totalField] : 0) : (rec[ownedField] || 0))
      : rec[totalField]),
    filterValue: (_val, rec) => (accountMode ? (rec[ownedField] || 0) : rec[totalField]),
    headerControl: accountMode ? <OwnedPctToggle /> : undefined,
    ...rest
  };
}

/**
 * The simpler owned/total count column (no % view): sort and filter on
 * the owned numerator in account mode, the total otherwise.
 */
export function ownedCountColumn({ key, text, totalField, ownedField, accountMode, align = "right", ...rest }) {
  return {
    key,
    text,
    align,
    sortValue: (_val, rec) => (accountMode ? (rec[ownedField] || 0) : rec[totalField]),
    filterValue: (_val, rec) => (accountMode ? (rec[ownedField] || 0) : rec[totalField]),
    ...rest
  };
}

/**
 * Player-or-team name cell (the shape Plays and Calendar each carried a
 * copy of): a named player links to their player page; a team moment
 * links to the team page when the team resolves, else to the play page.
 */
export function renderPlayerNameCell(meta, { playID, teamNameMap }) {
  const playerName = (meta?.FullName || "").trim();
  const teamName = (meta?.TeamAtMoment || "").trim();
  const displayName = playerName || teamName || "Team Moment";
  const teamId = !playerName && teamName ? teamNameMap[teamName.toLowerCase()] : null;
  const target = playerName
    ? playerPath(playerName)
    : (teamId ? `/teams/${teamId}` : `/plays/${playID}`);
  return (
    <Link to={target} style={{ fontWeight: "600" }} className="player-detail-link font-hover-glow">
      {displayName}
    </Link>
  );
}

/**
 * Builds the sides object for renderMatchupCell from a play's raw fields,
 * resolving team ids via a teamNameMap and emojis via getTeamEmoji.
 *
 * With resolveHistoricalName, each side is labelled with the franchise name as
 * it stood on dateOfMoment (so an old play reads "Charlotte Bobcats", not the
 * current name). rawName keeps the on-chain string so the team-at-moment match
 * in renderMatchupCell still lands after a rename.
 */
export function buildMatchupSides(play, teamNameMap, options = {}) {
  const { resolveHistoricalName = false, dateOfMoment = null } = options;

  const makeSide = (role, name, score) => {
    if (!name || String(name).trim() === "") return null;
    const rawName = String(name).trim();
    const teamId = teamNameMap[rawName.toLowerCase()];
    // A historical franchise name keeps its era spelling; resolving it
    // would rename "Washington Bullets" to the current franchise name
    const resolved = resolveHistoricalName && teamId && !isHistoricalTeamName(rawName)
      ? resolveVenue(teamId, dateOfMoment)
      : null;
    const displayName = resolved && resolved.name ? resolved.name : rawName;
    return { role, name: displayName, rawName, score, teamId, emoji: getTeamEmoji(displayName, teamId) };
  };

  return {
    away: makeSide("away", play.AwayTeamName, play.AwayTeamScore),
    home: makeSide("home", play.HomeTeamName, play.HomeTeamScore),
    teamAtMoment: play.TeamAtMoment
  };
}

/**
 * Stacked box-score cell: away team on top, home below (US convention), a
 * green arrow marking the winner, and the player's team-at-moment styled with
 * the accent color + dotted underline. Sides carry { name, score, teamId,
 * emoji }; either may be null. Styling lives in index.css (.matchup-*).
 */
export function renderMatchupCell({ away, home, teamAtMoment }) {
  const sides = [away, home].filter((s) => s && s.name && String(s.name).trim() !== "");
  if (sides.length === 0) return <span className="text-muted">-</span>;

  const scoreA = parseInt(away?.score);
  const scoreH = parseInt(home?.score);
  const hasWinner = !isNaN(scoreA) && !isNaN(scoreH) && scoreA !== scoreH;
  if (away) away.isWinner = hasWinner && scoreA > scoreH;
  if (home) home.isWinner = hasWinner && scoreH > scoreA;

  return (
    <div className="matchup-cell">
      {sides.map((side) => {
        const wanted = String(teamAtMoment || "").trim().toLowerCase();
        const isTeamAtMoment = wanted !== "" &&
          [side.rawName, side.name].some((n) => String(n || "").trim().toLowerCase() === wanted);
        // The player's team gets the accent treatment; the opponent is muted
        // like a losing score, so white never falsely reads as "winner".
        const nameStyle = isTeamAtMoment
          ? { color: "var(--primary-hover)", fontWeight: "700", textDecoration: "underline dotted", textUnderlineOffset: "3px" }
          : { color: "var(--text-muted)", fontWeight: "500", textDecoration: "none" };

        return (
          <div className="matchup-row" key={side.role || side.name}>
            <span className="matchup-emoji">{side.emoji || ""}</span>
            <span className="matchup-team" title={isTeamAtMoment ? "Player's team at moment" : undefined}>
              {side.teamId ? (
                <Link to={`/teams/${side.teamId}`} className="font-hover-glow" style={nameStyle}>{side.name}</Link>
              ) : (
                <span style={nameStyle}>{side.name}</span>
              )}
            </span>
            <span className={`matchup-score ${side.isWinner ? "matchup-score-winner" : ""}`}>
              {side.score !== undefined && side.score !== null && String(side.score).trim() !== "" ? side.score : ""}
            </span>
            <span className="matchup-arrow">{side.isWinner ? "◄" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Maps rows from getAllTeamsDB() into a { "team name lowercased": nbaID }
 * lookup used to build /teams/:id links from on-chain team name strings.
 */
export function buildTeamNameMap(teams) {
  // Seed with curated names from teams.json (historical franchise names
  // included, so "Washington Bullets" links and gets its emoji), then let
  // the synced teams store overlay anything it knows
  const map = { ...getAdditionsTeamNameMap() };
  (teams || []).forEach((t) => {
    const name = t.TeamName || t.TeamAtMoment;
    if (name) {
      map[name.trim().toLowerCase()] = t.TeamAtMomentNBAID;
    }
  });
  return map;
}

export function isWnbaTeam(teamName) {
  if (!teamName) return false;
  const cleanTeam = String(teamName).trim().toLowerCase();
  return leagues.wnba.some((t) => t.toLowerCase() === cleanTeam);
}

export function isNbaTeam(teamName) {
  if (!teamName) return false;
  const cleanTeam = String(teamName).trim().toLowerCase();
  return leagues.nba.some((t) => t.toLowerCase() === cleanTeam);
}

/**
 * League for aggregation pages: every non-WNBA team is treated as NBA,
 * matching how the team/player indexes bucket their records.
 */
export function getLeagueName(teamName) {
  return isWnbaTeam(teamName) ? "WNBA" : "NBA";
}

/** League badge for detail pages; null when the team is in neither list. */
export function getLeagueBadge(teamName, to) {
  const league = isNbaTeam(teamName) ? "NBA" : isWnbaTeam(teamName) ? "WNBA" : null;
  if (!league) return null;
  const cls = `badge badge-${league.toLowerCase()}`;
  return to
    ? <Link to={to} className={`${cls} badge-link`} title={`Click to see ${league} moments`}>{league}</Link>
    : <span className={cls}>{league}</span>;
}

/**
 * Emoji + name as structured markup (styles: .emoji-name in index.css).
 * The name is its own flex item, so when it wraps the second line starts
 * under the text, never under the emoji, and the emoji rides slightly
 * larger and vertically centered to fill a two-line name. Falls back to
 * the bare name when there is no emoji.
 */
export function renderEmojiName(emoji, name) {
  if (!emoji) return name;
  return (
    <span className="emoji-name">
      <span className="emoji-name-emoji">{emoji}</span>
      <span className="emoji-name-text">{name}</span>
    </span>
  );
}

/**
 * Renders a team name as a /teams/:id link when the name resolves through
 * teamNameMap, otherwise as plain text. Options:
 * - isHighlight: primary-color emphasis (team-at-moment rows)
 * - emojiStar: suffix appended after the name
 * - style: extra inline styles merged over the defaults
 * - resolveHistoricalName + dateOfMoment: display the canonical team name
 *   resolved through the temporal venue config for that game date
 */
export function renderTeamLink(teamName, teamNameMap, options = {}) {
  const {
    isHighlight = false,
    emojiStar = "",
    style = {},
    dateOfMoment = null,
    resolveHistoricalName = false
  } = options;

  if (!teamName) return "-";
  const cleanName = String(teamName).trim();
  const teamId = teamNameMap ? teamNameMap[cleanName.toLowerCase()] : undefined;

  const resolved = resolveHistoricalName && teamId && !isHistoricalTeamName(cleanName)
    ? resolveVenue(teamId, dateOfMoment)
    : null;
  const displayName = resolved && resolved.name ? resolved.name : cleanName;
  const emoji = getTeamEmoji(displayName, teamId);
  const suffix = emojiStar ? ` ${emojiStar}` : "";
  const content = renderEmojiName(emoji, <>{displayName}{suffix}</>);

  if (teamId) {
    return (
      <Link
        to={`/teams/${teamId}`}
        className="font-hover-glow"
        style={{
          color: isHighlight ? "var(--primary-hover)" : "#fff",
          fontWeight: isHighlight ? "600" : "500",
          textDecoration: "none",
          ...style
        }}
      >
        {content}
      </Link>
    );
  }
  return <span style={style}>{content}</span>;
}

/**
 * Sort key for edition ids ("setID_playID[_subeditionID]"): each numeric
 * group zero-padded so plain string comparison orders by set id, then play
 * id, then subedition id (a missing subedition sorts before subedition 0).
 */
export function editionSortKey(...ids) {
  return ids
    .filter((v) => v !== undefined && v !== null && v !== "")
    .map((v) => String(v).padStart(8, "0"))
    .join("_");
}

/**
 * App-wide date format: YYYY-MM-DD (local time). Sites with the original
 * "YYYY-MM-DD ..." string can slice it directly; this covers Date objects.
 */
export function formatDateISO(dObj) {
  if (!(dObj instanceof Date) || isNaN(dObj)) return "";
  const y = dObj.getFullYear();
  const m = String(dObj.getMonth() + 1).padStart(2, "0");
  const d = String(dObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * "2021-01-20 · Jump Shot" from a play's metadata (account pages); the
 * pieces degrade independently: date alone, category alone, or a play id
 * fallback when the metadata carries neither.
 */
export function playSummary(meta, playID) {
  const category = (meta?.PlayCategory || meta?.PlayType || "").trim();
  const raw = meta?.DateOfMoment;
  const date = raw ? (formatDateISO(parseMomentDate(raw)) || String(raw).slice(0, 10)) : "";
  return [date, category].filter(Boolean).join(" · ") || `Play #${playID}`;
}

/**
 * TopShotLocking state cell: null/undefined expiry = not locked (empty
 * cell); a PAST expiry means the lock has run out but the owner has not
 * sent the unlock transaction yet, so it shows as unlockable.
 */
export function lockCell(lockExpiry) {
  if (lockExpiry === null || lockExpiry === undefined) return "";
  const ms = parseFloat(lockExpiry) * 1000;
  const remain = ms - Date.now();
  const exact = new Date(ms).toLocaleString();
  if (remain <= 0) {
    // Key alone = unlockable (lock expired, not unlocked yet); the word
    // was dropped
    return <span title={`Lock expired ${exact}; the owner has not unlocked it yet`}>🔑</span>;
  }
  const days = Math.floor(remain / 86400000);
  const hours = Math.floor((remain % 86400000) / 3600000);
  const label = days >= 1 ? `${days}d ${hours}h` : (hours >= 1 ? `${hours}h ${Math.floor((remain % 3600000) / 60000)}m` : `${Math.max(1, Math.floor(remain / 60000))}m`);
  return <span title={`Locked until ${exact}`}>🔒 {label}</span>;
}

/**
 * Season fallback for undated plays. Some plays (Series 4 team reels,
 * redemptions, season awards) carry no DateOfMoment; instead of fabricating
 * a date, the UI shows their season in a chip and sorts them at the tail of
 * that season, where such moments actually drop. NBA seasons read
 * "2022-23" (sort instant: Jun 1 of the closing year), WNBA seasons are the
 * single year "2022" (Sep 1), Summer League "2021 Summer League" (Jul 15).
 * The sortDate is a synthetic sort key ONLY: it must never be written into
 * DateOfMoment or shown as a real date.
 */
export function getSeasonFallback(play, seasonHint) {
  if (play.DateOfMoment) return null;
  const season = String(play.NbaSeason || seasonHint || "").trim();
  if (!season) return null;
  const nba = season.match(/^(\d{4})-\d{2}$/);
  const summer = season.match(/^(\d{4})\s+Summer League$/i);
  const single = season.match(/^(\d{4})$/);
  let sortDate;
  if (nba) {
    const endYear = Number(nba[1]) + 1; // "1999-00" closes in 2000
    sortDate = `${endYear}-06-01 00:00:00 EST`;
  } else if (summer) {
    sortDate = `${summer[1]}-07-15 00:00:00 EST`;
  } else if (single) {
    sortDate = `${single[1]}-09-01 00:00:00 EST`;
  } else {
    return null;
  }
  return { season, sortDate };
}

/**
 * Majority NbaSeason per series id, split by league format, from the plays
 * that DO carry a season. Undated plays with no season of their own (the
 * Series 4 team reels) borrow their series' majority season, so future
 * series need no hand-kept table.
 */
export function buildSeriesSeasonMap(plays, playToSets) {
  const tally = {};
  plays.forEach((p) => {
    const season = String(p.NbaSeason || "").trim();
    if (!season) return;
    (playToSets[p.playID] || []).forEach((s) => {
      if (s.series === undefined || s.series === null) return;
      const t = (tally[s.series] = tally[s.series] || {});
      t[season] = (t[season] || 0) + 1;
    });
  });
  const map = {};
  Object.entries(tally).forEach(([seriesId, counts]) => {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const nbaTop = sorted.find(([s]) => /^\d{4}-\d{2}$/.test(s));
    const wnbaTop = sorted.find(([s]) => /^\d{4}$/.test(s));
    map[seriesId] = { nba: nbaTop ? nbaTop[0] : "", wnba: wnbaTop ? wnbaTop[0] : "" };
  });
  return map;
}

/** Series-majority season matching the play's league (WNBA plays prefer the
 *  single-year format); "" when the series has no season data at all. */
export function seasonHintForPlay(play, matchingSets, seriesSeasonMap) {
  const wnba = isWnbaTeam(play.TeamAtMoment);
  for (const s of matchingSets || []) {
    const entry = seriesSeasonMap[s.series];
    if (!entry) continue;
    const hint = wnba ? (entry.wnba || entry.nba) : (entry.nba || entry.wnba);
    if (hint) return hint;
  }
  return "";
}

/** Dimmed, dashed pill for a season-only date cell: unmistakably not a real
 *  date. */
export function renderSeasonChip(fallback) {
  return (
    <span className="season-chip" title={`No exact date; from the ${fallback.season} season`}>
      {fallback.season}
    </span>
  );
}

/**
 * Builds an X (formerly Twitter) geo search URL for posts near an arena on
 * a game day: the `geocode:lat,lng,radius` operator with a one-day
 * since/until window, replies out. Empty for a game before X existed
 * (public launch 2006-07-15): there is nothing to find.
 */
const X_LAUNCH = new Date(2006, 6, 15);
export function getArenaTwitterURL(arena, dateStr) {
  if (!arena || !arena.lat || !arena.lng || !dateStr) return "";
  const dateObj = parseMomentDate(dateStr);
  if (!dateObj || dateObj < X_LAUNCH) return "";

  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const dateStart = `${yyyy}-${mm}-${dd}`;

  const nextDate = new Date(dateObj);
  nextDate.setDate(nextDate.getDate() + 1);
  const yyyy2 = nextDate.getFullYear();
  const mm2 = String(nextDate.getMonth() + 1).padStart(2, "0");
  const dd2 = String(nextDate.getDate()).padStart(2, "0");
  const dateEnd = `${yyyy2}-${mm2}-${dd2}`;

  const query = `geocode:${arena.lat},${arena.lng},.2km since:${dateStart} until:${dateEnd} -filter:replies`;
  const params = new URLSearchParams({
    q: query,
    src: "typed_query"
  });

  return `https://x.com/search?${params.toString()}`;
}

/** Formats a height in inches as "6 ft 7 in". */
export function formatHeight(heightInches) {
  if (!heightInches) return "-";
  const num = parseInt(heightInches);
  if (isNaN(num) || num <= 0) return heightInches;
  const feet = Math.floor(num / 12);
  const inches = num % 12;
  return `${feet} ft ${inches} in`;
}

/** Tier palette shared by the home matrices and the Sets page. Rarest first. */
export const TIER_ORDER = ["Ultimate", "Legendary", "Rare", "Fandom", "Common", "Unknown"];

// Facet dropdowns list commonest first; derived from TIER_ORDER so the
// two orderings can never drift. Unknown values sort last.
const TIER_FACET_ORDER = TIER_ORDER.filter((t) => t !== "Unknown").reverse();
export const tierFacetRank = (t) => {
  const i = TIER_FACET_ORDER.indexOf(t);
  return i === -1 ? TIER_FACET_ORDER.length : i;
};
export const TIER_COLORS = {
  Ultimate: "#c084fc",
  Legendary: "#f87171",
  Rare: "#facc15",
  Fandom: "#4ade80",
  Common: "#94a3b8",
  Unknown: "#475569"
};

/** Badge class for the off-chain tier attribute. */
export function getTierBadgeClass(tier) {
  const t = String(tier || "").toLowerCase();
  if (t === "legendary") return "badge-danger";
  if (t === "rare") return "badge-warning";
  if (t === "fandom") return "badge-success";
  return "badge-standard";
}

/** Returns a copy with "<invalid Value>" / "N/A" sentinel values blanked. */
export function scrubSentinels(obj) {
  const result = { ...obj };
  for (const key in result) {
    if (isSentinelValue(result[key])) {
      result[key] = "";
    }
  }
  return result;
}

/** Returns a copy with the listed numeric fields blanked when they parse to 0. */
export function blankZeroedFields(obj, keys) {
  const result = { ...obj };
  keys.forEach((key) => {
    if (parseInt(result[key]) === 0) {
      result[key] = "";
    }
  });
  return result;
}
