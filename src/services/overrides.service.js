import setsOverrides from "../../data/overrides/sets.json";
import playsOverrides from "../../data/overrides/plays.json";
import seriesOverrides from "../../data/overrides/series.json";

import setsAdditions from "../../data/additions/sets.json";
import playsAdditions from "../../data/additions/plays.json";
import seriesAdditions from "../../data/additions/series.json";
import editionsAdditions from "../../data/additions/editions.json";
import teamsAdditions from "../../data/additions/teams.json";
import seasonsAdditions from "../../data/additions/seasons.json";
import playsExclude from "../../data/plays_exclude.json";
import hallOfFame from "../../data/awards/hall_of_fame.json";
import mvpAwards from "../../data/awards/mvp.json";
import royAwards from "../../data/awards/roy.json";
import rookieSeasons from "../../data/additions/rookie_seasons.json";
import { toHouseBirthplace } from "./birthplace.normalizer";
import { normPlayerName } from "./name-norm";
import { playSigned } from "./autograph.service";

// The disable_overrides flag is read once and cached: the override appliers run
// per record over thousands of records, and a synchronous localStorage read on
// every record is measurable. Settings calls refreshOverridesDisabledCache()
// when the flag changes.
let overridesDisabledCache = null;

export function areOverridesDisabled() {
  if (overridesDisabledCache === null) {
    try {
      overridesDisabledCache = localStorage.getItem("disable_overrides") === "true";
    } catch {
      overridesDisabledCache = false;
    }
  }
  return overridesDisabledCache;
}

export function refreshOverridesDisabledCache() {
  overridesDisabledCache = null;
}

// This module owns the disable_overrides flag; Settings goes through here
// instead of writing localStorage raw and poking the cache itself
export function setOverridesDisabled(disabled) {
  try {
    localStorage.setItem("disable_overrides", disabled ? "true" : "false");
  } catch { /* private mode */ }
  refreshOverridesDisabledCache();
}

/**
 * The chain's two "no value" sentinels. Written out inline at ten sites
 * across four modules before this had a name.
 */
export function isSentinelValue(v) {
  return v === "N/A" || v === "<invalid Value>";
}

/**
 * Normalizes birthplace strings by separating with exactly one space after a comma,
 * and trimming/filtering out empty/whitespace segments.
 * e.g., "Ljubljana,, SVN" or "Ljubljana, , SVN" -> "Ljubljana, SVN"
 * e.g., "San Jose,CA, USA" -> "San Jose, CA, USA"
 */
export function normalizeBirthplace(str) {
  if (!str || isSentinelValue(str)) return "";
  const trimmed = String(str).trim();
  if (trimmed === "") return "";

  const parts = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  // Then the deterministic house format (state and country codes); see
  // birthplace.normalizer.js. Unknown tokens pass through untouched.
  return toHouseBirthplace(parts);
}

/**
 * Normalizes specific team name values to standardized formats,
 * e.g., "Los Angeles Clippers" -> "LA Clippers" (case-insensitive).
 */
export function normalizeTeamName(name) {
  if (!name) return "";
  const trimmed = String(name).trim();
  if (trimmed.toLowerCase() === "los angeles clippers") {
    return "LA Clippers";
  }
  return trimmed;
}

/**
 * Normalizes a birthdate string into clean standard 'YYYY-MM-DD' format,
 * completely timezone-safe.
 */
export function normalizeBirthdate(str) {
  if (!str || isSentinelValue(str)) return "";
  const trimmed = String(str).trim();
  if (trimmed === "") return "";
  
  let year, month, day;
  
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length === 3) {
      // M/D/YYYY or MM/DD/YYYY
      month = parseInt(parts[0]);
      day = parseInt(parts[1]);
      year = parseInt(parts[2]);
    }
  } else if (trimmed.includes("-")) {
    const parts = trimmed.split("-");
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        year = parseInt(parts[0]);
        month = parseInt(parts[1]);
        day = parseInt(parts[2]);
      } else {
        // MM-DD-YYYY
        month = parseInt(parts[0]);
        day = parseInt(parts[1]);
        year = parseInt(parts[2]);
      }
    }
  }
  
  if (year && month && day && !isNaN(year) && !isNaN(month) && !isNaN(day)) {
    const mmStr = String(month).padStart(2, "0");
    const ddStr = String(day).padStart(2, "0");
    return `${year}-${mmStr}-${ddStr}`;
  }
  
  // Fallback to standard JS Date parsing if other splits fail
  const dateObj = new Date(trimmed);
  if (isNaN(dateObj.getTime())) {
    return trimmed;
  }
  const yearUTC = dateObj.getUTCFullYear();
  const monthUTC = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const dayUTC = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${yearUTC}-${monthUTC}-${dayUTC}`;
}

/**
 * Normalizes on-chain game timestamps (DateOfMoment) and standardizes them
 * in America/New_York (Eastern Time) as 'YYYY-MM-DD HH:MM:SS EST'.
 */
export function normalizeDateOfMoment(str) {
  if (!str || isSentinelValue(str)) return "";
  const trimmed = String(str).trim();
  if (trimmed === "") return "";

  const dateObj = new Date(trimmed);
  if (isNaN(dateObj.getTime())) {
    return trimmed;
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short"
    });

    const parts = formatter.formatToParts(dateObj);
    const partMap = {};
    parts.forEach(p => partMap[p.type] = p.value);

    const year = partMap.year;
    const month = partMap.month;
    const day = partMap.day;
    const hour = partMap.hour;
    const minute = partMap.minute;
    const second = partMap.second;
    // "EST" in winter, "EDT" during daylight saving; parseMomentDate maps each
    // back to its exact UTC offset
    const tz = partMap.timeZoneName === "EDT" ? "EDT" : "EST";

    return `${year}-${month}-${day} ${hour}:${minute}:${second} ${tz}`;
  } catch {
    return dateObj.toISOString();
  }
}

/**
 * Parses a normalized DateOfMoment string ("YYYY-MM-DD HH:MM:SS EST|EDT") into
 * an exact Date instant. The display string must never be fed to new Date()
 * directly: browsers disagree on the "EST"/"EDT" suffix (Safari returns
 * Invalid Date) and the suffix carries a fixed offset that new Date() can
 * misapply. Falls back to standard parsing for raw on-chain timestamps.
 */
export function parseMomentDate(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s+(EST|EDT))?$/);
  if (m) {
    const offset = m[3] === "EDT" ? "-04:00" : m[3] === "EST" ? "-05:00" : "";
    const d = new Date(`${m[1]}T${m[2]}${offset}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Perform a case-insensitive merge of an overrides/additions object into a target object.
 * If a key in the overrides matches a key in the target (ignoring case),
 * the target's value is overwritten. If no match is found, the key-value is appended.
 */
export function mergeCaseInsensitive(target, overrides) {
  if (!overrides || !target) return target;
  
  const result = { ...target };
  
  Object.entries(overrides).forEach(([overrideKey, overrideVal]) => {
    // Treat 'name' as matching 'setName' for set objects
    let resolvedKey = overrideKey;
    if (overrideKey.toLowerCase() === "name" && "setName" in result) {
      resolvedKey = "setName";
    }

    const matchKey = Object.keys(result).find(
      (k) => k.toLowerCase() === resolvedKey.toLowerCase()
    );
    
    if (matchKey) {
      result[matchKey] = overrideVal;
    } else {
      result[overrideKey] = overrideVal;
    }
  });
  
  return result;
}

/**
 * Apply sets_overrides.json and sets_additions.json to a set object
 */
export function applySetOverrides(set) {
  if (!set || !set.id) return set;
  if (areOverridesDisabled()) return set;

  const setIDStr = String(set.id);
  let result = set;
  
  // 1. Apply overrides
  if (setsOverrides[setIDStr]) {
    result = mergeCaseInsensitive(result, setsOverrides[setIDStr]);
  }
  
  // 2. Apply additions
  if (setsAdditions[setIDStr]) {
    result = mergeCaseInsensitive(result, setsAdditions[setIDStr]);
  }
  
  return result;
}

/**
 * Apply plays_overrides.json and plays_additions.json to a play object,
 * sanitizes "Play Coming Soon", and merges PlayCategory / PlayType.
 */
const STANDARD_PLAY_KEYS = {
  playid: "playID",
  fullname: "FullName",
  playtype: "PlayType",
  playcategory: "PlayCategory",
  nbaseason: "NbaSeason",
  teamatmoment: "TeamAtMoment",
  teamatmomentnbaid: "TeamAtMomentNBAID",
  currentteam: "CurrentTeam",
  currentteamid: "CurrentTeamID",
  jerseynumber: "JerseyNumber",
  dateofmoment: "DateOfMoment",
  hometeamname: "HomeTeamName",
  hometeamscore: "HomeTeamScore",
  awayteamname: "AwayTeamName",
  awayteamscore: "AwayTeamScore",
  playerposition: "PlayerPosition",
  primaryposition: "PrimaryPosition",
  height: "Height",
  weight: "Weight",
  totalyearsexperience: "TotalYearsExperience",
  birthdate: "Birthdate",
  birthplace: "Birthplace",
  draftyear: "DraftYear",
  draftround: "DraftRound",
  draftselection: "DraftSelection",
  draftteam: "DraftTeam",
  playerautographtype: "PlayerAutographType",
  date: "Date",
  signer: "Signer",
  tagline: "description",
  overrideheadline: "headline",
  headline: "headline",
  description: "description"
};

/**
 * Standardizes play metadata property keys case-insensitively to standard explorer casing.
 */
export function standardizePlayKeys(play) {
  if (!play) return play;
  const result = {};
  Object.entries(play).forEach(([key, val]) => {
    const lowerKey = key.toLowerCase();
    const standardKey = STANDARD_PLAY_KEYS[lowerKey];
    if (standardKey) {
      result[standardKey] = val;
    } else {
      result[key] = val;
    }
  });
  return result;
}

/**
 * Apply plays_overrides.json and plays_additions.json to a play object,
 * sanitizes "Play Coming Soon", and merges PlayCategory / PlayType.
 */
/*
 * Canonical-name aliases, derived from the overrides themselves: when an override corrects a play's FullName, the raw
 * spelling it replaced maps to that canonical name for EVERY play,
 * including mints that arrive later with the same variant ("Stephen
 * Curry" -> "Steph Curry"). One correction per player is enough; the
 * decision is definitive. Built from the raw play store by
 * buildNameAliases (recompile, end of sync, the reconcile script); empty
 * until primed. A raw spelling corrected to two different names is
 * ambiguous and is dropped.
 */
let nameAliases = new Map();

export function buildNameAliases(rawPlays) {
  const byId = Array.isArray(rawPlays)
    ? Object.fromEntries(rawPlays.map((p) => [String(p.playID), p._raw || p]))
    : (rawPlays || {});
  const map = new Map();
  const conflicts = new Set();
  Object.entries(playsOverrides).forEach(([id, o]) => {
    const canonical = String(standardizePlayKeys(o).FullName || "").trim();
    if (!canonical || !byId[id]) return;
    const rawName = String(standardizePlayKeys(byId[id]).FullName || "").trim();
    if (!rawName || rawName === canonical) return;
    const key = rawName.toLowerCase();
    if (map.has(key) && map.get(key) !== canonical) conflicts.add(key);
    else map.set(key, canonical);
  });
  conflicts.forEach((k) => map.delete(k));
  nameAliases = map;
  return map;
}

export function applyPlayOverrides(play) {
  if (!play) return play;

  // 1. Standardize keys of the incoming play object first
  let result = standardizePlayKeys(play);
  if (!result.playID) return result;

  const playIDStr = String(result.playID);
  const disableOverrides = areOverridesDisabled();

  if (!disableOverrides) {
    // 2. Apply overrides
    let ownNameOverride = false;
    if (playsOverrides[playIDStr]) {
      const cleanOverride = standardizePlayKeys(playsOverrides[playIDStr]);
      ownNameOverride = Boolean(String(cleanOverride.FullName || "").trim());
      result = { ...result, ...cleanOverride };
    }

    // 3. Apply additions
    if (playsAdditions[playIDStr]) {
      const cleanAddition = standardizePlayKeys(playsAdditions[playIDStr]);
      result = { ...result, ...cleanAddition };
    }

    // 4. Canonical-name alias (derived from other plays' FullName overrides);
    // a play's own override always wins
    if (!ownNameOverride && result.FullName && nameAliases.size > 0) {
      const canonical = nameAliases.get(String(result.FullName).trim().toLowerCase());
      if (canonical) result.FullName = canonical;
    }
  }

  // Source Normalization: Dates, Timestamps, Birthplace, & Team Names
  if (!result.FullName || isSentinelValue(result.FullName) || result.FullName.trim() === "") {
    result.FullName = "";
  }
  if (result.Birthdate) {
    result.Birthdate = normalizeBirthdate(result.Birthdate);
  }
  if (result.DateOfMoment) {
    result.DateOfMoment = normalizeDateOfMoment(result.DateOfMoment);
  }
  if (result.Birthplace) {
    result.Birthplace = normalizeBirthplace(result.Birthplace);
  }
  const teamFields = ["TeamAtMoment", "HomeTeamName", "AwayTeamName", "DraftTeam", "CurrentTeam"];
  teamFields.forEach((field) => {
    if (result[field]) {
      result[field] = normalizeTeamName(result[field]);
    }
  });

  // WNBA seasons are single calendar years; new mints sometimes arrive with
  // NBA-format ranges ("2025-26" on a 2025 WNBA play). Deterministic
  // normalization (policy 2026-08-31): use the moment date's year when
  // present, else the range's start year.
  if (result.NbaSeason && /^\d{4}-\d{2}$/.test(String(result.NbaSeason).trim()) && isWnbaTeamId(result.TeamAtMomentNBAID)) {
    const yearFromDate = String(result.DateOfMoment || "").match(/^(\d{4})/);
    result.NbaSeason = yearFromDate ? yearFromDate[1] : String(result.NbaSeason).trim().slice(0, 4);
  }

  // Clean "Play Coming Soon" fields
  let category = result.PlayCategory;
  let type = result.PlayType;

  if (category === "Play Coming Soon") category = "";
  if (type === "Play Coming Soon") type = "";

  result.PlayCategory = category || "";
  result.PlayType = type || "";

  // Dynamic category / type merging
  let merged;
  if (category && type && category !== type) {
    merged = `${category} / ${type}`;
  } else {
    merged = category || type || "";
  }
  result["PlayCategory / PlayType"] = merged;

  return result;
}

/**
 * Apply editions_additions.json to an edition object
 */
export function applyEditionOverrides(edition) {
  if (!edition || !edition.id) return edition;
  if (areOverridesDisabled()) return edition;

  const editionIDStr = String(edition.id); // format setID_playID
  let result = edition;
  
  if (editionsAdditions[editionIDStr]) {
    result = mergeCaseInsensitive(result, editionsAdditions[editionIDStr]);
  }
  
  return result;
}

/**
 * Load augmented series name from series_overrides.json and series_additions.json
 */
export function getSeriesInfo(seriesID) {
  const sIDStr = String(seriesID);
  let info = { name: `Series ${seriesID}` };

  if (areOverridesDisabled()) return info;
  
  // 1. Load from overrides
  if (seriesOverrides[sIDStr]) {
    info = { ...info, ...seriesOverrides[sIDStr] };
  }
  
  // 2. Load from additions
  if (seriesAdditions[sIDStr]) {
    info = { ...info, ...seriesAdditions[sIDStr] };
  }
  
  return info;
}

export function getSeriesOverrides() {
  if (areOverridesDisabled()) return {};

  // Merge full series maps for dropdown listing
  const merged = { ...seriesOverrides };
  Object.entries(seriesAdditions).forEach(([id, data]) => {
    merged[id] = { ...merged[id], ...data };
  });
  return merged;
}

/**
 * Gets the emoji for a given team name by looking it up in teams_additions.json.
 * Uses a case-insensitive check. Historical franchise names (historical_names
 * on an entry, either "Old Name" strings or { name, emoji } objects) resolve
 * to that entry, so "Washington Bullets" gets the Wizards' emoji unless the
 * alias declares its own.
 */
// Lazily-built name -> emoji map (canonical names and historical aliases),
// same pattern as the two caches below; the fallback used to walk all 65
// teams and their aliases per call, and it is called per table cell.
// First-writer-wins preserves the old loop's resolution order.
let emojiByNameCache = null;
function emojiByName() {
  if (!emojiByNameCache) {
    emojiByNameCache = new Map();
    const put = (name, emoji) => {
      const key = String(name).trim().toLowerCase();
      if (key && !emojiByNameCache.has(key)) emojiByNameCache.set(key, emoji || "");
    };
    Object.values(teamsAdditions).forEach((team) => {
      if (team.name) put(team.name, team.emoji);
      (team.historical_names || []).forEach((alias) => {
        const aliasName = typeof alias === "string" ? alias : alias.name;
        if (aliasName) put(aliasName, (typeof alias === "object" && alias.emoji) || team.emoji);
      });
    });
  }
  return emojiByNameCache;
}

export function getTeamEmoji(teamName, nbaID) {
  if (nbaID) {
    const details = teamsAdditions[String(nbaID)];
    if (details && details.emoji) return details.emoji;
  }
  if (!teamName) return "";
  return emojiByName().get(String(teamName).trim().toLowerCase()) || "";
}

// { "lowercased team name": nbaID } from teams.json, historical names
// included; special entries (all-star sides, defunct teams with no
// franchise page) contribute their emoji via getTeamEmoji but never an id,
// so they don't produce broken /teams/:id links.
let additionsNameMapCache = null;
export function getAdditionsTeamNameMap() {
  if (additionsNameMapCache) return additionsNameMapCache;
  const map = {};
  Object.entries(teamsAdditions).forEach(([id, team]) => {
    if (team.special || !team.name) return;
    map[team.name.trim().toLowerCase()] = id;
    (team.historical_names || []).forEach((alias) => {
      const aliasName = typeof alias === "string" ? alias : alias.name;
      if (aliasName) map[aliasName.trim().toLowerCase()] = id;
    });
  });
  additionsNameMapCache = map;
  return map;
}

// True when the name is a former franchise name ("Washington Bullets"):
// such names keep their historical spelling in the UI even where display
// code otherwise normalizes to the canonical franchise name.
let historicalNameSetCache = null;
export function isHistoricalTeamName(teamName) {
  if (!teamName) return false;
  if (!historicalNameSetCache) {
    historicalNameSetCache = new Set();
    Object.values(teamsAdditions).forEach((team) => {
      (team.historical_names || []).forEach((alias) => {
        const aliasName = typeof alias === "string" ? alias : alias.name;
        if (aliasName) historicalNameSetCache.add(aliasName.trim().toLowerCase());
      });
    });
  }
  return historicalNameSetCache.has(String(teamName).trim().toLowerCase());
}

/**
 * Prepends the team's emoji immediately before the team name, e.g., "🔥 Miami Heat"
 */
export function getTeamNameWithEmoji(teamName, nbaID) {
  if (!teamName) return "";
  const emoji = getTeamEmoji(teamName, nbaID);
  return emoji ? `${emoji} ${teamName}` : teamName;
}

/**
 * Resolves the venue for a given team on a specific game date.
 * @param {string} teamId - The ID of the home team.
 * @param {string} gameDateISO - The date of the game formatted as "YYYY-MM-DD" or full timestamp.
 * @returns {Object|null} Mapped venue object with team identification merged, or null if team not found.
 */
const sortedArenasCache = new Map();
export function resolveVenue(teamId, gameDateISO) {
  const team = teamsAdditions[String(teamId)];
  if (!team) return null;

  let lookupDate = "9999-12-31"; // Default to future for general lookups
  if (gameDateISO) {
    const match = String(gameDateISO).match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      lookupDate = match[1];
    } else {
      const dObj = new Date(gameDateISO);
      if (!isNaN(dObj.getTime())) {
        const yyyy = dObj.getFullYear();
        const mm = String(dObj.getMonth() + 1).padStart(2, "0");
        const dd = String(dObj.getDate()).padStart(2, "0");
        lookupDate = `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  // Sort the arenas by specificity (narrower date ranges first) to prevent
  // broad/open-ended ranges from blocking more specific ranges. The order
  // is date-independent, so it is cached per team: the arena pages call
  // this once per play (~9,000 sorts before the cache).
  let sortedArenas = sortedArenasCache.get(String(teamId));
  if (!sortedArenas) {
    sortedArenas = [...(team.arenas || [])].sort((a, b) => {
      const getDuration = (cfg) => {
        if (!cfg.start_date && !cfg.end_date) return Infinity;
        const start = cfg.start_date ? Date.parse(cfg.start_date) : 0;
        const end = cfg.end_date ? Date.parse(cfg.end_date) : 253402300800000; // Year 9999
        return end - start;
      };
      return getDuration(a) - getDuration(b);
    });
    sortedArenasCache.set(String(teamId), sortedArenas);
  }

  // Find the first matching arena configuration based on sorted specificity
  const matchedArena = sortedArenas.find((config) => {
    const startBound = config.start_date || "0000-01-01";
    const endBound = config.end_date || "9999-12-31";
    return lookupDate >= startBound && lookupDate <= endBound;
  });

  if (!matchedArena) {
    return {
      name: team.name,
      team_name: team.name,
      emoji: team.emoji,
      color: team.color,
      arena: "",
      city: "",
      state: "",
      lat: undefined,
      lng: undefined,
      area_codes: ""
    };
  }

  return {
    name: team.name,
    team_name: team.name,
    emoji: team.emoji,
    color: team.color,
    arena: matchedArena.name || matchedArena.arena,
    city: matchedArena.city,
    state: matchedArena.state,
    lat: matchedArena.lat,
    lng: matchedArena.lng,
    area_codes: matchedArena.area_codes,
    start_date: matchedArena.start_date || null,
    end_date: matchedArena.end_date || null
  };
}

/**
 * Gets team additions details by NBA ID, resolving to active current venue.
 */
export function getTeamDetailsById(nbaID) {
  return resolveVenue(nbaID);
}

/**
 * Compiles raw play metadata, preserves the original under _raw,
 * and applies normalizations, overrides, and additions at compile-time.
 */
export function compilePlayMetadata(playID, rawMetadata) {
  if (!rawMetadata) return null;
  
  const rawCopy = { ...rawMetadata };
  // Ensure we don't nest _raw inside _raw
  delete rawCopy._raw;
  delete rawCopy.playID;

  let compiled = {
    playID: Number(playID),
    ...rawCopy,
    _raw: rawCopy
  };

  return applyPlayOverrides(compiled);
}

/**
 * Compiles set metadata, preserves the original under _raw,
 * and applies overrides and additions at compile-time.
 */
export function compileSetMetadata(set) {
  if (!set) return null;

  const rawCopy = {
    setName: set.setName,
    series: set.series,
    locked: set.locked,
    playIDs: set.playIDs
  };
  // Ensure we don't nest _raw inside _raw
  delete rawCopy._raw;

  let compiled = {
    id: Number(set.id),
    ...rawCopy,
    _raw: rawCopy
  };

  return applySetOverrides(compiled);
}
// Set lookup for mismint checks: playsExclude is scanned per play in hot paths
const playsExcludeSet = new Set(playsExclude.map(String));

/**
 * True for a misminted play (data/plays_exclude.json). THE single home for
 * this predicate: pages used to import the raw JSON and linear-scan it per
 * row (ipfs.analysis keeps its own copy of the Set for its coverage math,
 * same source file).
 */
export function isMismintPlay(playID) {
  return playsExcludeSet.has(String(Number(playID)));
}

/**
 * Resolves a play's effective debut name: the player's FullName, or the team
 * name for team moments. Returns "" when neither is present.
 */
function getDebutName(play) {
  let name = play.FullName ? play.FullName.trim() : "";
  const isTeamMoment = (name === "" || name.toLowerCase() === "team moment");
  if (isTeamMoment) {
    name = play.TeamAtMoment ? play.TeamAtMoment.trim() : "";
  }
  return { name, isTeamMoment };
}

/**
 * Stamps each play with `mintTotal`, the number of moments minted of it
 * across every edition (0 when it has none). The debut rule needs it to
 * tell a one-of-one from a numbered release. The DB read path attaches it
 * from the editions store (db.service getAllPlaysDB); scripts that compile
 * plays from a raw snapshot attach it from the seed's set contents. Plays
 * without it derive as if every play were numbered.
 */
export function attachMintTotals(plays, editions) {
  const totals = new Map();
  (editions || []).forEach((e) => {
    const id = Number(e.playID);
    totals.set(id, (totals.get(id) || 0) + (Number(e.momentCount) || 0));
  });
  (plays || []).forEach((p) => { p.mintTotal = totals.get(Number(p.playID)) || 0; });
  return plays;
}

// The game a play is from: the compiled DateOfMoment's calendar day (the
// Eastern day once normalized). Two plays of one game can carry different
// clock times on chain, so the day is the game
const gameDay = (play) => (play && play.DateOfMoment ? String(play.DateOfMoment).trim().slice(0, 10) : "");
const playCategory = (play) => String((play && play.PlayCategory) || "").trim().toLowerCase();

/**
 * Builds a Map of debut-name (lowercased) to the player's debut play. Pass
 * the result as the third argument of getCalculatedPlayTags when tagging
 * many plays: without it, every call rescans the full plays array, which
 * is quadratic across a page.
 *
 * THE DEBUT RULE, from chain data alone:
 *   1. The debut is the player's lowest play id. Mismints never count.
 *   2. A one-of-one yields: when that lowest play was minted exactly once
 *      and the player has a play from the same game minted in numbers, the
 *      numbered play is the debut (the Ultimates one-of-ones of a rookie
 *      drop are sometimes created before the Rookie Debut play).
 *   3. Twins share it (getCalculatedPlayTags): another play by the same
 *      player from the same game in the same play category is the same
 *      highlight re-created for a companion set (a Diamond Edition, a
 *      Signature Edition) and carries the badge too.
 * Scored against Dapper Labs' own badging over every player: 1,415 agree,
 * none missing, five extra (one-of-one twins of a Debut play, withheld by
 * tags_suppress on data/additions/plays.json, each shown on the Corrections
 * page). This replaces the earlier policy
 * that let EVERY same-game sibling share the badge, which was fitted to
 * 13 legends pairs and over-reached on 80 other plays.
 */
// Keyed on the plays ARRAY IDENTITY: getAllPlaysDB returns the same array
// until a write invalidates its cache, so pages and audits that each used
// to rebuild this pay once per sync generation. A fresh array (a page's
// chain-fallback path, a script's own compile) is simply a cache miss.
const tsdIndexCache = new WeakMap();
export function buildTsdIndex(allPlays) {
  if (allPlays && tsdIndexCache.has(allPlays)) return tsdIndexCache.get(allPlays);
  // Every eligible play per debut name, then the rule per name
  const byName = new Map();
  (allPlays || []).forEach((p) => {
    const { name, isTeamMoment } = getDebutName(p);
    if (name === "") return;
    // Misminted plays never count toward debut calculations
    if (playsExcludeSet.has(String(p.playID))) return;
    // Team Moments of All-Star teams are excluded from debuts
    if (isTeamMoment && getTeamEmoji(p.TeamAtMoment, p.TeamAtMomentNBAID) === "⭐") return;
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  });
  const index = new Map();
  byName.forEach((list, key) => {
    list.sort((a, b) => Number(a.playID) - Number(b.playID));
    let debut = list[0];
    if (debut.mintTotal === 1) {
      const day = gameDay(debut);
      const numbered = day !== "" ? list.find((p) => p !== debut && gameDay(p) === day && Number(p.mintTotal) > 1) : null;
      if (numbered) debut = numbered;
    }
    index.set(key, debut);
  });
  if (allPlays) tsdIndexCache.set(allPlays, index);
  return index;
}

/**
 * Computes dynamic tags for a play object based on autograph type, draft year,
 * player debut (lowest playID for a player name), rookie year, and team championship season.
 * Pass a prebuilt tsdIndex (from buildTsdIndex) when calling in a loop.
 *
 * The stored tags array comes from the external Dapper API import. For the
 * computable tags (the COMPUTABLE_TAG_NAMES set below) OUR
 * derivation from the play data and teams.json is authoritative: stored
 * copies are excluded from the seed, so a wrong Dapper tag never displays;
 * where Dapper disagrees with the derivation, the Corrections page surfaces it.
 * Non-computable Dapper tags (Rookie Premiere, MVP Year, Rookie of the
 * Year) display from storage as external context. Dapper's reward badges
 * (Challenge Reward, Crafting Challenge Reward, Leaderboard Reward) are
 * EDITION-level facts, stored on data/additions/editions.json (see
 * editionTags below), never play tags.
 */
// Cup Year and Hall of Fame have no Dapper counterpart (ours alone: Cup
// Year derives from teams.json cups, Hall of Fame from
// data/awards/hall_of_fame.json); they are listed here so a stored copy
// can never override or duplicate the derivation.
export const COMPUTABLE_TAG_NAMES = new Set(["Top Shot Debut", "Rookie Year", "Championship Year", "Rookie Mint", "Cup Year", "Hall of Fame", "Autograph"]);

/*
 * Normalized names of every Naismith Hall of Fame inductee in the Player
 * category (data/awards/hall_of_fame.json, baked by
 * scripts/fetch-awards.mjs). Matching is by normalized full name
 * (name-norm.js: case/diacritics/periods/apostrophes folded, suffixes
 * kept, so Gary Payton II never inherits his father's plaque). Should
 * two different players ever share a name, the per-play tags_suppress
 * valve corrects the wrong one.
 */
let hofNameSet = null;
const hofNames = () => {
  if (!hofNameSet) hofNameSet = new Set(hallOfFame.players.map((p) => normPlayerName(p.name)));
  return hofNameSet;
};

// MVP and Rookie of the Year winners (data/awards/mvp.json, roy.json; NBA
// and WNBA merged), matched like the Hall of Fame list. These feed the
// PLAYER-LEVEL honor lookups only (the Players page filters); play tags are
// untouched: Dapper's "MVP Year" and "Rookie of the Year" moment tags stay
// stored-only, not derived (see COMPUTABLE_TAG_NAMES).
let mvpNameSet = null;
let royNameSet = null;
const awardNames = (awards, cache) =>
  cache || new Set([...(awards.NBA || []), ...(awards.WNBA || [])].map((r) => normPlayerName(r.player)));

/*
 * A rookie is a player in their first season of league play (the NBA and
 * WNBA definition: Rookie of the Year, the All-Rookie teams). The draft
 * year is that season for most players, but not for the injury redshirts
 * (Simmons 2016 -> 2017-18, Griffin, Holmgren), the draft-and-stash class
 * (Jokić, Ginóbili, Sabonis) or the undrafted (Caruso), whose first season
 * lives in data/additions/rookie_seasons.json. Neither the card industry's
 * "rookie card = draft season" convention nor "first moment on Top Shot"
 * works here: a moment is a game, and Top Shot skips many players' early
 * seasons, so first appearance would badge veterans.
 * Atlas is the check, never the source: the comparison (scripts/
 * atlas-tags.mjs) flags a late debut, a person confirms it, the table
 * grows. Returns the season start year as a string, or "" when unknown.
 */
let rookieSeasonByName = null;
export function rookieSeasonStart(play) {
  if (!rookieSeasonByName) {
    rookieSeasonByName = new Map();
    Object.entries(rookieSeasons.players || {}).forEach(([name, e]) => {
      if (e && e.season) rookieSeasonByName.set(normPlayerName(name), String(e.season).trim());
    });
  }
  const key = normPlayerName(play.FullName || "");
  const override = key ? rookieSeasonByName.get(key) : undefined;
  return override || String(play.DraftYear || "").trim();
}

/**
 * Career honors for one player, by name: absolute facts that hold whatever
 * moments the player has (a 2011 MVP counts even with no 2011 moment).
 * Returns { hof, mvp, roy } booleans.
 */
export function getPlayerHonors(fullName) {
  const key = normPlayerName(fullName);
  if (!key) return { hof: false, mvp: false, roy: false };
  mvpNameSet = awardNames(mvpAwards, mvpNameSet);
  royNameSet = awardNames(royAwards, royNameSet);
  return { hof: hofNames().has(key), mvp: mvpNameSet.has(key), roy: royNameSet.has(key) };
}

/**
 * Badge definitions for every tag the app can show. "Tags" is the data-layer
 * name (the additions file, the Dapper API); the front end calls them badges.
 * Each badge is a circle with a gradient ring echoing the official Top Shot
 * badge for that tag (assets.nbatopshot.com/static/momentTags): the glyph
 * inside is either an emoji or, where the official badge is lettering,
 * the same letters (TSD, ROY, MVP). The three rookie badges share one
 * cyan-to-green family, Championship Year is red-to-magenta. Autograph
 * and Cup Year have no official badge (Cup Year is our own derived tag;
 * gold ring, cup glyph, distinct from the 🏆 trophy). The three reward
 * badges (marked `reward`) share one muted grey-gold ring so they read as
 * a family, secondary to the history badges.
 * Every emoji here must also be in src/dev/subset-text.txt (the shipped
 * emoji font subset) or it silently falls back to the system font.
 * Order is THE canonical badge order: badges under
 * names, every Badge dropdown, and the homepage columns all follow it.
 * The rookie trio always reads Mint, Year, Premiere; the reward badges
 * come last, after the edition-level Commentary badge (see badgeRank).
 */
const REWARD_GRADIENT = "linear-gradient(135deg, #e8dcc0 0%, #b3a27c 55%, #6b5c42 100%)";
export const TAG_BADGES = [
  { tag: "Top Shot Debut", text: "TSD", gradient: "linear-gradient(135deg, #2f5bff 0%, #6d8bff 55%, #ff5a4a 100%)" },
  { tag: "Rookie Mint", emoji: "🧊", gradient: "linear-gradient(135deg, #33faff 0%, #42f683 100%)" },
  { tag: "Rookie Year", emoji: "🌟", gradient: "linear-gradient(135deg, #33faff 0%, #42f683 100%)" },
  { tag: "Rookie Premiere", emoji: "🏀", gradient: "linear-gradient(135deg, #33faff 0%, #42f683 100%)" },
  { tag: "Rookie of the Year", text: "ROY", gradient: "linear-gradient(135deg, #33ffcc 0%, #7ee8fa 50%, #d46cff 100%)" },
  { tag: "MVP Year", text: "MVP", gradient: "linear-gradient(135deg, #3d6bff 0%, #7aa2ff 55%, #ff4fb0 100%)" },
  { tag: "Championship Year", emoji: "🏆", gradient: "linear-gradient(135deg, #ff3b3b 0%, #e64ae0 100%)" },
  // The team won its league's in-season cup that season (NBA Cup,
  // Commissioner's Cup): every play by that team in that season, like
  // Championship Year
  { tag: "Cup Year", emoji: "🏺", title: "Cup Year: the team won its league's in-season cup that season (NBA Cup, Commissioner's Cup)", gradient: "linear-gradient(135deg, #ffd24a 0%, #ff8a00 100%)" },
  // Career honor, derived from data/awards/hall_of_fame.json; no official
  // Top Shot badge exists, so lettering on a bronze-gold ring (ours alone,
  // like Cup Year)
  { tag: "Hall of Fame", text: "HOF", gradient: "linear-gradient(135deg, #ffe08a 0%, #cd7f32 55%, #7c3f10 100%)" },
  { tag: "Autograph", emoji: "✍️", gradient: "linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)" },
  // Dapper's reward badges: edition-level (the edition was a reward), see
  // editionTags. Glyphs: pieces collected, the crafting burn, the
  // leaderboard crown
  { tag: "Challenge Reward", emoji: "🧩", reward: true, title: "Challenge Reward: earned by completing a Top Shot challenge (collecting specific moments in a window)", gradient: REWARD_GRADIENT },
  { tag: "Crafting Challenge Reward", emoji: "🔥", reward: true, title: "Crafting Challenge Reward: minted by crafting (burning moments to mint a new one)", gradient: REWARD_GRADIENT },
  { tag: "Leaderboard Reward", emoji: "👑", reward: true, title: "Leaderboard Reward: earned by finishing on a Top Shot leaderboard", gradient: REWARD_GRADIENT }
];
export const REWARD_TAGS = TAG_BADGES.filter((b) => b.reward).map((b) => b.tag);
export const ROOKIE_TAGS = ["Rookie Mint", "Rookie Year", "Rookie Premiere"];

/*
 * Edition-level badges: derived from a set + play pair (a narrated cut of
 * one edition), not from the play, so they are NOT calculated play tags.
 * Kept out of TAG_BADGES on purpose: the homepage builds its badge columns
 * from that list and these do not belong there. Pages
 * append the tag themselves (commentary.service.js).
 */
export const EDITION_BADGES = [
  { tag: "Commentary", emoji: "🎙️", title: "Commentary: a narrated cut of this moment from the original nbatopshot.com", gradient: "linear-gradient(135deg, #f472b6 0%, #a855f7 100%)" }
];

// Canonical order: history badges, Commentary, then the reward badges
const BADGE_DEFS = [...TAG_BADGES.filter((b) => !b.reward), ...EDITION_BADGES, ...TAG_BADGES.filter((b) => b.reward)];
const TAG_BADGE_INDEX = new Map(BADGE_DEFS.map((b, i) => [b.tag, i]));

/** The badge definition for a tag (emoji, text, title, gradient), or null */
export function badgeDef(tag) {
  const i = TAG_BADGE_INDEX.get(tag);
  return i === undefined ? null : BADGE_DEFS[i];
}

/** Position of a badge in the canonical order; unknown tags sort after
 *  every known one (then alphabetically, via compareBadges) */
export function badgeRank(tag) {
  const i = TAG_BADGE_INDEX.get(tag);
  return i === undefined ? BADGE_DEFS.length : i;
}
/** Comparator for badge dropdowns and lists: canonical order first */
export function compareBadges(a, b) {
  return (badgeRank(a) - badgeRank(b)) || String(a).localeCompare(String(b));
}

/*
 * Edition-level stored tags (data/additions/editions.json `tags`): today
 * Dapper's reward badges, written by `npm run atlas:editions` from the
 * Atlas sheet. An edition of a reward set carries them; the same play in
 * an ordinary set does not. Only tags with a badge definition count.
 */
export function editionTags(setID, playID) {
  const entry = editionsAdditions[`${Number(setID)}_${Number(playID)}`];
  const tags = entry && Array.isArray(entry.tags) ? entry.tags : null;
  if (!tags || tags.length === 0) return EMPTY_TAGS;
  return tags.filter((t) => TAG_BADGE_INDEX.has(t));
}
const EMPTY_TAGS = Object.freeze([]);
const EMPTY_LIST = Object.freeze([]);
let editionTagsByPlay = null;
/** Union of the edition-level tags over every edition of a play (the
 *  Plays page: "some edition of this play was a reward") */
export function playEditionTags(playID) {
  if (!editionTagsByPlay) {
    editionTagsByPlay = new Map();
    Object.entries(editionsAdditions).forEach(([key, entry]) => {
      if (key.startsWith("_") || !entry || !Array.isArray(entry.tags)) return;
      const pid = Number(key.split("_")[1]);
      const set = editionTagsByPlay.get(pid) || new Set();
      entry.tags.forEach((t) => { if (TAG_BADGE_INDEX.has(t)) set.add(t); });
      editionTagsByPlay.set(pid, set);
    });
  }
  const set = editionTagsByPlay.get(Number(playID));
  return set && set.size > 0 ? [...set] : EMPTY_TAGS;
}
let rewardEditionsByPlay = null;
/** The editions of a play that carry edition-level tags, as
 *  [{ setID, tags }]: a play-level view (the Plays page, the play page)
 *  can then say WHICH edition earned a reward badge, since a play's
 *  other editions usually did not (312 of 1,037, 2026-09-09) */
export function playRewardEditions(playID) {
  if (!rewardEditionsByPlay) {
    rewardEditionsByPlay = new Map();
    Object.entries(editionsAdditions).forEach(([key, entry]) => {
      if (key.startsWith("_") || !entry || !Array.isArray(entry.tags)) return;
      const tags = entry.tags.filter((t) => TAG_BADGE_INDEX.has(t));
      if (tags.length === 0) return;
      const [sid, pid] = key.split("_").map(Number);
      const list = rewardEditionsByPlay.get(pid) || [];
      list.push({ setID: sid, tags });
      rewardEditionsByPlay.set(pid, list);
    });
  }
  return rewardEditionsByPlay.get(Number(playID)) || EMPTY_LIST;
}
/** A tag list plus extra tags (never mutates the input; skips duplicates) */
export function withTags(tags, extra) {
  if (!extra || extra.length === 0) return tags;
  const out = [...tags];
  extra.forEach((t) => { if (!out.includes(t)) out.push(t); });
  return out;
}

/*
 * The full rookie set (Mint + Year + Premiere) collapses into ONE special
 * badge: three stars put together. Rendered by
 * Badges.jsx as a star cluster instead of a glyph.
 */
const ROOKIE_TRIO = ["Rookie Mint", "Rookie Year", "Rookie Premiere"];
export const TRIFECTA_BADGE = {
  tag: "Rookie Trifecta",
  title: "Rookie Trifecta: Rookie Mint + Rookie Year + Rookie Premiere",
  tristar: true,
  gradient: "linear-gradient(135deg, #33faff 0%, #42f683 100%)"
};

/**
 * Maps a play's tag list to badge definitions in display order. Tags without
 * a definition (future Dapper tags such as Challenge Reward) are skipped
 * rather than drawn as an anonymous circle. A play carrying all three
 * rookie tags shows the single trifecta badge in their place.
 */
export function badgesForTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  const list = tags
    .filter((t) => TAG_BADGE_INDEX.has(t))
    .sort((a, b) => TAG_BADGE_INDEX.get(a) - TAG_BADGE_INDEX.get(b));
  if (ROOKIE_TRIO.every((t) => list.includes(t))) {
    // The trio is contiguous in display order, so the position of its first
    // member is also the right slot for the combined badge
    const at = list.indexOf(ROOKIE_TRIO[0]);
    const rest = list.filter((t) => !ROOKIE_TRIO.includes(t));
    return [
      ...rest.slice(0, at).map((t) => BADGE_DEFS[TAG_BADGE_INDEX.get(t)]),
      TRIFECTA_BADGE,
      ...rest.slice(at).map((t) => BADGE_DEFS[TAG_BADGE_INDEX.get(t)])
    ];
  }
  return list.map((t) => BADGE_DEFS[TAG_BADGE_INDEX.get(t)]);
}

/*
 * Mint clock: plays are created on chain in play-ID order, and a moment can
 * never be dated after it was minted, so the running maximum of DateOfMoment
 * along the play-ID axis is a mint-date clock. While a season is live it
 * tracks real time within days (verified against every season boundary
 * 2019-2026 and Dapper's Rookie Premiere tags); historical drops cannot
 * disturb it because old dates never raise a maximum. A lone future-dated
 * typo cannot advance it either: a jump of more than 45 days needs at least
 * 3 of the next 60 plays to also lie past the current clock.
 */
// Same array-identity caching rationale as buildTsdIndex above
const mintClockCache = new WeakMap();
export function buildMintClock(allPlays) {
  if (allPlays && mintClockCache.has(allPlays)) return mintClockCache.get(allPlays);
  const sorted = (allPlays || [])
    .map((p) => {
      const d = String(p.DateOfMoment || "").slice(0, 10);
      return { id: Number(p.playID), date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "" };
    })
    .filter((p) => Number.isFinite(p.id))
    .sort((a, b) => a.id - b.id);

  const DAY = 86400000;
  const clock = new Map();
  let cur = "";
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i].date;
    if (d && (!cur || d > cur)) {
      if (!cur || (new Date(d) - new Date(cur)) / DAY <= 45) {
        cur = d;
      } else {
        let support = 0;
        for (let j = i + 1; j <= i + 60 && j < sorted.length; j++) {
          if (sorted[j].date && sorted[j].date > cur) support++;
        }
        if (support >= 3) cur = d;
      }
    }
    clock.set(sorted[i].id, cur);
  }
  if (allPlays) mintClockCache.set(allPlays, clock);
  return clock;
}

/*
 * Which season a calendar date falls in, per league. NBA seasons with
 * irregular calendars (the 2019-20 bubble ran to Oct 11 2020; 2020-21
 * started Dec 22 2020) are covered by an explicit end-date table; a date in
 * an offseason gap belongs to the UPCOMING season. Beyond the table the
 * generic July boundary applies. Returns the season START year as a string
 * ("2020" for NBA 2020-21), or the single WNBA year.
 */
const NBA_SEASON_END_EXCLUSIVE = [
  ["2019", "2020-10-12"],
  ["2020", "2021-07-21"],
  ["2021", "2022-06-17"],
  ["2022", "2023-06-13"],
  ["2023", "2024-06-18"],
  ["2024", "2025-06-23"]
];

export function seasonStartYearForDate(dateStr, wnba) {
  const d = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  if (wnba) {
    // Calendar-year seasons (roughly May-Oct); Nov-Dec belongs to next year
    return String(month >= 11 ? year + 1 : year);
  }
  // Jul-Jun by default; the table above corrects the irregular recent
  // seasons, and only for dates that actually fall inside them (a 2010 date
  // is older than every table row, not part of 2019-20)
  const fallback = String(month >= 7 ? year : year - 1);
  for (const [startYear, endExclusive] of NBA_SEASON_END_EXCLUSIVE) {
    if (d < endExclusive) return d >= `${startYear}-07-01` ? startYear : fallback;
  }
  return fallback;
}

export function isWnbaTeamId(nbaID) {
  return String(nbaID || "").startsWith("161166");
}

/*
 * Season calendar (data/additions/seasons.json): per league and season key
 * (the app's NbaSeason format), the real-world date windows curated from
 * Wikipedia season articles. Window values are either ["start", "end"]
 * inclusive ISO date ranges or a single "YYYY-MM-DD" for one-day events
 * (All-Star Game, the Commissioner's Cup final). Known keys: preseason,
 * regular, allstar, playin, playoffs, commissioners_cup (WNBA, 2021+),
 * suspended (the 2019-20 COVID gap inside the regular range), and cup (the
 * NBA Cup, 2023-24+, see cupRound below).
 */
export function seasonWindows(league, season) {
  const bySeason = seasonsAdditions[league];
  return (bySeason && bySeason[String(season || "").trim()]) || null;
}

function inWindow(d, w) {
  if (!w) return false;
  if (Array.isArray(w)) return d >= w[0] && d <= w[1];
  return d === String(w).slice(0, 10);
}

/*
 * NBA Cup games are regular season games (except the final), staggered
 * through November and December, so the calendar stores them explicitly:
 *   cup.group_nights: the dates on which the league schedules ONLY group
 *     play ("Cup Nights"), so every game that night is a Cup game and the
 *     date alone decides;
 *   cup.knockout: the seven bracket games as { date, round, teams },
 *     matched on date plus both clubs, because the rest of the league plays
 *     ordinary games on the quarterfinal days.
 * Returns the round label ("Group Play", "Quarterfinal", ...) or null.
 */
function cupRound(d, play, cup) {
  if (!cup) return null;
  if ((cup.group_nights || []).includes(d)) return "Group Play";
  const home = String(play.HomeTeamName || "").trim();
  const away = String(play.AwayTeamName || "").trim();
  const sides = home && away ? [home, away] : [String(play.TeamAtMoment || "").trim()];
  for (const game of cup.knockout || []) {
    if (game.date !== d) continue;
    const teams = game.teams || [];
    if (sides.every((t) => t && teams.includes(t))) return game.round;
  }
  return null;
}

// Checked in order: one-day events and sub-windows before the broad regular
// range that contains them. A null label means "no games were played then".
const CONTEXT_WINDOWS = [
  ["allstar", "All-Star"],
  ["commissioners_cup", "Commissioner's Cup Final"],
  ["playin", "Play-In"],
  ["playoffs", "Playoffs"],
  ["preseason", "Preseason"],
  ["suspended", null],
  ["regular", "Regular Season"]
];

export const OUTSIDE_SEASON_WINDOWS = "Outside season windows";
export const NBA_CUP_CONTEXT = "NBA Cup";

/*
 * Mint era of a play: "season" when the play happened in the league season
 * it was minted in (mint time from the mint clock, see buildMintClock),
 * "historical" when the play is from an earlier season (archive drops,
 * Run It Back, the Anthology sets). Feeds the homepage era matrix and the
 * Plays ?era= deep link.
 */
export const MINT_ERAS = ["season", "historical"];
export function mintEra(play, mintClock) {
  const ps = parentSeason(play.NbaSeason);
  const mintDate = mintClock ? mintClock.get(Number(play.playID)) : null;
  const start = mintDate ? mintSeasonStart(mintDate, isWnbaTeamId(play.TeamAtMomentNBAID)) : "";
  // No season or no mint date to compare: nothing says it is historical,
  // and the handful of such plays are in-season drops
  if (!ps || !start) return "season";
  return Number(String(ps).slice(0, 4)) >= Number(start) ? "season" : "historical";
}

/**
 * The league season a mint belongs to, as its start year: the calendar
 * season of the mint date, except that the offseason belongs to the
 * season just finished. A 2023 playoff moment minted in August 2023 is
 * still 2022-23 (the July Honors drops, the Rookie Mint of a 2022-23
 * rookie); it becomes 2023-24 once that season tips off (preseason, else
 * regular season). A next season not yet in the calendar cannot have
 * tipped off. Shared by the era split and Rookie Mint.
 */
export function mintSeasonStart(mintDate, wnba) {
  const start = seasonStartYearForDate(mintDate, wnba);
  if (!start) return "";
  const startYear = Number(start);
  const key = wnba ? String(startYear) : `${startYear}-${String(startYear + 1).slice(2)}`;
  const w = seasonWindows(wnba ? "WNBA" : "NBA", key);
  const tip = w && ((w.preseason && w.preseason[0]) || (w.regular && w.regular[0]));
  if (!tip || String(mintDate).slice(0, 10) < tip) return String(startYear - 1);
  return start;
}

/**
 * The season a Summer League is filed under: "2021 Summer League" (July
 * and August 2021) precedes and belongs to "2021-22". Any other season
 * string comes back unchanged (trimmed).
 */
export function parentSeason(season) {
  const s = String(season || "").trim();
  const m = s.match(/^(\d{4}) Summer League$/i);
  if (!m) return s;
  const year = Number(m[1]);
  return `${year}-${String(year + 1).slice(2)}`;
}

/**
 * Classifies WHEN a play's moment happened within its own season:
 * "Regular Season", "Playoffs", "Play-In", "All-Star", "Preseason",
 * "Summer League", "NBA Cup" (with `detail` naming the round),
 * "Commissioner's Cup Final", or OUTSIDE_SEASON_WINDOWS when the date falls
 * in none of the season's game windows (the audit treats that as a finding:
 * the date, the season, or the calendar entry is wrong). Returns null when
 * the play has no usable date/season or the season is not in seasons.json
 * yet.
 */
export function momentContext(play) {
  if (!play) return null;
  const season = String(play.NbaSeason || "").trim();
  const d = String(play.DateOfMoment || "").slice(0, 10);
  // Dapper stamps some dateless reels with the Unix epoch (1970-01-01);
  // anything before the league existed is "no date", not a bad date
  if (!season || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < "1946-01-01") return null;
  const league = isWnbaTeamId(play.TeamAtMomentNBAID) ? "WNBA" : "NBA";
  const w = seasonWindows(league, season);
  if (!w) return null;
  if (/summer league/i.test(season)) {
    return { context: inWindow(d, w.regular) ? "Summer League" : OUTSIDE_SEASON_WINDOWS, season, league };
  }
  const round = cupRound(d, play, w.cup);
  if (round) return { context: NBA_CUP_CONTEXT, detail: round, season, league };
  for (const [key, label] of CONTEXT_WINDOWS) {
    if (inWindow(d, w[key])) {
      return { context: label || OUTSIDE_SEASON_WINDOWS, season, league };
    }
  }
  // Cross-league cameo (Sabrina Ionescu at NBA All-Star Saturday 2024): when
  // the date fits nothing in the play's own league, the other league's
  // All-Star window decides, whichever of its seasons it falls in. `cameo`
  // marks it: the moment is outside its own league's season, so season
  // honours (Championship Year) do not apply to it.
  const other = seasonsAdditions[league === "WNBA" ? "NBA" : "WNBA"] || {};
  if (Object.values(other).some((ow) => inWindow(d, ow.allstar))) {
    return { context: "All-Star", season, league, cameo: true };
  }
  return { context: OUTSIDE_SEASON_WINDOWS, season, league };
}

export function getCalculatedPlayTags(play, allPlays, tsdIndex, mintClock) {
  if (!play) return [];

  // Seed with the stored (Dapper) tags, minus the computable ones
  const tags = new Set((play.tags || []).filter((t) => !COMPUTABLE_TAG_NAMES.has(t)));

  // 1. A signed edition -> Autograph. The chain flags the PLAY
  // (PlayerAutographType), one value for every parallel, but the signature
  // is a fact of one parallel, so the badge follows data/autographs.json
  // (autograph.service; editionBadges narrows it per edition or parallel).
  // The chain flag is checked against it on the Corrections page
  if (playSigned(play.playID)) {
    tags.add("Autograph");
  }

  // 2. Minted during the player's rookie season -> Rookie Mint.
  // Mint time comes from the mint clock (see buildMintClock); the season it
  // falls in is league-aware. Distinct from Rookie Year (rule 4), which is
  // about when the MOMENT happened: a 2003 LeBron highlight minted in 2021
  // is Rookie Year but not Rookie Mint. Without a clock (no allPlays and no
  // prebuilt clock) the tag is simply not derived.
  const rookieStart = rookieSeasonStart(play);
  const clock = mintClock || (allPlays ? buildMintClock(allPlays) : null);
  if (rookieStart && clock) {
    const mintDate = clock.get(Number(play.playID));
    // The offseason counts toward the finished season (mintSeasonStart):
    // a July Honors mint of a 2022-23 rookie is a Rookie Mint
    if (mintDate && mintSeasonStart(mintDate, isWnbaTeamId(play.TeamAtMomentNBAID)) === rookieStart) {
      tags.add("Rookie Mint");
    }
  }

  // 3. Earliest appearance of player name -> TSD
  if (allPlays || tsdIndex) {
    const { name: nameToCheck, isTeamMoment } = getDebutName(play);

    if (nameToCheck !== "") {
      const emoji = getTeamEmoji(play.TeamAtMoment, play.TeamAtMomentNBAID);
      const isAllStar = (emoji === "⭐");
      const isMismint = playsExcludeSet.has(String(play.playID));

      if (!(isTeamMoment && isAllStar) && !isMismint) {
        const index = tsdIndex || buildTsdIndex(allPlays);
        const primaryTsdPlay = index.get(nameToCheck.toLowerCase());

        if (primaryTsdPlay) {
          const isPrimaryTsd = Number(play.playID) === Number(primaryTsdPlay.playID);

          if (isPrimaryTsd) {
            tags.add("Top Shot Debut");
          } else {
            // Rule 3 (see buildTsdIndex): a twin of the debut, the same
            // game and the same play category, is the same highlight
            // re-created for a companion set and shares the badge. A
            // different highlight from the same game does not.
            const day = gameDay(play);
            if (day !== "" && day === gameDay(primaryTsdPlay) && playCategory(play) === playCategory(primaryTsdPlay)) {
              tags.add("Top Shot Debut");
            }
          }
        }
      }
    }
  }

  // 4. The moment is from the player's rookie season -> Rookie Year
  if (play.NbaSeason && rookieStart) {
    const seasonStart2 = String(play.NbaSeason).trim().substring(0, 4);
    if (seasonStart2 && seasonStart2 === rookieStart) {
      tags.add("Rookie Year");
    }
  }

  // 5. Team won the championship that season (teams.json championships)
  // -> Championship Year; won its league's in-season cup (teams.json
  // cups: NBA Cup, Commissioner's Cup) -> Cup Year. Same mechanics,
  // separate honor lists; a season can carry both (Knicks 2025-26). A
  // cross-league cameo (a WNBA player at
  // the NBA All-Star weekend, #4888 Ionescu) happened outside her own
  // league's season, so it earns no Championship Year (matches
  // Dapper Labs' badging).
  if (play.NbaSeason) {
    const nbaID = play.TeamAtMomentNBAID;
    if (nbaID) {
      const teamData = teamsAdditions[String(nbaID)];
      const won = (list) => teamData && Array.isArray(list) && list.includes(play.NbaSeason);
      const wonTitle = won(teamData && teamData.championships);
      const wonCup = won(teamData && teamData.cups);
      // The cameo check is the expensive part (context-window scan), so
      // it only runs once a winning season actually matched
      if ((wonTitle || wonCup) && momentContext(play)?.cameo !== true) {
        if (wonTitle) tags.add("Championship Year");
        if (wonCup) tags.add("Cup Year");
      }
    }
  }

  // 6. Player enshrined in the Naismith Hall of Fame (Player category)
  // -> Hall of Fame. A career honor: every play of the player carries
  // it. Team moments have no FullName and are naturally excluded.
  if (play.FullName) {
    const hofKey = normPlayerName(play.FullName);
    if (hofKey && hofNames().has(hofKey)) tags.add("Hall of Fame");
  }

  // 7. Negative tag semantics: a `tags_suppress` array on the play's
  // additions entry removes a derived tag the rules wrongly produce for
  // this one play (the per-play exception valve; use sparingly, policy
  // fixes belong in the rules). e.g. "tags_suppress": ["Top Shot Debut"].
  if (Array.isArray(play.tags_suppress)) {
    play.tags_suppress.forEach((t) => tags.delete(t));
  }

  return Array.from(tags);
}
