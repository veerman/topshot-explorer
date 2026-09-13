import { playSigned } from "./autograph.service";
import playsAdditions from "../../data/additions/plays.json";
import playsOverrides from "../../data/overrides/plays.json";
import teamsAdditions from "../../data/additions/teams.json";
import { getCalculatedPlayTags, buildTsdIndex, buildMintClock, seasonStartYearForDate, mintSeasonStart, rookieSeasonStart, getAdditionsTeamNameMap, getTeamEmoji, momentContext, OUTSIDE_SEASON_WINDOWS, isMismintPlay, isWnbaTeamId as isWnbaId, isSentinelValue } from "./overrides.service";

// House season format from a moment date: WNBA single year; NBA "YYYY-YY".
// Derived from seasonStartYearForDate so the irregular-season table (the
// 2019-20 bubble, the late 2020-21 start) applies here too; the old local
// copy used a plain July boundary and mis-seasoned those edges.
const seasonFromDate = (dateStr, wnba) => {
  const y = seasonStartYearForDate(dateStr, wnba);
  if (!y) return null;
  if (wnba) return y;
  const n = Number(y);
  return `${n}-${String((n + 1) % 100).padStart(2, "0")}`;
};

const dateOnly = (dateStr) => (String(dateStr || "").match(/^\d{4}-\d{2}-\d{2}/) || [""])[0];

// One-line evidence for a play, shown beside its ID on the Corrections page so a
// judgment rarely needs a click-through: team · date · season · category
export function playContext(play) {
  if (!play) return "";
  return [
    play.TeamAtMoment,
    dateOnly(play.DateOfMoment) || "no date",
    play.NbaSeason || "no season",
    play.PlayCategory || play.PlayType
  ].filter(Boolean).join(" · ");
}

// Data-quality detectors for the Corrections page "Open Findings" tab. Each
// detector scans the compiled plays (overrides/additions already applied)
// and returns structured findings. Every suggested fix carries a `patch`
// object shaped exactly like an entry set for its target file, so the fix
// queue can deep-merge many of them into one paste-ready JSON block:
//   data/overrides/plays.json  corrects values that are wrong on-chain
//   data/additions/plays.json  adds context that never existed on-chain

const stripDiacritics = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const isRealValue = (val) =>
  val !== undefined &&
  val !== null &&
  val !== "0" &&
  !isSentinelValue(val) &&
  String(val).trim() !== "";

// ---------------------------------------------------------------------------
// Correction classifier for the Applied Corrections ledger. Not every change
// carries the same weight: a scripted GUID mapping is not a correction at all,
// an accent restoration is a house rule, and a changed birthdate is a
// researched factual fix. Tiers:
//   "context"  additions that never claim the chain was wrong (dapper IDs,
//              tags, headlines); hidden in the ledger by default
//   "routine"  deterministic applications of house rules (accents, casing,
//              formats, era-accurate franchise names, canonical player names)
//   "factual"  a fact the chain got wrong, fixed by lookup; the ones worth
//              human attention when reviewing history
// ---------------------------------------------------------------------------
const CONTEXT_FIELDS = new Set(["tags", "headline", "description", "date", "signer"]);
// A hand decision on a derived badge: `tags_suppress` on the play's
// additions entry, explained by its `note`. Shown as its own kind of
// correction (the badge the rule derives, withheld), never as a field diff
const SUPPRESS_FIELD = "tags_suppress";
const NOTE_FIELD = "note";
const TEAM_NAME_FIELDS = new Set(["draftteam", "teamatmoment", "currentteam", "hometeamname", "awayteamname"]);

export function classifyCorrection(field, beforeRaw, afterRaw) {
  const f = field.toLowerCase();
  const before = String(beforeRaw ?? "").trim();
  const after = String(afterRaw ?? "").trim();

  if (CONTEXT_FIELDS.has(f)) return { tier: "context", label: "context" };

  const beforeEmpty = before === "" || isSentinelValue(before) || before === "0";
  if (beforeEmpty) return { tier: "factual", label: "filled gap" };
  if (before.toLowerCase() === after.toLowerCase()) return { tier: "routine", label: "casing" };
  if (stripDiacritics(before).toLowerCase() === stripDiacritics(after).toLowerCase()) {
    return { tier: "routine", label: "accent" };
  }

  if (TEAM_NAME_FIELDS.has(f)) {
    // Same franchise under a different era name is a house rule, not a fact fix
    const map = getAdditionsTeamNameMap();
    const b = map[before.toLowerCase()];
    const a = map[after.toLowerCase()];
    if (b && a && b === a) return { tier: "routine", label: "era name" };
    return { tier: "factual", label: "factual fix" };
  }
  if (f === "fullname") return { tier: "routine", label: "canonical name" };
  if (f === "birthplace") {
    const bCity = stripDiacritics(before.split(",")[0]).trim().toLowerCase();
    const aCity = stripDiacritics(after.split(",")[0]).trim().toLowerCase();
    if (bCity === aCity) return { tier: "routine", label: "format" };
    return { tier: "factual", label: "factual fix" };
  }
  if (f === "nbaseason") {
    const by = before.match(/\d{4}/);
    const ay = after.match(/\d{4}/);
    if (by && ay && by[0] === ay[0]) return { tier: "routine", label: "format" };
    return { tier: "factual", label: "factual fix" };
  }
  return { tier: "factual", label: "factual fix" };
}

// ---------------------------------------------------------------------------
// Applied Corrections ledger: one record per play whose compiled record
// differs from its raw on-chain record (or that is a mismint), with every
// field diff classified by classifyCorrection. Shared by the Corrections page
// ledger tab and the home page summary card so the two never disagree.
// ---------------------------------------------------------------------------
export function buildCorrectionLedger(playsRaw, playsCorrected) {
  if (!playsRaw || !playsCorrected || playsRaw.length === 0 || playsCorrected.length === 0) return [];

  const records = [];

  // Index raw plays by ID once instead of scanning the array per play
  const rawById = new Map();
  playsRaw.forEach((rp) => {
    rawById.set(Number(rp.playID), rp);
  });

  playsCorrected.forEach((correctedPlay) => {
    const playID = correctedPlay.playID;
    const rawPlay = rawById.get(Number(playID));

    const isMismint = isMismintPlay(playID);
    const diffs = [];

    const playIDStr = String(playID);
    const ovKeys = rawPlay ? Object.keys(playsOverrides[playIDStr] || {}) : [];
    const adKeys = rawPlay ? Object.keys(playsAdditions[playIDStr] || {}) : [];

    // Most plays carry no override or addition at all; their diff list is
    // provably empty, so the per-play indexing below is skipped entirely
    if (ovKeys.length + adKeys.length > 0) {
      // Raw plays keep their original on-chain key casing, which often
      // differs from the standardized corrected casing. Index BOTH sides
      // case-insensitively so raw values are actually found (a direct
      // rawPlay[key] lookup silently reported corrections as pure
      // additions) and so the corrected key is found in one lookup
      // instead of an Object.keys().find() per override key.
      const rawByLowerKey = {};
      Object.keys(rawPlay).forEach((rk) => {
        rawByLowerKey[rk.toLowerCase()] = rawPlay[rk];
      });
      const correctedKeyByLower = {};
      Object.keys(correctedPlay).forEach((ck) => {
        correctedKeyByLower[ck.toLowerCase()] = ck;
      });

      const comparisonKeys = new Set();
      [...ovKeys, ...adKeys].forEach((k) => {
        const lk = k.toLowerCase();
        if (lk !== "playid") {
          comparisonKeys.add(correctedKeyByLower[lk] || k);
        }
      });

      comparisonKeys.forEach((key) => {
        const lk = key.toLowerCase();
        if (lk === NOTE_FIELD) return; // read beside the suppression below
        if (lk === SUPPRESS_FIELD) {
          const withheld = Array.isArray(correctedPlay[key]) ? correctedPlay[key] : [];
          withheld.forEach((tag) => {
            diffs.push({
              field: `${tag} badge`,
              before: "derived by the rule",
              after: `withheld${correctedPlay[NOTE_FIELD] ? `: ${correctedPlay[NOTE_FIELD]}` : ""}`,
              isAddition: false,
              tier: "factual",
              label: "badge withheld"
            });
          });
          return;
        }
        const rawVal = rawByLowerKey[lk];
        const correctedVal = correctedPlay[key];

        const rawStr = rawVal === undefined || rawVal === null ? "" : String(rawVal).trim();
        const correctedStr = correctedVal === undefined || correctedVal === null ? "" : String(correctedVal).trim();

        if (rawStr !== correctedStr) {
          const isAddition = rawStr === "" && correctedStr !== "";
          diffs.push({
            field: key,
            before: rawStr || "[Not Present]",
            after: correctedStr || "[Removed]",
            isAddition,
            ...classifyCorrection(key, rawStr, correctedStr)
          });
        }
      });
    }

    // Listed only when there is something to show (mismint, override, or addition)
    if (isMismint || diffs.length > 0) {
      records.push({
        playID,
        fullName: correctedPlay.FullName,
        rawFullNameString: rawPlay?.FullName || `Play #${playID}`,
        isMismint,
        diffs,
        // Context additions are not corrections; the count reflects real ones
        errorCount: diffs.filter((d) => d.tier !== "context").length
      });
    }
  });

  return records;
}

// Ledger-wide weight distribution: diffs per tier, mismint plays, and the
// number of plays carrying at least one real (non-context) correction
export function summarizeLedger(records) {
  let factual = 0;
  let routine = 0;
  let context = 0;
  let mismints = 0;
  let plays = 0;
  // Per kind (classifyCorrection labels): what the corrections actually are
  const byLabel = {};
  (records || []).forEach((r) => {
    if (r.isMismint) mismints++;
    if (r.errorCount > 0) plays++;
    r.diffs.forEach((d) => {
      if (d.tier === "factual") factual++;
      else if (d.tier === "routine") routine++;
      else context++;
      if (d.tier !== "context") byLabel[d.label] = (byLabel[d.label] || 0) + 1;
    });
  });
  return { factual, routine, context, mismints, plays, byLabel };
}

const conflictFixes = (values, field, file) =>
  values.map(({ value }) => {
    const patch = {};
    values.forEach((other) => {
      if (other.value === value) return;
      other.playIDs.forEach((id) => {
        patch[String(id)] = { [field]: value };
      });
    });
    return { label: `Use "${value}"`, file, patch };
  });

/**
 * Same player name spelled multiple ways (usually accent / encoding drift,
 * e.g. "Luka Doncic" vs "Luka Dončić"). One fix per candidate spelling,
 * rewriting every other spelling to it.
 */
export function detectNameSpellingConflicts(plays) {
  const nameMap = {}; // normalizedName -> { rawSpelling -> [playIDs] }

  plays.forEach((play) => {
    const rawName = play.FullName ? play.FullName.trim() : "";
    if (rawName === "" || rawName.toLowerCase() === "team moment") return;

    const normalized = stripDiacritics(rawName).toLowerCase();
    if (!nameMap[normalized]) nameMap[normalized] = {};
    if (!nameMap[normalized][rawName]) nameMap[normalized][rawName] = [];
    nameMap[normalized][rawName].push(play.playID);
  });

  const findings = [];
  Object.entries(nameMap).forEach(([normalized, spellings]) => {
    const entries = Object.entries(spellings);
    if (entries.length < 2) return;

    const values = entries
      .map(([value, playIDs]) => ({ value, playIDs: [...playIDs].sort((a, b) => a - b) }))
      .sort((a, b) => b.playIDs.length - a.playIDs.length);

    findings.push({
      key: `name:${normalized}`,
      title: values[0].value,
      values,
      playIDs: values.flatMap((v) => v.playIDs),
      fixes: conflictFixes(values, "FullName", "data/overrides/plays.json")
    });
  });

  // Second pass: nickname drift ("Stephen Curry" vs "Steph Curry"), invisible
  // to the diacritic pass. Cluster by birthdate + last name (suffixes like
  // Jr./II stripped), then require the first names to agree on a prefix:
  // birthdate + surname alone would false-positive on twins (Marcus/Markieff
  // Morris, Amen/Ausar Thompson share both).
  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
  const clusters = {}; // `${birthdate}|${lastName}` -> { rawName -> [playIDs] }
  plays.forEach((play) => {
    const rawName = play.FullName ? play.FullName.trim() : "";
    if (rawName === "" || rawName.toLowerCase() === "team moment") return;
    const bd = String(play.Birthdate || "").trim();
    if (!bd) return;
    const tokens = stripDiacritics(rawName).toLowerCase().split(/\s+/);
    while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1].replace(/\./g, ""))) tokens.pop();
    if (tokens.length < 2) return;
    const key = `${bd}|${tokens[tokens.length - 1]}`;
    if (!clusters[key]) clusters[key] = {};
    if (!clusters[key][rawName]) clusters[key][rawName] = [];
    clusters[key][rawName].push(play.playID);
  });

  const firstToken = (name) => stripDiacritics(name).toLowerCase().split(/\s+/)[0];
  Object.entries(clusters).forEach(([key, spellings]) => {
    const entries = Object.entries(spellings);
    if (entries.length < 2) return;
    // Already covered by the diacritic pass when every spelling normalizes equal
    const norms = new Set(entries.map(([v]) => stripDiacritics(v).toLowerCase()));
    if (norms.size < 2) return;
    // First names must agree on a shared prefix (min 3, up to 4 chars)
    const firsts = entries.map(([v]) => firstToken(v));
    const prefLen = Math.min(4, ...firsts.map((f) => f.length));
    const prefixes = new Set(firsts.map((f) => f.slice(0, prefLen)));
    if (prefixes.size > 1) return;

    const values = entries
      .map(([value, playIDs]) => ({ value, playIDs: [...playIDs].sort((a, b) => a - b) }))
      .sort((a, b) => b.playIDs.length - a.playIDs.length);

    findings.push({
      key: `name-variant:${key}`,
      title: values[0].value,
      values,
      playIDs: values.flatMap((v) => v.playIDs),
      fixes: conflictFixes(values, "FullName", "data/overrides/plays.json")
    });
  });

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

const PROFILE_FIELDS = ["DraftYear", "DraftRound", "DraftSelection", "DraftTeam", "Birthdate", "Birthplace"];

/**
 * Conflicting biographical values across one player's plays (two different
 * birthplaces, draft years, and so on). These are permanent facts, so more
 * than one non-empty value is always an error somewhere. One fix per
 * candidate value, rewriting the plays that disagree with it.
 */
export function detectProfileConflicts(plays) {
  const playersMap = {}; // name -> { field -> { value -> [playIDs] } }

  plays.forEach((play) => {
    const name = play.FullName ? play.FullName.trim() : "";
    if (name === "" || name.toLowerCase() === "team moment") return;

    if (!playersMap[name]) {
      playersMap[name] = {};
      PROFILE_FIELDS.forEach((f) => (playersMap[name][f] = {}));
    }
    PROFILE_FIELDS.forEach((field) => {
      const val = play[field];
      if (!isRealValue(val)) return;
      const cleanVal = String(val).trim();
      if (!playersMap[name][field][cleanVal]) playersMap[name][field][cleanVal] = [];
      playersMap[name][field][cleanVal].push(play.playID);
    });
  });

  const findings = [];
  Object.entries(playersMap).forEach(([name, fields]) => {
    Object.entries(fields).forEach(([field, valMap]) => {
      const entries = Object.entries(valMap);
      if (entries.length < 2) return;

      const values = entries
        .map(([value, playIDs]) => ({ value, playIDs: [...playIDs].sort((a, b) => a - b) }))
        .sort((a, b) => b.playIDs.length - a.playIDs.length);

      findings.push({
        key: `profile:${name}:${field}`,
        title: name,
        field,
        values,
        playIDs: values.flatMap((v) => v.playIDs),
        fixes: conflictFixes(values, field, "data/overrides/plays.json")
      });
    });
  });

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

// Computable tags: derived by getCalculatedPlayTags from the play data and
// teams.json, which is authoritative for display. The stored tags array is
// the external Dapper import. The short code is only an internal key for
// grouping and section titles.
const TAG_PAIRS = [
  ["TSD", "Top Shot Debut"],
  ["RY", "Rookie Year"],
  ["CY", "Championship Year"],
  ["RM", "Rookie Mint"]
];

/**
 * Compares the external Dapper tag data against our derivation, under the
 * lean-files principle: anything computable downstream does not belong in
 * additions.
 * - A stored tag that AGREES with the derivation is not a finding. It is a
 *   hard rule, not a judgment: `npm run reconcile` (also the prebuild step)
 *   strips such copies from additions automatically. They are only counted
 *   here (`agreeing`) so the page can say how many are pending that pass.
 * - A "disagreement" is a stored tag the data does not derive. Either side
 *   could be wrong: our data (missing season, wrong DraftYear or team ID, a
 *   championship missing from teams.json) or Dapper. The stored tag is a
 *   correction marker; it stays until resolved. Fixing our data turns it
 *   into an agreement (then the reconciler strips it); concluding Dapper is
 *   wrong makes removal the fix.
 * A tag Dapper omitted is never a finding: the derivation displays it anyway.
 *
 * Tags derive from names and draft data, so findings for players with open
 * upstream findings are `blocked` (the derived side itself may be wrong).
 * Each finding carries a `premise` showing what the data says.
 *
 * Returns { findings, agreeing } where agreeing is a per-shortTag count.
 */
export function detectTagMismatches(plays, upstream) {
  const blockedNames = (upstream && upstream.blockedNames) || new Set();
  const draftYearConflictNames = (upstream && upstream.draftYearConflictNames) || new Set();
  const tsdIndex = buildTsdIndex(plays);
  const mintClock = buildMintClock(plays);
  const findings = [];
  const agreeing = {};
  TAG_PAIRS.forEach(([shortTag]) => { agreeing[shortTag] = 0; });

  plays.forEach((play) => {
    const idStr = String(play.playID);
    const additionsEntry = playsAdditions[idStr] || {};
    const additionTags = Array.isArray(additionsEntry.tags) ? additionsEntry.tags : [];
    if (additionTags.length === 0) return;

    // Purely derived tags: strip stored tags so the seed cannot mask the data
    const derived = getCalculatedPlayTags({ ...play, tags: [] }, null, tsdIndex, mintClock);
    const playerName = (play.FullName || "").trim();
    const nameKey = playerName.toLowerCase();

    TAG_PAIRS.forEach(([shortTag, longTag]) => {
      if (!additionTags.includes(longTag)) return;
      if (derived.includes(longTag)) {
        // Agreement: reconciled by the script, nothing to decide
        agreeing[shortTag]++;
        return;
      }
      const kind = "disagreement";

      // What our data says about the tag Dapper stored, plus a machine
      // recommendation wherever the resolution is computable, so the human
      // only judges what the machine could not.
      let premise;
      let premisePlayID = null;
      let fixes = [{
        label: `Remove tag "${longTag}"`,
        file: "data/additions/plays.json",
        patch: { [idStr]: { tags: additionTags.filter((t) => t !== longTag) } }
      }];
      const momentDate = dateOnly(play.DateOfMoment);
      // Inline evidence for judgment rows: no clicking into moments
      const context = playContext(play);

      if (shortTag === "TSD") {
        const primary = tsdIndex.get(nameKey);
        if (primary) {
          const debutDate = dateOnly(primary.DateOfMoment);
          premisePlayID = Number(primary.playID);
          if (debutDate && debutDate === momentDate) {
            // A second play from the same game as the debut. The rule
            // (buildTsdIndex) shares the badge only with a twin, the same
            // play category; a different highlight from that game is not
            // a debut, whatever Dapper stored
            premise = `same game as the derived debut #${primary.playID} (${debutDate}) but a different highlight (${play.PlayCategory || "no category"} vs ${primary.PlayCategory || "no category"}); only a twin of the debut shares the badge`;
          } else {
            premise = `derived debut for "${playerName || play.TeamAtMoment}" is #${primary.playID}${debutDate ? ` (${debutDate})` : ""}`;
          }
        } else {
          premise = "no qualifying debut data for this name (excluded or all-star)";
        }
      } else if (shortTag === "RM") {
        // Rookie Mint = minted during the rookie season, per the mint clock
        // (the offseason counts toward the finished season) and the rookie
        // season (draft year, or data/additions/rookie_seasons.json)
        const mintDate = mintClock.get(Number(play.playID)) || "";
        const mintSeason = mintSeasonStart(mintDate, isWnbaId(play.TeamAtMomentNBAID));
        const rookieRM = rookieSeasonStart(play);
        premise = `mint clock ${mintDate || "(no date)"} -> mint season ${mintSeason || "?"} vs rookie season ${rookieRM || "(unknown: no DraftYear and no rookie_seasons.json entry)"}${rookieRM && rookieRM !== String(play.DraftYear || "").trim() ? ` (rookie_seasons.json; DraftYear ${play.DraftYear || "(empty)"})` : ""}`;
      } else if (shortTag === "RY") {
        const rookieRY = rookieSeasonStart(play);
        if (!rookieRY || rookieRY !== String(play.DraftYear || "").trim()) {
          // A late debut (injury redshirt, draft-and-stash, undrafted) is
          // a rookie_seasons.json entry, not a per-play override
          premise = `rookie season ${rookieRY || "unknown"} (${rookieRY ? "rookie_seasons.json" : "no DraftYear and no rookie_seasons.json entry"}; DraftYear ${play.DraftYear || "(empty)"}) vs season ${play.NbaSeason || "(empty)"}`;
        } else {
          premise = `rookie season ${rookieRY} (DraftYear) vs season ${play.NbaSeason || "(empty)"}`;
        }
      } else {
        const team = play.TeamAtMoment || "this team";
        {
          const teamData = teamsAdditions[String(play.TeamAtMomentNBAID)] || {};
          const champs = Array.isArray(teamData.championships) ? teamData.championships : [];
          const wnba = isWnbaId(play.TeamAtMomentNBAID);

          // Candidate seasons the data itself suggests: from the moment date,
          // or from re-formatting the stored season to the house format
          let candidate = null;
          const fromDate = seasonFromDate(play.DateOfMoment, wnba);
          if (fromDate && champs.includes(fromDate) && fromDate !== play.NbaSeason) candidate = fromDate;
          if (!candidate && play.NbaSeason) {
            const y4 = String(play.NbaSeason).match(/\d{4}/);
            if (y4) {
              const alt = wnba ? y4[0] : `${y4[0]}-${String((Number(y4[0]) + 1) % 100).padStart(2, "0")}`;
              if (alt !== play.NbaSeason && champs.includes(alt)) candidate = alt;
            }
          }

          // A dateless, seasonless play (team moments) with a single-title
          // team: Dapper's tag pins the season unambiguously
          if (!candidate && !momentDate && !play.NbaSeason && champs.length === 1) candidate = champs[0];

          if (candidate) {
            const basis = momentDate ? `moment date ${momentDate}` : play.NbaSeason ? "season format" : `${team}${team.endsWith("s") ? "'" : "'s"} only title`;
            premise = `${basis} implies season ${candidate}, a listed title year for ${team}; fix the season and the tag derives itself`;
            fixes = [{
              label: `Set season "${candidate}"`,
              file: "data/overrides/plays.json",
              patch: { [idStr]: { NbaSeason: candidate } }
            }];
          } else if (!momentDate && !play.NbaSeason) {
            // Nothing to derive from: a human must supply the season
            premise = `no date or season to derive from; ${team} titles in teams.json: ${champs.length ? champs.join(", ") : "none"}. Set NbaSeason by hand, or remove the tag`;
          } else {
            premise = `season ${play.NbaSeason || "(empty)"} is not a listed title year for ${team}; teams.json lists ${champs.length ? champs.join(", ") : "no titles"}`;
          }
        }
      }

      // Upstream dependency gating
      let blocked = false;
      let blockedReason = "";
      if (blockedNames.has(nameKey)) {
        blocked = true;
        blockedReason = "open name-spelling finding for this player; the derived side may be wrong";
      } else if ((shortTag === "RY" || shortTag === "RM") && draftYearConflictNames.has(playerName)) {
        blocked = true;
        blockedReason = "open DraftYear conflict for this player; the derived side may be wrong";
      }

      // One decision covers many plays: a championship is per team+season, a
      // rookie season is per player+season, a debut is per player. The UI
      // renders one group per decision with the plays as chips.
      let group;
      let groupLabel;
      if (shortTag === "CY") {
        group = `CY:${kind}:${play.TeamAtMoment || "?"}:${play.NbaSeason || "?"}`;
        groupLabel = `${play.TeamAtMoment || "Unknown team"} · ${play.NbaSeason || "no season"}`;
      } else if (shortTag === "RY" || shortTag === "RM") {
        group = `${shortTag}:${kind}:${nameKey}:${play.NbaSeason || "?"}`;
        groupLabel = `${playerName || play.TeamAtMoment || "?"} · ${play.NbaSeason || "no season"}`;
      } else {
        group = `TSD:${kind}:${nameKey || play.playID}`;
        groupLabel = playerName || play.TeamAtMoment || `Play ${play.playID}`;
      }

      findings.push({
        key: `tag:${play.playID}:${shortTag}`,
        title: play.FullName || play.TeamAtMoment || `Play ${play.playID}`,
        shortTag,
        longTag,
        group,
        groupLabel,
        premise,
        premisePlayID,
        context,
        kind,
        blocked,
        blockedReason,
        values: [],
        playIDs: [play.playID],
        fixes
      });
    });
  });

  return { findings: findings.sort((a, b) => a.playIDs[0] - b.playIDs[0]), agreeing };
}

/*
 * Bounds sanity rules, ported from the retired validator project's rules.csv
 * (2026-06). Each rule: [field, min, max, zeroIsAbsent, hint]. Values outside
 * the range are almost always unit errors (cm heights, kg weights),
 * concatenations, or column swaps. Findings only; fixing is a judgment.
 */
const RANGE_RULES = [
  ["HomeTeamScore", 30, 300, true, "concatenated or truncated score"],
  ["AwayTeamScore", 30, 300, true, "concatenated or truncated score"],
  ["Height", 48, 108, true, "inches expected; 140-260 is likely centimeters"],
  ["Weight", 100, 500, true, "pounds expected; 60-99 is likely kilograms"],
  ["TotalYearsExperience", 0, 40, false, "likely a year or garbage value"],
  ["DraftYear", 1946, 2100, true, "outside the BAA/NBA era"],
  ["DraftRound", 1, 50, true, "arbitrary large number"],
  ["DraftSelection", 1, 500, true, "possible year/selection column swap"]
];

export function detectOutOfBoundsValues(plays) {
  const findings = [];
  const push = (play, field, value, premise) => {
    findings.push({
      key: `bounds:${play.playID}:${field}`,
      title: play.FullName || play.TeamAtMoment || `Play ${play.playID}`,
      field,
      premise,
      values: [{ value: String(value), count: 1, playIDs: [play.playID] }],
      playIDs: [play.playID],
      fixes: []
    });
  };

  plays.forEach((play) => {
    // All-star target-score mini-games (2025+ format: first to 40) have
    // legitimately tiny final scores; skip score bounds for ⭐ entities.
    // Resolved once per play, not once per score rule.
    const isAllStarEntity = getTeamEmoji(play.TeamAtMoment, play.TeamAtMomentNBAID) === "⭐";
    RANGE_RULES.forEach(([field, min, max, zeroAbsent, hint]) => {
      if ((field === "HomeTeamScore" || field === "AwayTeamScore") && isAllStarEntity) return;
      const rawVal = String(play[field] ?? "").trim();
      if (rawVal === "" || isSentinelValue(rawVal)) return;
      if (zeroAbsent && Number(rawVal) === 0) return;
      const num = Number(rawVal);
      if (!Number.isFinite(num)) {
        push(play, field, rawVal, `not a number; ${hint}`);
      } else if (num < min || num > max) {
        push(play, field, rawVal, `outside ${min}-${max}: ${hint}`);
      }
    });

    // Date sanity: epoch garbage and impossible birthdates
    const bd = dateOnly(play.Birthdate);
    if (bd === "1970-01-01") push(play, "Birthdate", bd, "Unix epoch artifact, not a real date");
    else if (bd && (bd < "1900-01-01" || bd > "2009-01-01")) push(play, "Birthdate", bd, "implies an impossible player age");
    const dom = dateOnly(play.DateOfMoment);
    if (dom === "1970-01-01") push(play, "DateOfMoment", dom, "Unix epoch artifact, not a real date");
    else if (dom && dom < "1946-11-01") push(play, "DateOfMoment", dom, "before the first BAA/NBA game");
  });

  return findings.sort((a, b) => a.playIDs[0] - b.playIDs[0]);
}

/*
 * Team ID <-> name integrity, ported from the retired validator's review
 * feature but validated against teams.json instead of majority vote (the
 * majority is wrong for era-accurate names). A play's TeamAtMoment must be
 * the current or a listed historical name of its TeamAtMomentNBAID. One
 * finding per (ID, name) pair covers every affected play; this is the
 * detector that would have caught the Fever/Stars alternate-name bug.
 */
export function detectTeamNameIdMismatches(plays) {
  const nameToId = getAdditionsTeamNameMap();
  const groups = new Map();

  plays.forEach((play) => {
    const id = String(play.TeamAtMomentNBAID || "").trim();
    const name = String(play.TeamAtMoment || "").trim();
    if (!id || !name) return;
    // All-star and event entities (Team LeBron, Rising Stars, ...) are not
    // franchises; the app's own test for them is the star emoji
    if (getTeamEmoji(name, id) === "⭐") return;
    const team = teamsAdditions[id];
    if (team && (team.special || !team.name)) return;
    const nameKey = name.toLowerCase();

    let premise;
    if (!team) {
      premise = `ID ${id} is not in teams.json`;
    } else {
      const allowed = new Set([String(team.name || "").toLowerCase()]);
      (team.historical_names || []).forEach((alias) => {
        const aliasName = typeof alias === "string" ? alias : alias && alias.name;
        if (aliasName) allowed.add(aliasName.trim().toLowerCase());
      });
      if (allowed.has(nameKey)) return;
      const owner = nameToId[nameKey];
      const ownerName = owner && teamsAdditions[owner] ? teamsAdditions[owner].name : null;
      premise = `ID ${id} is ${team.name}; "${name}" ${owner ? `belongs to ${ownerName} (${owner})` : "matches no franchise or historical name in teams.json"}`;
    }

    const gKey = `${id}|${nameKey}`;
    if (!groups.has(gKey)) {
      groups.set(gKey, {
        key: `team:${id}:${nameKey}`,
        title: `${name} · ID ${id}`,
        field: "TeamAtMoment",
        premise,
        values: [{ value: name, count: 0, playIDs: [] }],
        playIDs: [],
        fixes: []
      });
    }
    const g = groups.get(gKey);
    g.playIDs.push(play.playID);
    g.values[0].count++;
    g.values[0].playIDs.push(play.playID);
  });

  return [...groups.values()].sort((a, b) => a.playIDs[0] - b.playIDs[0]);
}

/**
 * Runs every detector over the compiled plays, in dependency order: names and
 * bios first, then tags with upstream findings feeding the blocking logic.
 * The Corrections page renders the result on its Open Findings tab.
 */
/*
 * Season-calendar sanity: a dated moment must fall inside one of its own
 * season's game windows (data/additions/seasons.json). A date in none of
 * them means the date, the season, or the calendar entry is wrong. Seasons
 * not yet in seasons.json are skipped (momentContext returns null), so an
 * incomplete calendar produces no noise.
 */
export function detectSeasonWindowFindings(plays) {
  const findings = [];
  plays.forEach((play) => {
    const ctx = momentContext(play);
    if (!ctx || ctx.context !== OUTSIDE_SEASON_WINDOWS) return;
    const d = dateOnly(play.DateOfMoment);
    findings.push({
      key: `seasonwin:${play.playID}`,
      title: play.FullName || play.TeamAtMoment || `Play ${play.playID}`,
      field: "DateOfMoment",
      premise: `${ctx.league} ${ctx.season}: ${d} falls in none of that season's game windows`,
      values: [{ value: d, count: 1, playIDs: [play.playID] }],
      playIDs: [play.playID],
      fixes: []
    });
  });
  return findings.sort((a, b) => a.playIDs[0] - b.playIDs[0]);
}

/*
 * The autograph: the chain flags the PLAY (PlayerAutographType), one value
 * for every parallel; data/autographs.json (Atlas) says which parallels
 * are signed, and the badge follows the file. A flagged play with nothing
 * signed, or a signed play without the flag, is a disagreement between
 * the two. Nothing to fix here: the rows stay until the chain carries the
 * fact per parallel.
 */
export function detectAutographFindings(plays) {
  const findings = [];
  plays.forEach((play) => {
    if (isMismintPlay(play.playID)) return;
    const flagged = play.PlayerAutographType === "Printed Autograph";
    const signed = playSigned(play.playID);
    if (flagged === signed) return;
    findings.push({
      key: `autograph:${play.playID}`,
      title: play.FullName || play.TeamAtMoment || `Play ${play.playID}`,
      field: "PlayerAutographType",
      premise: flagged
        ? "flagged Printed Autograph on chain, but no edition of the play is signed in Dapper Labs' catalogue: no badge"
        : "signed in Dapper Labs' catalogue, but the chain carries no autograph flag: the badge follows the catalogue",
      values: [{ value: flagged ? "Printed Autograph" : "(no flag)", count: 1, playIDs: [play.playID] }],
      playIDs: [play.playID],
      fixes: []
    });
  });
  return findings.sort((a, b) => a.playIDs[0] - b.playIDs[0]);
}

export function runDataAudits(plays) {
  const nameConflicts = detectNameSpellingConflicts(plays);
  const profileConflicts = detectProfileConflicts(plays);
  const boundsFindings = detectOutOfBoundsValues(plays);
  const teamFindings = detectTeamNameIdMismatches(plays);
  const seasonFindings = detectSeasonWindowFindings(plays);
  const autographFindings = detectAutographFindings(plays);

  // Every spelling in a name conflict taints that player's tag computations
  const blockedNames = new Set();
  nameConflicts.forEach((f) => {
    f.values.forEach((v) => blockedNames.add(v.value.trim().toLowerCase()));
  });
  const draftYearConflictNames = new Set(
    profileConflicts.filter((f) => f.field === "DraftYear").map((f) => f.title)
  );

  const { findings: tagMismatches, agreeing } = detectTagMismatches(plays, { blockedNames, draftYearConflictNames });

  // One section per tag type; the UI states each description exactly once
  const tagSections = TAG_PAIRS.map(([shortTag, longTag]) => ({
    shortTag,
    longTag,
    disagreements: tagMismatches.filter((f) => f.shortTag === shortTag)
  })).filter((s) => s.disagreements.length > 0);

  // Stored copies that agree with the derivation: stripped by the reconciler
  // (npm run reconcile / prebuild), reported so the page can say so
  const reconcilable = TAG_PAIRS.map(([shortTag, longTag]) => ({ shortTag, longTag, count: agreeing[shortTag] }))
    .filter((r) => r.count > 0);

  // Every finding carries a context line per play it names, so the page can
  // show team, date, season and category next to each play ID
  const contextById = new Map(plays.map((p) => [Number(p.playID), playContext(p)]));
  [nameConflicts, profileConflicts, boundsFindings, teamFindings, seasonFindings, autographFindings, tagMismatches].forEach((list) => {
    list.forEach((f) => {
      f.contexts = {};
      f.playIDs.forEach((id) => { f.contexts[id] = contextById.get(Number(id)) || ""; });
    });
  });

  return {
    nameConflicts,
    profileConflicts,
    boundsFindings,
    teamFindings,
    seasonFindings,
    autographFindings,
    tagSections,
    tagCount: tagMismatches.length,
    reconcilable
  };
}
