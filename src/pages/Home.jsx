import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { getTopshotStats, getBridgeStats, SUBEDITION_MINT_COUNTS, SUBEDITION_NAMES } from "../services/fcl.service";
import { supplyOf, otherSupplyOf, burnsAsOf, signedSupplyOf, isRemainingSupply } from "../services/supply.service";
import { editionBadges, signedSubs } from "../services/autograph.service";
import { Supply, SupplyWord } from "../components/Supply";
import setsParallels from "../../data/sets_parallels.json";
import { getAllPlaysDB, getAllPlaysRawDB, getAllSetsDB, getAllEditionsDB, getAllIPFSDB } from "../services/db.service";
import { CORE_MEDIA_FIELDS, isDeadMediaCid, isMismintPlay, formatCoveragePct } from "../services/ipfs.analysis";
// Baked by scripts/build-ipfs-summary.mjs; the four media stat cards
// read this instead of pulling the 5.7MB per-CID lookup on the landing page
import ipfsMediaStats from "../../data/ipfs_media_summary.json";
import { subscribeSyncStatus, isSyncCompleteStage } from "../services/sync.coordinator";
import { runDataAudits, buildCorrectionLedger, summarizeLedger } from "../services/audit.service";
import { getCalculatedPlayTags, buildTsdIndex, buildMintClock, getSeriesInfo, isWnbaTeamId as isWnbaId, TAG_BADGES, ROOKIE_TAGS, REWARD_TAGS, editionTags, withTags, mintEra, parentSeason } from "../services/overrides.service";
import { PARALLEL_ORDER, PARALLEL_COLORS, parallelGroup } from "../services/parallel.groups";
import playsExclude from "../../data/plays_exclude.json";
import setsAdditions from "../../data/additions/sets.json";
import editionsAdditions from "../../data/additions/editions.json";
import teamsAdditions from "../../data/additions/teams.json";
import { TIER_ORDER, TIER_COLORS, coveragePctColor, formatDateISO } from "../utils/display.utils";
import { isBurnedSet, isMismintSet } from "../services/set.status";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { buildCollectorProfile } from "../services/collector.profile";
import { CollectorProfile } from "../components/CollectorProfile";
import { censusStats } from "../services/census.stats";
import { toQuery } from "../utils/query";

// Parallel size groups (parallel.groups.js, shared with the Sets page
// filter the parallels matrix links to)
// The parallels behind each size group, rarest first, so the column head
// can name them ("1 to 10" alone does not say what the number is). Only
// the subeditions that actually contributed to this league's matrix are
// listed (Voltage and Championship appear in WNBA sets only).
const parallelNotes = (subIDs) => {
  const notes = {};
  [...subIDs]
    .map((id) => ({ name: SUBEDITION_NAMES[id] || `Subedition ${id}`, n: Number(SUBEDITION_MINT_COUNTS[id]) || 0 }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name))
    .forEach((s) => {
      const g = parallelGroup(s.n);
      (notes[g] = notes[g] || []).push(s);
    });
  return notes;
};

// Account-page ?sub= values for a parallel size-group column: every
// subedition whose fixed run size falls in that bucket (extra ids are
// harmless; the filter only ever narrows what the account owns)
const SUBS_BY_GROUP = (() => {
  const m = {};
  Object.entries(SUBEDITION_MINT_COUNTS).forEach(([id, count]) => {
    const n = Number(count) || 0;
    if (n === 0) return;
    const g = parallelGroup(n);
    (m[g] = m[g] || []).push(String(id));
  });
  return m;
})();

// Special serials: the serial numbers collectors chase on an edition, one
// set per parallel (standard included). A serial that qualifies twice
// (jersey 1, or a last mint equal to the jersey) counts once, under the
// first column that claims it, so the columns sum to the total.
const SERIAL_GROUPS = [
  { label: "#1", color: "#facc15" },
  { label: "Jersey", color: "#4ade80" },
  { label: "Last", color: "#60a5fa" }
];
const SERIAL_ORDER = SERIAL_GROUPS.map((g) => g.label);
const SERIAL_COLORS = Object.fromEntries(SERIAL_GROUPS.map((g) => [g.label, g.color]));
// Account-page ?special= keys for the serial columns (serials.utils kinds)
const SERIAL_SPECIAL_KEYS = { "#1": "first", "Jersey": "jersey", "Last": "last" };
// Which special serials exist on one mint run of `count` copies
const specialSerials = (count, jersey) => {
  const out = {};
  if (count < 1) return out;
  out["#1"] = 1;
  if (jersey && jersey >= 2 && jersey <= count) out.Jersey = 1;
  if (count >= 2 && count !== jersey) out.Last = 1;
  return out;
};

// Badges by series: one aligned column per badge GROUP, a cell counting
// minted moments that carry any badge of the group, each moment once
// however many of the group it carries (the play's tags plus the
// edition's own reward tags). Most columns are one badge. "Rookie" is the
// four rookie badges and "Rewards" Dapper's three reward badges; the hover
// breaks a group out per badge. A moment with two rookie badges is one
// rookie moment, never two (the column used to count
// Rookie Mint alone, which hid a veteran's throwback rookie-year moments
// behind a dot). An account-mode click filters the collection on any of
// the group. Bar colours echo each badge's ring gradient. A new badge
// gets a column, or joins a group, by one line here.
const BADGE_COLUMNS = [
  { key: "Top Shot Debut", tags: ["Top Shot Debut"], color: "#6d8bff" },
  // Rookie of the Year folds into the rookie group: 114 of its 115 plays
  // also carry a rookie badge (the one exception, Ben Simmons #4240, sat
  // out his draft season), so it reads as the award on top of a rookie
  // year rather than a column of its own
  { key: "Rookie", tags: [...ROOKIE_TAGS, "Rookie of the Year"], color: "#33faff" },
  { key: "MVP Year", tags: ["MVP Year"], color: "#ff4fb0" },
  { key: "Championship Year", tags: ["Championship Year"], color: "#ff3b3b" },
  { key: "Cup Year", tags: ["Cup Year"], color: "#ffd24a" },
  { key: "Hall of Fame", tags: ["Hall of Fame"], color: "#cd7f32" },
  { key: "Autograph", tags: ["Autograph"], color: "#94a3b8" },
  { key: "Rewards", tags: REWARD_TAGS, color: "#b3a27c" }
];
const BADGE_ORDER = BADGE_COLUMNS.map((c) => c.key);
const BADGE_COLORS = Object.fromEntries(BADGE_COLUMNS.map((c) => [c.key, c.color]));
const BADGE_COLUMN_BY_KEY = new Map(BADGE_COLUMNS.map((c) => [c.key, c]));
const TAG_BADGE_BY_TAG = new Map(TAG_BADGES.map((b) => [b.tag, b]));
const ROOKIE_TRIFECTA = "Rookie Trifecta";
// The badge facet value a cell links to: what it counted. The total
// column (ANY_BADGE) links to every counted badge at once; the facet is
// any-of, so that is exactly the moments the column counts
const ANY_BADGE = "any";
const badgeLink = (key) => {
  if (key === ANY_BADGE) return BADGE_COLUMNS.map((c) => c.tags.join(",")).join(",");
  const col = BADGE_COLUMN_BY_KEY.get(key);
  return col ? col.tags.join(",") : key;
};

// Badges by player: the badge columns again, one row per showcased
// player, plus a column for the moments that carry no badge at all, so
// the row adds up to everything minted of the player.
// Names are the compiled FullName (aliases applied, so Steph not Stephen).
// A reader can add players of their own to compare; those live in this
// browser only (localStorage) and sit after the fixed five. One panel for
// both leagues, the only place on the page that mixes them: a row is a
// person, and the point is people side by side.
const DEFAULT_SPOTLIGHT = ["LeBron James", "Vince Carter", "Victor Wembanyama", "Cooper Flagg", "Caitlin Clark"];
const SPOTLIGHT_KEY = "spotlight_players";
const readSpotlight = () => {
  try {
    const list = JSON.parse(localStorage.getItem(SPOTLIGHT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((n) => typeof n === "string" && !DEFAULT_SPOTLIGHT.includes(n)) : [];
  } catch { return []; }
};
const writeSpotlight = (list) => { try { localStorage.setItem(SPOTLIGHT_KEY, JSON.stringify(list)); } catch { /* private mode */ } };

// Which home page an account sees: its own collection, or all of Top Shot
const HOME_VIEW_KEY = "home_view";
const readHomeView = () => { try { return localStorage.getItem(HOME_VIEW_KEY) === "site" ? "site" : "collection"; } catch { return "collection"; } };
const NO_BADGE = "No badge";
const PLAYER_BADGE_ORDER = [...BADGE_ORDER, NO_BADGE];
const PLAYER_BADGE_COLORS = { ...BADGE_COLORS, [NO_BADGE]: "#8b93a3" };
// `other` is the same row counted in the number Settings does not show
// (mint counts, or remaining supply), so a cell can swap to it on hover
// (Supply); rows without it show one number
const spotlightRow = (name) => ({ key: name, label: name, to: `/players/${encodeURIComponent(name)}`, total: 0, anyBadge: 0, tiers: {}, detail: {}, other: { total: 0, anyBadge: 0, tiers: {}, detail: {} } });
// A player row counts every moment: the badge columns as in the series
// matrix, the badgeless ones under No badge, and all of them in the total
// (addBadgeCounts only adds to the total when a column counted the moment)
function addPlayerCounts(entry, tags, n, perTag) {
  const counted = addBadgeCounts(entry, tags, n, perTag);
  const rest = n - counted;
  if (rest > 0) entry.tiers[NO_BADGE] = (entry.tiers[NO_BADGE] || 0) + rest;
  entry.anyBadge += counted;
  entry.total += rest;
}
const playerTotalTitle = (unit) => (rows, v) => {
  const any = rows.reduce((s, r) => s + (r.anyBadge || 0), 0);
  const badges = rows.reduce((s, r) => s + (r.badges || 0), 0);
  return `${fmt(v)} ${unit} in all; ${fmt(any)} carry at least one badge, ${fmt(badges)} badges between them`;
};

// Adds one edition's badges to a matrix row, n moments at a time: the
// column cells, plus the per-badge breakdown behind a group's hover
// `perTag` lets one badge count fewer than n moments: Autograph counts
// the signed parallels only. Returns how many of the n moments some
// column counted (the largest column count: a partial badge's moments are
// a subset of the edition's)
function addBadgeCounts(entry, tags, n, perTag) {
  // A moment with several badges is ONE moment in the total, however many
  // columns count it; the badge sum rides along for the hover
  let counted = 0;
  BADGE_COLUMNS.forEach((col) => {
    const present = col.tags.filter((t) => tags.includes(t));
    if (present.length === 0) return;
    const cn = perTag && present.length === 1 && perTag[present[0]] !== undefined ? perTag[present[0]] : n;
    if (cn <= 0) return;
    // The breakdown counts every badge of the group
    if (col.tags.length > 1) {
      const d = entry.detail[col.key] || (entry.detail[col.key] = {});
      present.forEach((t) => { d[t] = (d[t] || 0) + cn; });
      if (col.key === "Rookie" && ROOKIE_TAGS.every((t) => tags.includes(t))) d[ROOKIE_TRIFECTA] = (d[ROOKIE_TRIFECTA] || 0) + cn;
    }
    counted = Math.max(counted, cn);
    entry.badges = (entry.badges || 0) + cn;
    entry.tiers[col.key] = (entry.tiers[col.key] || 0) + cn;
  });
  entry.total += counted;
  return counted;
}
// An edition's Autograph count: the signed parallels' moments, in the
// number shown and the number not shown
const signedPerTag = (ed, other) => ({ Autograph: signedSupplyOf(ed.momentCount, ed.setID, ed.playID, other) });
// Hover for the badge total column: the unique count, then the badge sum
const badgeTotalTitle = (unit) => (rows, v) => {
  const badges = rows.reduce((s, r) => s + (r.badges || 0), 0);
  return `${fmt(v)} ${unit} carry at least one badge; ${fmt(badges)} badges in all (one ${unit.replace(/s$/, "")} can carry several)`;
};
// Hover text for a badge column: the count (when given), then the
// group's breakdown per badge for one row, or for every row when row is
// null (a moment with several of the group is in each badge's line)
function badgeTitleFor(rows, unit) {
  return (key, row, v) => {
    const col = BADGE_COLUMN_BY_KEY.get(key);
    if (!col) return undefined;
    const lines = [];
    if (v !== undefined) lines.push(`${key}: ${fmt(v)} ${unit}${col.tags.length > 1 ? " with any of" : ""}`);
    if (col.tags.length > 1) {
      const sum = {};
      (row ? [row] : rows).forEach((r) => {
        const d = r.detail && r.detail[key];
        if (d) Object.entries(d).forEach(([t, n]) => { sum[t] = (sum[t] || 0) + n; });
      });
      [...col.tags, ROOKIE_TRIFECTA].forEach((t) => { if (sum[t]) lines.push(`${t}: ${fmt(sum[t])}`); });
    }
    return lines.length ? lines.join("\n") : undefined;
  };
}
// Column head for the badges matrix: the same badge circles the play rows
// use (all of a group's, smaller), with the column name in small type
function BadgeHead({ column }) {
  const col = BADGE_COLUMN_BY_KEY.get(column);
  const defs = (col ? col.tags : [column]).map((t) => TAG_BADGE_BY_TAG.get(t)).filter(Boolean);
  if (defs.length === 0) return column;
  return (
    <>
      <span className={`badge-head${defs.length > 1 ? " badge-head-group" : ""}`}>
        {defs.map((b) => (
          <span
            key={b.tag}
            className={`play-badge ${b.text ? "play-badge-text" : "play-badge-emoji"}`}
            role="img"
            aria-label={b.tag}
            title={b.title || b.tag}
            style={{ "--badge-gradient": b.gradient }}
          >
            {b.text || b.emoji}
          </span>
        ))}
      </span>
      <small className="tier-col-note">{column}</small>
    </>
  );
}

// Mint era columns (mintEra in overrides.service): did the play happen in
// the season it was minted in, or is it a historical moment minted later?
// The question: how much of each series is archive.
const ERA_COLUMNS = [
  // In season is the norm, so it draws as the soft grey part of the bar
  // (.split-seg-hollow); the historical share is the coloured part (a
  // full-width bright fill was blinding on the dark theme)
  { key: "season", label: "In season", color: "#cbd5e1", hollow: true, title: "In season: the play happened in the league season it was minted in" },
  { key: "historical", label: "Historical", color: "#a78bfa", title: "Historical: a play from an earlier season, minted later (archive drops, Run It Back, the Anthology sets)" }
];
const ERA_HOLLOW = new Set(ERA_COLUMNS.filter((c) => c.hollow).map((c) => c.label));
const ERA_ORDER = ERA_COLUMNS.map((c) => c.label);
const ERA_COLORS = Object.fromEntries(ERA_COLUMNS.map((c) => [c.label, c.color]));
const ERA_LABEL = Object.fromEntries(ERA_COLUMNS.map((c) => [c.key, c.label]));
const ERA_KEY = Object.fromEntries(ERA_COLUMNS.map((c) => [c.label, c.key]));
// Adds one edition to an era row (n moments); the Historical cell keeps
// a per-season breakdown for its hover
function addEraCount(entry, era, season, n) {
  const label = ERA_LABEL[era];
  entry.total += n;
  entry.tiers[label] = (entry.tiers[label] || 0) + n;
  if (era === "historical" && season) {
    const d = entry.detail[label] || (entry.detail[label] = {});
    d[season] = (d[season] || 0) + n;
  }
}
// Hover text: the column's meaning on the head, the count on a cell, and
// for Historical the seasons behind it (biggest first, at most eight)
function eraTitleFor(rows, unit) {
  return (label, row, v) => {
    const col = ERA_COLUMNS.find((c) => c.label === label);
    if (!col) return undefined;
    const lines = [];
    if (v !== undefined) lines.push(`${label}: ${fmt(v)} ${unit}`); else lines.push(col.title);
    if (col.key === "historical") {
      const sum = {};
      (row ? [row] : rows).forEach((r) => {
        const d = r.detail && r.detail[label];
        if (d) Object.entries(d).forEach(([s, n]) => { sum[s] = (sum[s] || 0) + n; });
      });
      Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([s, n]) => lines.push(`${s}: ${fmt(n)}`));
    }
    return lines.join("\n");
  };
}

// Plays page deep link: every moment carrying any rookie badge
const ROOKIE_PLAYS_LINK = `/plays?badge=${ROOKIE_TAGS.map((t) => t.toLowerCase().replace(/\s+/g, "-")).join(",")}`;

const fmt = (n) => Number(n).toLocaleString();
// Compact form for dense chart cells: 12.4M, 831K, 950
const fmtShort = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(v >= 10000000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`;
  return String(v);
};
const splitDesc = (nba, wnba) => `NBA ${fmt(nba)} · WNBA ${fmt(wnba)}`;
// Owned-over-total variant of splitDesc, used by four account-mode cards
const ownedSplitDesc = (oNba, tNba, oWnba, tWnba) => `NBA ${fmt(oNba)}/${fmt(tNba)} · WNBA ${fmt(oWnba)}/${fmt(tWnba)}`;

// The ledger's correction kinds per tier (audit.service classifyCorrection),
// in the order they read best; the hover says what each kind is
const CORRECTION_KINDS = {
  factual: ["filled gap", "factual fix"],
  routine: ["era name", "canonical name", "format", "accent", "casing"]
};
const CORRECTION_KIND_HELP = {
  "filled gap": "A field the chain left empty, filled in",
  "factual fix": "A wrong value replaced (a misspelt name, a wrong birthplace or season)",
  "era name": "The same franchise under the name it carried at the time",
  "canonical name": "One spelling of a player's name throughout",
  "format": "The same value in the house format (a birthplace, a season)",
  "accent": "A missing or stray accent",
  "casing": "Upper and lower case only"
};

function MetricCard({ to, value, label, desc, note, accent }) {
  const card = (
    <div className="glass-panel metric-card" style={accent ? { borderLeft: `4px solid ${accent}` } : undefined}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
      {desc && <div className="metric-desc">{desc}</div>}
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
  return to ? <Link to={to} className="metric-link">{card}</Link> : card;
}

/*
 * Per-league tier matrix: one aligned column per tier (rarest first), each
 * cell a mini-bar scaled to that TIER's own maximum across the league's
 * series. Stacked bars hid the rare tiers behind the commons; columns make
 * every tier directly comparable between series.
 */
// IPFS coverage cell, matching the Sets page convention: green when
// complete, red when nothing, amber in between, "-" when not synced
function IpfsPct({ entry }) {
  if (!entry || entry.pct === null) return <span className="text-muted">-</span>;
  const color = coveragePctColor(entry.pct);
  return (
    <span
      title={`${entry.present.toLocaleString()} of ${entry.total.toLocaleString()} expected media files present`}
      style={{ color, fontWeight: 600, cursor: "help" }}
    >
      {formatCoveragePct(entry.pct)}%
    </span>
  );
}

// columns/colors default to the tiers; the parallels chart passes its size
// groups instead, plus `notes` (column -> [{ name, n }]) naming the
// parallels under each head. The badges chart passes `headOf` (column ->
// node) to draw badge circles as heads, and `titleOf(column, row, value)`
// (row null = the head or the totals row) for its hover text. A row is a
// series unless it carries its own `key`, `label` and `to`. In account
// mode `linkOf(column, row)` (either side null = "all of them") turns
// every non-empty cell into a deep link into the collection, pre-filtered
// to what it counts. ipfs === undefined hides the IPFS column.
function TierMatrix({ league, rows, ipfs, columns = TIER_ORDER, colors = TIER_COLORS, notes, headOf, titleOf, linkOf, linkText = "them in the collection", unit = "mints", totalLabel = "Total", totalTitle }) {
  const tiers = columns.filter((t) => rows.some((r) => r.tiers[t]));
  const showIpfs = ipfs !== undefined;
  if (rows.length === 0) {
    return (
      <div className="glass-panel series-panel">
        {league && <h4 className="league-chart-title">{league}</h4>}
        <p className="text-muted" style={{ margin: 0 }}>Syncing edition data...</p>
      </div>
    );
  }
  const colMax = {};
  tiers.forEach((t) => {
    colMax[t] = rows.reduce((m, r) => Math.max(m, r.tiers[t] || 0), 0);
  });
  // One unit per COLUMN: the lowest unit that fits the column's
  // biggest value, so commons read in millions while legendaries read in
  // thousands and ultimates in plain hundreds. Within a column every value
  // keeps the same unit and the same one decimal (0.8K next to 108.0K, not
  // 108K), the totals row included.
  const unitFor = (max) => (max >= 2000000 ? "M" : max >= 10000 ? "K" : "");
  const oneDecimal = (x) => x.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtIn = (v, u) => {
    if (u === "M") return `${oneDecimal(v / 1000000)}M`;
    if (u === "K") return `${oneDecimal(v / 1000)}K`;
    return fmt(Math.round(v));
  };
  const colUnit = {};
  tiers.forEach((t) => { colUnit[t] = unitFor(colMax[t]); });
  const totalUnit = unitFor(rows.reduce((m, r) => Math.max(m, r.total), 0));
  const colSum = {};
  tiers.forEach((t) => { colSum[t] = rows.reduce((s, r) => s + (r.tiers[t] || 0), 0); });
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  // Rows carrying an `other` sibling (the public matrices, summed in the
  // number Settings does not show) let a cell swap to it on hover; owned
  // rows have none
  const otherOf = (r, t, fallback) => (r.other ? (t === null ? (r.other.total || 0) : (r.other.tiers[t] || 0)) : fallback);
  const remainingFirst = isRemainingSupply();
  const colSumOther = {};
  tiers.forEach((t) => { colSumOther[t] = rows.reduce((s, r) => s + otherOf(r, t, r.tiers[t] || 0), 0); });
  const grandOther = rows.reduce((s, r) => s + otherOf(r, null, r.total), 0);
  const sumFmt = fmtIn;
  const noteTitle = (t) => (notes && notes[t] ? notes[t].map((s) => `${s.name}: ${fmt(s.n)} per edition`).join("\n") : undefined);
  const headWrap = (key, className, title, to, children, color) => (to ? (
    <Link key={key} to={to} className={`${className} tier-head-link`} style={{ color }} title={`${title ? `${title}; ` : ""}click to see ${linkText}`}>{children}</Link>
  ) : (
    <span key={key} className={className} style={{ color }} title={title}>{children}</span>
  ));
  // One cell, linked when linkOf gave it somewhere to go
  const cellWrap = (key, className, title, to, children) => (to ? (
    <Link key={key} to={to} className={`${className} tier-cell-link`} title={`${title ? `${title}; ` : ""}click to see ${linkText}`}>
      {children}
    </Link>
  ) : (
    <span key={key} className={className} title={title}>{children}</span>
  ));
  // League-wide IPFS coverage for the totals row
  let ipfsAll = null;
  if (ipfs) {
    let present = 0, total = 0;
    ipfs.forEach((e) => { present += e.present; total += e.total; });
    if (total > 0) ipfsAll = { pct: (present / total) * 100, present, total };
  }
  return (
    <div className="glass-panel series-panel">
      {league && <h4 className="league-chart-title">{league}</h4>}
      <div className="tier-matrix" style={{ gridTemplateColumns: `minmax(110px, 170px) repeat(${tiers.length}, 1fr) 70px${showIpfs ? " 58px" : ""}` }}>
        <span className="tier-col-head" />
        {tiers.map((t) => (
          // A column head links like its totals cell: the whole column,
          // every series
          headWrap(t, `tier-col-head${notes || headOf ? " tier-col-head-noted" : ""}`, titleOf ? titleOf(t, null) : noteTitle(t), linkOf && colSum[t] > 0 ? linkOf(t, null) : null, (
            <>
              {headOf ? headOf(t) : t}
              {notes && notes[t] && (
                <small className="tier-col-note">{notes[t].map((s) => s.name).join(", ")}</small>
              )}
            </>
          ), colors[t])
        ))}
        <span className="tier-col-head tier-total-head" title={totalTitle ? totalTitle(rows, grandTotal) : undefined}>{totalLabel}</span>
        {showIpfs && <span className="tier-col-head tier-total-head">IPFS</span>}
        {rows.map((r) => (
          <div key={r.key ?? r.series} className="tier-matrix-row">
            <Link to={r.to || `/sets?series=${r.series}`} className={`series-label font-hover-glow${r.label ? " series-label-wrap" : ""}`}>
              {r.label || (getSeriesInfo(r.series) || {}).name || `Series ${r.series}`}
            </Link>
            {tiers.map((t) => {
              const v = r.tiers[t] || 0;
              // The burned span, shown while the number swaps: from the
              // remaining count to the minted count along the same scale,
              // so it extends the bar when remaining is shown and marks
              // the tail of it when minted is shown
              const o = otherOf(r, t, v);
              const rem = remainingFirst ? v : o;
              const minted = remainingFirst ? o : v;
              const burn = colMax[t] > 0 && minted > rem
                ? { left: `${(rem / colMax[t]) * 100}%`, width: `${((minted - rem) / colMax[t]) * 100}%` }
                : null;
              return cellWrap(t, "tier-cell", (titleOf && titleOf(t, r, v)) || `${t}: ${fmt(v)} ${unit}`, linkOf && v > 0 ? linkOf(t, r) : null, (
                <>
                  <span className={`tier-cell-bar-track${v > 0 ? "" : " tier-cell-bar-track-empty"}`}>
                    <span
                      className="tier-cell-bar"
                      style={{ width: colMax[t] > 0 ? `${Math.max(v > 0 ? 3 : 0, (v / colMax[t]) * 100)}%` : 0, background: colors[t] }}
                    />
                    {burn && <span className="tier-cell-bar-burn" style={{ ...burn, background: colors[t] }} />}
                  </span>
                  <Supply className="tier-cell-num font-mono" shown={v} other={otherOf(r, t, v)} format={(x) => (x > 0 ? fmtIn(x, colUnit[t]) : "·")} title={false} />
                </>
              ));
            })}
            {cellWrap("total", "tier-cell tier-total font-mono", totalTitle ? totalTitle([r], r.total) : undefined, linkOf && r.total > 0 ? linkOf(null, r) : null, (
              <Supply shown={r.total} other={otherOf(r, null, r.total)} format={(x) => fmtIn(x, totalUnit)} title={false} />
            ))}
            {showIpfs && (
              <span className="tier-cell tier-total font-mono">
                <IpfsPct entry={ipfs ? ipfs.get(r.series) : null} />
              </span>
            )}
          </div>
        ))}
        <div className="tier-matrix-row">
          <span className="tier-sum-label">Total</span>
          {tiers.map((t) => cellWrap(t, "tier-cell", titleOf ? titleOf(t, null, colSum[t]) : undefined, linkOf && colSum[t] > 0 ? linkOf(t, null) : null, (
            <Supply className="tier-cell-num tier-sum font-mono" shown={colSum[t]} other={colSumOther[t]} format={(x) => sumFmt(x, colUnit[t])} title={false} />
          )))}
          {cellWrap("total", "tier-cell tier-total tier-sum font-mono", totalTitle ? totalTitle(rows, grandTotal) : undefined, linkOf && grandTotal > 0 ? linkOf(null, null) : null, (
            <Supply shown={grandTotal} other={grandOther} format={(x) => sumFmt(x, totalUnit)} title={false} />
          ))}
          {showIpfs && (
            <span className="tier-cell tier-total tier-sum font-mono">
              <IpfsPct entry={ipfsAll} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// A two-way split of the SAME moments (in season vs historical): one
// 100%-stacked bar per series, so both sides share a scale and the eye
// compares them honestly. Per-column bars (TierMatrix) suit tiers and
// parallels, where the columns are separate things; here they made a 3%
// slice look like a rival column. Numbers pick their
// own unit, since the row is the comparison, not the column.
function SplitMatrix({ league, rows, columns, colors, hollow, titleOf, linkOf, linkText = "them in the collection" }) {
  const [a, b] = columns;
  if (rows.length === 0) {
    return (
      <div className="glass-panel series-panel">
        {league && <h4 className="league-chart-title">{league}</h4>}
        <p className="text-muted" style={{ margin: 0 }}>Syncing edition data...</p>
      </div>
    );
  }
  const wrap = (key, className, title, to, children) => (to ? (
    <Link key={key} to={to} className={`${className} tier-cell-link`} title={`${title ? `${title}; ` : ""}click to see ${linkText}`}>{children}</Link>
  ) : (
    <span key={key} className={className} title={title}>{children}</span>
  ));
  const line = (r, key, isSum) => {
    const row = isSum ? null : r;
    const va = r.tiers[a] || 0, vb = r.tiers[b] || 0, total = va + vb;
    const pa = total > 0 ? (va / total) * 100 : 0, pb = total > 0 ? (vb / total) * 100 : 0;
    const scope = isSum ? "league" : "series";
    const seg = (label, v, p, color) => {
      const to = linkOf && v > 0 ? linkOf(label, row) : null;
      const title = `${titleOf(label, row, v)}\n${p.toFixed(1)}% of the ${scope}${to ? `; click to see ${linkText}` : ""}`;
      const isHollow = hollow && hollow.has(label);
      const style = { width: `${p}%`, minWidth: v > 0 ? "4px" : 0, ...(isHollow ? {} : { background: color }) };
      const cls = `split-seg${isHollow ? " split-seg-hollow" : ""}`;
      const text = p >= 14 ? `${Math.round(p)}%` : "";
      return to
        ? <Link key={label} to={to} className={cls} style={style} title={title}>{text}</Link>
        : <span key={label} className={cls} style={style} title={title}>{text}</span>;
    };
    const numClass = `tier-cell tier-total font-mono${isSum ? " tier-sum" : ""}`;
    const otherOf = (label) => (r.other ? (r.other.tiers[label] || 0) : (r.tiers[label] || 0));
    const num = (label, v) => wrap(`${label}-n`, numClass, titleOf(label, row, v), linkOf && v > 0 ? linkOf(label, row) : null, (
      <Supply shown={v} other={otherOf(label)} format={(x) => (x > 0 ? fmtShort(x) : "·")} title={false} />
    ));
    return (
      <div key={key} className="tier-matrix-row">
        {isSum
          ? <span className="tier-sum-label">Total</span>
          : <Link to={`/sets?series=${r.series}`} className="series-label font-hover-glow">{(getSeriesInfo(r.series) || {}).name || `Series ${r.series}`}</Link>}
        <span className="split-bar">{seg(a, va, pa, colors[a])}{seg(b, vb, pb, colors[b])}</span>
        {num(a, va)}
        {num(b, vb)}
        {wrap("total", numClass, undefined, linkOf && total > 0 ? linkOf(null, row) : null, (
          <Supply shown={total} other={otherOf(a) + otherOf(b)} format={fmtShort} title={false} />
        ))}
      </div>
    );
  };
  const sumOf = (label, other) => rows.reduce((s, r) => s + (other && r.other ? (r.other.tiers[label] || 0) : (r.tiers[label] || 0)), 0);
  const sum = { tiers: { [a]: sumOf(a, false), [b]: sumOf(b, false) }, other: { tiers: { [a]: sumOf(a, true), [b]: sumOf(b, true) } }, detail: {} };
  rows.forEach((r) => {
    Object.entries(r.detail || {}).forEach(([label, d]) => {
      const t = sum.detail[label] || (sum.detail[label] = {});
      Object.entries(d).forEach(([k, n]) => { t[k] = (t[k] || 0) + n; });
    });
  });
  return (
    <div className="glass-panel series-panel">
      <h4 className="league-chart-title">{league}</h4>
      <div className="tier-matrix split-matrix" style={{ gridTemplateColumns: "minmax(110px, 170px) minmax(160px, 1fr) 78px 78px 70px" }}>
        <span className="tier-col-head" />
        <span className="tier-col-head" />
        {[a, b].map((label) => (linkOf && sum.tiers[label] > 0 ? (
          <Link key={label} to={linkOf(label, null)} className="tier-col-head tier-total-head tier-head-link" style={{ color: colors[label] }} title={`${titleOf(label, null)}; click to see ${linkText}`}>{label}</Link>
        ) : (
          <span key={label} className="tier-col-head tier-total-head" style={{ color: colors[label] }} title={titleOf(label, null)}>{label}</span>
        )))}
        <span className="tier-col-head tier-total-head">Total</span>
        {rows.map((r) => line(r, r.series, false))}
        {line(sum, "sum", true)}
      </div>
    </div>
  );
}

export function Home() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [plays, setPlays] = useState([]);
  const [playsRaw, setPlaysRaw] = useState([]);
  const [sets, setSets] = useState([]);
  const [editions, setEditions] = useState([]);
  const [ipfsRecords, setIpfsRecords] = useState([]);
  const [openFindings, setOpenFindings] = useState(null);
  const [bridgeStats, setBridgeStats] = useState(null);
  const [loadError, setLoadError] = useState("");
  // Browsing as an account: the home page becomes that collection's summary,
  // with a switch back to the site-wide view (remembered in the browser)
  const account = useAccountCollection();
  const [homeView, setHomeView] = useState(readHomeView);
  const chooseHomeView = (v) => { setHomeView(v); try { localStorage.setItem(HOME_VIEW_KEY, v); } catch { /* private mode */ } };
  const owned = account && homeView === "collection" ? account : null;

  useEffect(() => {
    // Live chain stats: must not take the offline dashboard down with it
    getTopshotStats()
      .then(setStats)
      .catch((err) => {
        console.error("Error loading home stats:", err);
        setError("Failed to fetch live stats from Flow mainnet.");
      });

    const loadLocal = () => {
      Promise.all([getAllPlaysDB(), getAllPlaysRawDB(), getAllSetsDB(), getAllEditionsDB(), getAllIPFSDB()])
        .then(([dbPlays, dbPlaysRaw, dbSets, dbEditions, dbIpfs]) => {
          setPlays(dbPlays);
          setPlaysRaw(dbPlaysRaw);
          setSets(dbSets);
          setEditions(dbEditions);
          setIpfsRecords(dbIpfs);
          setLoadError("");
        })
        .catch((e) => {
          console.error("Failed to load local stats for home page:", e);
          setLoadError("Could not read the local database; the dashboard numbers are unavailable.");
        });
    };
    loadLocal();

    const unsubscribe = subscribeSyncStatus((status) => {
      if (!status.isSyncing && isSyncCompleteStage(status.stage)) loadLocal();
    });
    return unsubscribe;
  }, []);

  // Badge tags per play (the same derivation the Plays page uses),
  // computed once per plays generation and shared by the people stats and
  // the badges matrices. Only tags with a badge definition count, and a
  // play with none has no entry; mismint plays carry no badges at all.
  const playTags = useMemo(() => {
    if (plays.length === 0) return null;
    const tsdIndex = buildTsdIndex(plays);
    const clock = buildMintClock(plays);
    const m = new Map();
    plays.forEach((p) => {
      if (isMismintPlay(p.playID)) return;
      const tags = getCalculatedPlayTags(p, null, tsdIndex, clock).filter((t) => TAG_BADGE_BY_TAG.has(t));
      if (tags.length > 0) m.set(String(p.playID), tags);
    });
    return m;
  }, [plays]);
  // Mint era per play (mismints excluded, like playTags)
  const playEra = useMemo(() => {
    if (plays.length === 0) return null;
    const clock = buildMintClock(plays);
    const m = new Map();
    plays.forEach((p) => {
      if (isMismintPlay(p.playID)) return;
      m.set(String(p.playID), { era: mintEra(p, clock), season: parentSeason(p.NbaSeason) });
    });
    return m;
  }, [plays]);

  // People stats: everything is split by league (a play's league = its
  // team at moment); a player with plays in both leagues counts in both
  // splits.
  const peopleStats = useMemo(() => {
    if (plays.length === 0 || !playTags) return null;
    const ownedByPlay = owned ? owned.index?.byPlay : null;
    const mk = () => ({ NBA: new Set(), WNBA: new Set() });
    const players = mk();
    const rookies = mk();
    const ownedPlayers = mk();
    const ownedRookies = mk();
    const playCounts = { NBA: 0, WNBA: 0 };
    const ownedPlayCounts = { NBA: 0, WNBA: 0 };
    plays.forEach((p) => {
      // Mismint plays (plays_exclude.json) never count toward stats
      if (isMismintPlay(p.playID)) return;
      const lg = isWnbaId(p.TeamAtMomentNBAID) ? "WNBA" : "NBA";
      playCounts[lg]++;
      const isOwned = ownedByPlay ? (ownedByPlay.get(Number(p.playID)) || 0) > 0 : false;
      if (isOwned) ownedPlayCounts[lg]++;
      const name = (p.FullName || "").trim().toLowerCase();
      if (!name) return;
      players[lg].add(name);
      if (isOwned) ownedPlayers[lg].add(name);
      const tags = playTags.get(String(p.playID)) || [];
      if (ROOKIE_TAGS.some((t) => tags.includes(t))) {
        rookies[lg].add(name);
        if (isOwned) ownedRookies[lg].add(name);
      }
    });
    const both = (s) => ({ total: new Set([...s.NBA, ...s.WNBA]).size, nba: s.NBA.size, wnba: s.WNBA.size });
    return {
      players: both(players),
      rookies: both(rookies),
      ownedPlayers: both(ownedPlayers),
      ownedRookies: both(ownedRookies),
      playCounts,
      ownedPlayCounts
    };
  }, [plays, playTags, owned]);

  // League per play, for classifying sets and editions
  const playLeague = useMemo(() => {
    const m = new Map();
    plays.forEach((p) => m.set(String(p.playID), isWnbaId(p.TeamAtMomentNBAID) ? "WNBA" : "NBA"));
    return m;
  }, [plays]);
  // Showcased players: the fixed five plus the reader's own
  const [extraPlayers, setExtraPlayers] = useState(readSpotlight);
  const spotlightNames = useMemo(() => [...DEFAULT_SPOTLIGHT, ...extraPlayers], [extraPlayers]);
  // Every player name in the compiled plays, for the compare box: the
  // list it offers, and the canonical spelling behind a typed one
  const playerNames = useMemo(() => {
    const byLower = new Map();
    plays.forEach((p) => {
      const name = (p.FullName || "").trim();
      if (name && !isMismintPlay(p.playID) && !byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
    });
    return { byLower, list: [...byLower.values()].sort((a, b) => a.localeCompare(b)) };
  }, [plays]);
  // Play id -> showcased player name, for the plays of those players only
  const spotlightPlay = useMemo(() => {
    const m = new Map();
    const wanted = new Set(spotlightNames);
    plays.forEach((p) => {
      const name = (p.FullName || "").trim();
      if (wanted.has(name) && !isMismintPlay(p.playID)) m.set(String(p.playID), name);
    });
    return m;
  }, [plays, spotlightNames]);
  const [spotlightDraft, setSpotlightDraft] = useState("");
  const [spotlightNote, setSpotlightNote] = useState("");
  const addSpotlight = (e) => {
    e.preventDefault();
    const name = playerNames.byLower.get(spotlightDraft.trim().toLowerCase());
    if (!name) { setSpotlightNote(spotlightDraft.trim() ? "No player by that name" : ""); return; }
    if (spotlightNames.includes(name)) { setSpotlightNote(`${name} is already listed`); return; }
    const next = [...extraPlayers, name];
    setExtraPlayers(next);
    writeSpotlight(next);
    setSpotlightDraft("");
    setSpotlightNote("");
  };
  const removeSpotlight = (name) => {
    const next = extraPlayers.filter((n) => n !== name);
    setExtraPlayers(next);
    writeSpotlight(next);
    setSpotlightNote("");
  };

  // Mints per league, series, and tier (tier from the additions files; an
  // edition's league comes from its play's team at moment; mismint
  // editions are left out, as on the Sets page)
  const seriesTiersByLeague = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0) return { NBA: [], WNBA: [] };
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const bySeries = { NBA: new Map(), WNBA: new Map() };
    editions.forEach((ed) => {
      const s = setById.get(String(ed.setID));
      if (!s || s.series === undefined || s.series === null) return;
      if (isMismintPlay(ed.playID)) return;
      // Burned sets (Platinum Ice) still report their original counts on
      // chain, but none of those moments exist any more
      if (isBurnedSet(ed.setID)) return;
      const lg = playLeague.get(String(ed.playID)) || "NBA";
      // Tier lives on the set when every edition shares it; mixed sets
      // (Anthology, NBA Cup, ...) carry it per edition instead
      const setAdd = setsAdditions[String(ed.setID)];
      const edAdd = editionsAdditions[`${ed.setID}_${ed.playID}`];
      const tier = (edAdd && edAdd.tier) || (setAdd && setAdd.tier) || "Unknown";
      const entry = bySeries[lg].get(s.series) || { series: s.series, total: 0, tiers: {}, other: { total: 0, tiers: {} } };
      const n = supplyOf(ed.momentCount, ed.setID, ed.playID);
      const o = otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
      entry.total += n;
      entry.tiers[tier] = (entry.tiers[tier] || 0) + n;
      entry.other.total += o;
      entry.other.tiers[tier] = (entry.other.tiers[tier] || 0) + o;
      bySeries[lg].set(s.series, entry);
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return { NBA: toRows(bySeries.NBA), WNBA: toRows(bySeries.WNBA) };
  }, [sets, editions, playLeague]);

  // Parallel mints per league, series and size group: each parallel of an
  // edition mints its subedition's fixed count (the Sets page figure), so a
  // set's parallels contribute editions x count per subedition
  const parallelsBySeries = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0) return { NBA: [], WNBA: [], notes: { NBA: {}, WNBA: {} } };
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const bySeries = { NBA: new Map(), WNBA: new Map() };
    const subsSeen = { NBA: new Set(), WNBA: new Set() };
    editions.forEach((ed) => {
      const subIDs = setsParallels[String(ed.setID)];
      if (!subIDs || subIDs.length === 0) return;
      const s = setById.get(String(ed.setID));
      if (!s || s.series === undefined || s.series === null) return;
      if (isMismintPlay(ed.playID) || isBurnedSet(ed.setID)) return;
      const lg = playLeague.get(String(ed.playID)) || "NBA";
      const entry = bySeries[lg].get(s.series) || { series: s.series, total: 0, tiers: {} };
      subIDs.forEach((subID) => {
        const n = Number(SUBEDITION_MINT_COUNTS[subID]) || 0;
        if (n === 0) return;
        const group = parallelGroup(n);
        entry.total += n;
        entry.tiers[group] = (entry.tiers[group] || 0) + n;
        subsSeen[lg].add(subID);
      });
      bySeries[lg].set(s.series, entry);
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return {
      NBA: toRows(bySeries.NBA),
      WNBA: toRows(bySeries.WNBA),
      notes: { NBA: parallelNotes(subsSeen.NBA), WNBA: parallelNotes(subsSeen.WNBA) }
    };
  }, [sets, editions, playLeague]);

  // Jersey number per play (the number on the player's back in that
  // moment); team moments and unknowns carry none
  const playJersey = useMemo(() => {
    const m = new Map();
    plays.forEach((p) => {
      const j = String(p.JerseyNumber ?? "").trim();
      if (/^\d+$/.test(j) && Number(j) >= 1) m.set(String(p.playID), Number(j));
    });
    return m;
  }, [plays]);

  // Special serials per league and series: every mint run of an edition
  // (standard = its mint count, each parallel = the subedition's fixed
  // count) has a #1, a last mint, and a jersey match when the jersey
  // number fits inside the run (LeBron's 23 exists in a 99-copy Club
  // Collection run, not in a 10-copy Diced run)
  const serialsBySeries = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0) return { NBA: [], WNBA: [] };
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const bySeries = { NBA: new Map(), WNBA: new Map() };
    editions.forEach((ed) => {
      const s = setById.get(String(ed.setID));
      if (!s || s.series === undefined || s.series === null) return;
      if (isMismintPlay(ed.playID) || isBurnedSet(ed.setID)) return;
      const lg = playLeague.get(String(ed.playID)) || "NBA";
      const jersey = playJersey.get(String(ed.playID)) || 0;
      const runs = [Number(ed.momentCount) || 0];
      (setsParallels[String(ed.setID)] || []).forEach((subID) => runs.push(Number(SUBEDITION_MINT_COUNTS[subID]) || 0));
      const entry = bySeries[lg].get(s.series) || { series: s.series, total: 0, tiers: {} };
      runs.forEach((count) => {
        Object.entries(specialSerials(count, jersey)).forEach(([k, n]) => {
          entry.total += n;
          entry.tiers[k] = (entry.tiers[k] || 0) + n;
        });
      });
      bySeries[lg].set(s.series, entry);
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return { NBA: toRows(bySeries.NBA), WNBA: toRows(bySeries.WNBA) };
  }, [sets, editions, playLeague, playJersey]);

  // Badges per league, series and badge column: every minted moment of an
  // edition carries its play's badges plus the edition's own reward tags,
  // so an edition contributes momentCount per column (mismint plays have
  // no playTags entry and count nowhere; burned sets are out, as
  // everywhere above)
  const badgesBySeries = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0 || !playTags) return { NBA: [], WNBA: [] };
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const bySeries = { NBA: new Map(), WNBA: new Map() };
    editions.forEach((ed) => {
      if (isMismintPlay(ed.playID)) return;
      const tags = editionBadges(withTags(playTags.get(String(ed.playID)) || [], editionTags(ed.setID, ed.playID)), ed.setID, ed.playID);
      if (tags.length === 0) return;
      const s = setById.get(String(ed.setID));
      if (!s || s.series === undefined || s.series === null) return;
      if (isBurnedSet(ed.setID)) return;
      const n = supplyOf(ed.momentCount, ed.setID, ed.playID);
      const o = otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
      if (n === 0 && o === 0) return;
      const lg = playLeague.get(String(ed.playID)) || "NBA";
      const entry = bySeries[lg].get(s.series) || { series: s.series, total: 0, tiers: {}, detail: {}, other: { total: 0, tiers: {}, detail: {} } };
      addBadgeCounts(entry, tags, n, signedPerTag(ed, false));
      addBadgeCounts(entry.other, tags, o, signedPerTag(ed, true));
      bySeries[lg].set(s.series, entry);
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return { NBA: toRows(bySeries.NBA), WNBA: toRows(bySeries.WNBA) };
  }, [sets, editions, playLeague, playTags]);

  // Badges per showcased player: every minted moment of the player's
  // editions, badged or not (same exclusions as the series matrix)
  const badgesByPlayer = useMemo(() => {
    if (editions.length === 0 || !playTags) return [];
    const rows = new Map(spotlightNames.map((name) => [name, spotlightRow(name)]));
    editions.forEach((ed) => {
      const name = spotlightPlay.get(String(ed.playID));
      if (!name || isBurnedSet(ed.setID)) return;
      const n = supplyOf(ed.momentCount, ed.setID, ed.playID);
      const o = otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
      if (n === 0 && o === 0) return;
      const tags = editionBadges(withTags(playTags.get(String(ed.playID)) || [], editionTags(ed.setID, ed.playID)), ed.setID, ed.playID);
      addPlayerCounts(rows.get(name), tags, n, signedPerTag(ed, false));
      addPlayerCounts(rows.get(name).other, tags, o, signedPerTag(ed, true));
    });
    return [...rows.values()];
  }, [editions, spotlightNames, spotlightPlay, playTags]);

  // Mint era per league and series: every minted moment of an edition
  // carries its play's era (same exclusions as the badges matrix)
  const erasBySeries = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0 || !playEra) return { NBA: [], WNBA: [] };
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const bySeries = { NBA: new Map(), WNBA: new Map() };
    editions.forEach((ed) => {
      const pe = playEra.get(String(ed.playID));
      if (!pe) return;
      const s = setById.get(String(ed.setID));
      if (!s || s.series === undefined || s.series === null) return;
      if (isBurnedSet(ed.setID)) return;
      const n = supplyOf(ed.momentCount, ed.setID, ed.playID);
      const o = otherSupplyOf(ed.momentCount, ed.setID, ed.playID);
      if (n === 0 && o === 0) return;
      const lg = playLeague.get(String(ed.playID)) || "NBA";
      const entry = bySeries[lg].get(s.series) || { series: s.series, total: 0, tiers: {}, detail: {}, other: { total: 0, tiers: {}, detail: {} } };
      addEraCount(entry, pe.era, pe.season, n);
      addEraCount(entry.other, pe.era, pe.season, o);
      bySeries[lg].set(s.series, entry);
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return { NBA: toRows(bySeries.NBA), WNBA: toRows(bySeries.WNBA) };
  }, [sets, editions, playLeague, playEra]);

  // Everything the account-summary view needs, in the same row shapes the
  // TierMatrix already renders: owned moments by series and tier, owned
  // parallels by size group, owned special serials. Built entirely from the
  // collection index (per-edition counts and per-run serial lists).
  const accountMatrices = useMemo(() => {
    if (!owned || !owned.index || sets.length === 0 || playLeague.size === 0) return null;
    const setById = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    const edCount = new Map(editions.map((e) => [String(e.id), Number(e.momentCount) || 0]));
    const mkRows = () => ({ NBA: new Map(), WNBA: new Map() });
    const tiers = mkRows(), pars = mkRows(), sers = mkRows(), badges = mkRows(), eras = mkRows();
    const players = new Map(spotlightNames.map((name) => [name, spotlightRow(name)]));
    const add = (m, lg, series, col, n) => {
      if (n <= 0) return;
      const e = m[lg].get(series) || { series, total: 0, tiers: {} };
      e.total += n;
      e.tiers[col] = (e.tiers[col] || 0) + n;
      m[lg].set(series, e);
    };
    // Mismint copies (plays_exclude.json) count nowhere, as in every
    // public matrix
    owned.index.byEdition.forEach((count, key) => {
      const [setID, playID] = key.split("_");
      if (isMismintPlay(playID)) return;
      const s = setById.get(setID);
      if (!s || s.series === undefined || s.series === null) return;
      const lg = playLeague.get(playID) || "NBA";
      const edAdd = editionsAdditions[key];
      const setAdd = setsAdditions[setID];
      const tier = (edAdd && edAdd.tier) || (setAdd && setAdd.tier) || "Unknown";
      add(tiers, lg, s.series, tier, count);
      const pe = playEra ? playEra.get(playID) : null;
      if (pe) {
        const e = eras[lg].get(s.series) || { series: s.series, total: 0, tiers: {}, detail: {} };
        addEraCount(e, pe.era, pe.season, count);
        eras[lg].set(s.series, e);
      }
      // Each owned copy carries the play's badges plus the edition's own;
      // the Autograph only the copies on a signed parallel
      const tags = editionBadges(withTags(playTags ? (playTags.get(playID) || []) : [], editionTags(setID, playID)), setID, playID);
      const perTag = tags.includes("Autograph")
        ? { Autograph: (signedSubs(setID, playID) || []).reduce((n, sub) => n + (owned.index.serials.get(`${key}_${sub}`) || []).length, 0) }
        : undefined;
      if (tags.length > 0) {
        const e = badges[lg].get(s.series) || { series: s.series, total: 0, tiers: {}, detail: {} };
        addBadgeCounts(e, tags, count, perTag);
        badges[lg].set(s.series, e);
      }
      const name = spotlightPlay.get(playID);
      if (name) addPlayerCounts(players.get(name), tags, count, perTag);
    });
    owned.index.serials.forEach((list, key) => {
      const [setID, playID, subStr] = key.split("_");
      if (isMismintPlay(playID)) return;
      const sub = Number(subStr);
      const s = setById.get(setID);
      if (!s || s.series === undefined || s.series === null) return;
      const lg = playLeague.get(playID) || "NBA";
      const runSize = sub > 0 ? (Number(SUBEDITION_MINT_COUNTS[sub]) || 0) : (edCount.get(`${setID}_${playID}`) || 0);
      if (sub > 0 && runSize > 0) add(pars, lg, s.series, parallelGroup(runSize), list.length);
      const jersey = playJersey.get(playID) || 0;
      list.forEach((serial) => {
        const col = serial === 1 ? "#1"
          : (jersey >= 2 && serial === jersey) ? "Jersey"
            : (runSize >= 2 && serial === runSize) ? "Last" : null;
        if (col) add(sers, lg, s.series, col, 1);
      });
    });
    const toRows = (m) => [...m.values()].sort((a, b) => Number(a.series) - Number(b.series));
    return {
      tiers: { NBA: toRows(tiers.NBA), WNBA: toRows(tiers.WNBA) },
      parallels: { NBA: toRows(pars.NBA), WNBA: toRows(pars.WNBA) },
      serials: { NBA: toRows(sers.NBA), WNBA: toRows(sers.WNBA) },
      badges: { NBA: toRows(badges.NBA), WNBA: toRows(badges.WNBA) },
      eras: { NBA: toRows(eras.NBA), WNBA: toRows(eras.WNBA) },
      players: [...players.values()].map((r) => ({ ...r, other: undefined }))
    };
  }, [owned, sets, editions, playLeague, playJersey, playTags, playEra, spotlightNames, spotlightPlay]);

  // Account mode: every matrix cell deep-links into the collection,
  // filtered to exactly what it counts. Param names and values mirror the
  // Account page URL vocabulary (league / series / tier / sub / badge /
  // special); a null column or row means "all of them" (the totals).
  const linkOfFor = (league, extraOf) => (col, row) => {
    const params = new URLSearchParams();
    params.set("league", league);
    if (row) params.set("series", String(row.series));
    if (col) Object.entries(extraOf(col)).forEach(([k, v]) => { if (v) params.set(k, v); });
    return `/account/${owned.address}?${toQuery(params)}`;
  };

  // Public mode: cells deep-link into the catalog instead.
  // Tiers and parallels go to the Sets page (sets in that
  // series containing that tier, or a parallel of that size); badges go
  // to the Plays page (plays carrying the badge that sit in a set of that
  // series). Special serials have no catalog filter, so they stay plain.
  const catalogLinkOf = (league, base, extraOf) => (col, row) => {
    const params = new URLSearchParams();
    params.set("league", league.toLowerCase());
    if (row) params.set("series", String(row.series));
    if (col) Object.entries(extraOf(col)).forEach(([k, v]) => { if (v) params.set(k, v); });
    return `${base}?${toQuery(params)}`;
  };
  const tierLink = (league) => (accountMatrices ? linkOfFor(league, (t) => ({ tier: t })) : catalogLinkOf(league, "/sets", (t) => ({ tier: t })));
  const parallelLink = (league) => (accountMatrices ? linkOfFor(league, (g) => ({ sub: (SUBS_BY_GROUP[g] || []).join(",") })) : catalogLinkOf(league, "/sets", (g) => ({ parallel: g })));
  const badgeLinkOf = (league) => {
    const fn = accountMatrices ? linkOfFor(league, (t) => ({ badge: badgeLink(t) })) : catalogLinkOf(league, "/plays", (t) => ({ badge: badgeLink(t) }));
    return (col, row) => fn(col || ANY_BADGE, row);
  };
  // Player rows: a cell links to that player's moments carrying the badge
  // (No badge has no facet, and a column head would span every player, so
  // both stay plain)
  const playerLinkOf = (col, row) => {
    if (!row || col === NO_BADGE) return null;
    const params = new URLSearchParams();
    params.set("player", row.key);
    if (col) params.set("badge", badgeLink(col));
    return accountMatrices ? `/account/${owned.address}?${toQuery(params)}` : `/plays?${toQuery(params)}`;
  };
  const setsText = accountMatrices ? undefined : "those sets";
  const playsText = accountMatrices ? undefined : "those plays";

  const badgeRows = accountMatrices ? accountMatrices.badges : badgesBySeries;
  const playerRows = accountMatrices ? accountMatrices.players : badgesByPlayer;
  // Headline counts with the mismints out: plays_exclude.json plays are
  // not real highlights and their copies are not real moments
  const realPlayCount = useMemo(() => plays.filter((p) => !isMismintPlay(p.playID)).length, [plays]);
  // The collector profile: what this account holds more of than the
  // field does (services/collector.profile), shown at the top of the page
  const profile = useMemo(() => {
    if (!owned || !owned.index || editions.length === 0 || plays.length === 0 || sets.length === 0 || !playTags) return null;
    const playByID = new Map(plays.map((p) => [String(p.playID), p]));
    const setByID = new Map(sets.map((s) => [String(s.id ?? s.setID), s]));
    return buildCollectorProfile({ index: owned.index, editions, playByID, setByID, playTags, playLeague });
  }, [owned, editions, plays, sets, playTags, playLeague]);

  const ownedRealTotal = useMemo(() => {
    if (!account || !account.index) return 0;
    let n = 0;
    account.index.byEdition.forEach((count, key) => { if (!isMismintPlay(key.split("_")[1])) n += count; });
    return n;
  }, [account]);
  const eraRows = accountMatrices ? accountMatrices.eras : erasBySeries;
  // The collection page has no era facet yet, so era cells link only in
  // public mode (to the Plays page ?era= deep link)
  const eraLinkOf = (league) => (accountMatrices ? undefined : catalogLinkOf(league, "/plays", (label) => ({ era: ERA_KEY[label] })));

  const mintTotals = useMemo(() => ({
    NBA: seriesTiersByLeague.NBA.reduce((s, r) => s + r.total, 0),
    WNBA: seriesTiersByLeague.WNBA.reduce((s, r) => s + r.total, 0),
    otherNBA: seriesTiersByLeague.NBA.reduce((s, r) => s + (r.other ? r.other.total : r.total), 0),
    otherWNBA: seriesTiersByLeague.WNBA.reduce((s, r) => s + (r.other ? r.other.total : r.total), 0)
  }), [seriesTiersByLeague]);

  // High-level stats over the per-CID media lookup (lazy 5MB import via
  // the hook; cards render "..." until it arrives)
  // IPFS media coverage per league and series, with the same semantics as
  // the Sets page (core four media files per edition, dead-at-gateway CIDs
  // count as missing, mismints excluded), attributed per edition so the
  // leagues split cleanly
  const ipfsBySeries = useMemo(() => {
    if (sets.length === 0 || ipfsRecords.length === 0 || playLeague.size === 0) return null;
    const cidsByEdition = new Map();
    ipfsRecords.forEach((rec) => {
      cidsByEdition.set(`${Number(rec.setID)}_${Number(rec.playID)}`, rec.cids || {});
    });
    const agg = { NBA: new Map(), WNBA: new Map() };
    sets.forEach((set) => {
      const series = set.series;
      if (series === undefined || series === null) return;
      if (isBurnedSet(set.id)) return;
      const eligible = (set.playIDs || []).map((p) => String(Number(p))).filter((p) => !isMismintPlay(p));
      eligible.forEach((p) => {
        const lg = playLeague.get(p) || "NBA";
        const cids = cidsByEdition.get(`${Number(set.id)}_${p}`) || {};
        let present = 0;
        CORE_MEDIA_FIELDS.forEach((f) => {
          if (cids[f] && !isDeadMediaCid(cids[f])) present++;
        });
        const entry = agg[lg].get(series) || { present: 0, total: 0 };
        entry.present += present;
        entry.total += CORE_MEDIA_FIELDS.length;
        agg[lg].set(series, entry);
      });
    });
    const toPct = (m) => {
      const out = new Map();
      m.forEach((e, series) => out.set(series, { pct: e.total > 0 ? (e.present / e.total) * 100 : null, ...e }));
      return out;
    };
    return { NBA: toPct(agg.NBA), WNBA: toPct(agg.WNBA) };
  }, [sets, ipfsRecords, playLeague]);

  // Sets per league (a set's league = the leagues of its editions' plays)
  const setSplit = useMemo(() => {
    if (sets.length === 0 || editions.length === 0 || playLeague.size === 0) return null;
    const leaguesBySet = new Map();
    editions.forEach((ed) => {
      const lg = playLeague.get(String(ed.playID));
      if (!lg) return;
      const set = leaguesBySet.get(String(ed.setID)) || new Set();
      set.add(lg);
      leaguesBySet.set(String(ed.setID), set);
    });
    let nba = 0, wnba = 0, mixed = 0;
    leaguesBySet.forEach((lgs) => {
      if (lgs.size === 2) mixed++;
      else if (lgs.has("WNBA")) wnba++;
      else nba++;
    });
    return { nba, wnba, mixed };
  }, [sets, editions, playLeague]);

  // Corrections ledger summary: the same raw-vs-corrected diff the Corrections
  // page ledger shows, so the numbers here match it exactly
  const corrections = useMemo(() => {
    if (playsRaw.length === 0 || plays.length === 0) return null;
    return summarizeLedger(buildCorrectionLedger(playsRaw, plays));
  }, [playsRaw, plays]);

  // Franchises and distinct arenas from the curated teams file, split by league
  const franchiseStats = useMemo(() => {
    let nbaTeams = 0, wnbaTeams = 0;
    const nbaArenas = new Set(), wnbaArenas = new Set();
    Object.entries(teamsAdditions).forEach(([id, t]) => {
      if (!t.name || t.special) return;
      const wnba = isWnbaId(id);
      if (wnba) wnbaTeams++; else nbaTeams++;
      (t.arenas || []).forEach((a) => { if (a.arena) (wnba ? wnbaArenas : nbaArenas).add(a.arena); });
    });
    // Shared buildings (Lakers/Sparks in Crypto.com Arena) count once in the
    // headline but appear in both league splits
    const distinctArenas = new Set([...nbaArenas, ...wnbaArenas]).size;
    return {
      teams: { nba: nbaTeams, wnba: wnbaTeams },
      arenas: { total: distinctArenas, nba: nbaArenas.size, wnba: wnbaArenas.size }
    };
  }, []);

  // Owned counterpart of franchiseStats: distinct non-special franchises the
  // browsed address holds at least one moment of
  const ownedFranchises = useMemo(() => {
    if (!owned || !owned.index || plays.length === 0) return null;
    const byPlay = owned.index.byPlay;
    const nba = new Set(), wnba = new Set();
    plays.forEach((p) => {
      if ((byPlay.get(Number(p.playID)) || 0) === 0) return;
      const id = String(p.TeamAtMomentNBAID || "");
      const t = teamsAdditions[id];
      if (!t || !t.name || t.special) return;
      (isWnbaId(id) ? wnba : nba).add(id);
    });
    return { nba: nba.size, wnba: wnba.size };
  }, [owned, plays]);

  // Open findings: the full audit pass is heavy, so it runs after first paint
  useEffect(() => {
    if (plays.length === 0) return undefined;
    const t = setTimeout(() => {
      try {
        const a = runDataAudits(plays);
        setOpenFindings(
          a.nameConflicts.length + a.profileConflicts.length + a.boundsFindings.length +
          a.teamFindings.length + a.seasonFindings.length + a.tagCount
        );
      } catch (e) {
        console.error("Home page audit pass failed:", e);
      }
    }, 50);
    return () => clearTimeout(t);
  }, [plays]);

  // Moments on Flow EVM: one escrow read plus one RPC call, global facts
  // independent of the local database
  useEffect(() => {
    let alive = true;
    getBridgeStats()
      .then((s) => {
        if (alive) setBridgeStats(s);
      })
      .catch((e) => console.warn("Bridge stats unavailable:", e));
    return () => {
      alive = false;
    };
  }, []);

  // Mismint sets (empty duplicates the contract created by mistake) are
  // not sets anyone can collect, so they are left out of the count
  const visibleSets = sets.filter((s) => !isMismintSet(s.id));
  const seriesCount = new Set(visibleSets.map((s) => s.series).filter((v) => v !== undefined && v !== null)).size;
  const loaded = plays.length > 0;

  return (
    <div className="home-container">
      <div className="glass-panel hero-banner">
        <h1 className="hero-title"><span className="plain-emoji">🏀</span> Top Shot Explorer v2</h1>
        <p className="hero-subtitle text-muted">
          The definitive almanac of NBA and WNBA Top Shot.
          <br />
          The collectibles: officially licensed, verifiably authentic, minted on <a href="https://flow.com/" target="_blank" rel="noopener noreferrer">Flow Blockchain</a>, media on IPFS.
          <br />
          The app: open source, chain first, yours to keep.
        </p>
      </div>

      {account && (
        <div className="home-view-tabs" role="tablist">
          {[
            { id: "collection", name: "Your collection", sub: account.index ? `${fmt(ownedRealTotal)} moments` : "loading" },
            { id: "site", name: "All of Top Shot", sub: mintTotals.NBA > 0 ? <><Supply shown={mintTotals.NBA + mintTotals.WNBA} other={mintTotals.otherNBA + mintTotals.otherWNBA} title={false} /> moments <SupplyWord remaining="remaining" minted="minted" /></> : "loading" }
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={homeView === t.id}
              className={`home-view-tab${homeView === t.id ? " active" : ""}`}
              onClick={() => chooseHomeView(t.id)}
            >
              <span className="home-view-tab-name"><span className="home-view-tab-mark">{homeView === t.id ? "\u2713" : ""}</span>{t.name}</span>
              <span className="home-view-tab-sub font-mono">{t.sub}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="glass-panel" style={{ borderColor: "var(--status-danger)", color: "var(--status-danger)" }}>
          {error}
        </div>
      )}
      {loadError && (
        <div className="glass-panel" style={{ borderColor: "var(--status-danger)", color: "var(--status-danger)" }}>
          {loadError}
        </div>
      )}

      {profile && <CollectorProfile profile={profile} address={owned.address} />}

      <h3 className="home-section-title">The collection</h3>
      <div className="stats-metric-grid">
        <MetricCard
          to="/plays"
          value={owned && loaded
            ? <OwnedFraction owned={owned.index ? [...owned.index.byPlay.keys()].filter((id) => !isMismintPlay(id)).length : 0} total={realPlayCount} greenWhenFull />
            : loaded ? fmt(realPlayCount) : (stats ? fmt(stats.nextPlayID - 1) : "...")}
          label="Plays"
          desc={peopleStats
            ? (owned
              ? ownedSplitDesc(peopleStats.ownedPlayCounts.NBA, peopleStats.playCounts.NBA, peopleStats.ownedPlayCounts.WNBA, peopleStats.playCounts.WNBA)
              : splitDesc(peopleStats.playCounts.NBA, peopleStats.playCounts.WNBA))
            : undefined}
        />
        <MetricCard
          to="/sets"
          value={owned && loaded
            ? <OwnedFraction owned={owned.index ? [...owned.index.bySet.keys()].filter((id) => !isMismintSet(id)).length : 0} total={visibleSets.length} greenWhenFull />
            : loaded ? fmt(visibleSets.length) : (stats ? fmt(stats.nextSetID - 1) : "...")}
          label="Sets"
          desc={setSplit
            ? `${seriesCount} series · ${splitDesc(setSplit.nba, setSplit.wnba)}`
            : (seriesCount ? `across ${seriesCount} series` : undefined)}
        />
        {/* The local total leaves out burned sets, mismint editions and
            (by default) burned moments; the on-chain totalSupply counts them
            all, so it only fills in before the editions have synced */}
        <MetricCard
          value={owned && owned.index
            ? <OwnedFraction owned={ownedRealTotal} total={mintTotals.NBA + mintTotals.WNBA} />
            : mintTotals.NBA + mintTotals.WNBA > 0
              ? <Supply shown={mintTotals.NBA + mintTotals.WNBA} other={mintTotals.otherNBA + mintTotals.otherWNBA} format={fmt} />
              : (stats ? fmt(stats.totalSupply) : "...")}
          label={<SupplyWord remaining="Moments Remaining" minted="Moments Minted" />}
          desc={mintTotals.NBA > 0 ? `NBA ${fmtShort(mintTotals.NBA)} · WNBA ${fmtShort(mintTotals.WNBA)}` : undefined}
          // Remaining is a snapshot: burns keep happening, so the figure
          // carries the date the burn counts were read. The mint count is
          // not a snapshot, so the line swaps out with it
          note={mintTotals.NBA > 0 && burnsAsOf() ? <SupplyWord remaining={`as of ${formatDateISO(new Date(burnsAsOf()))}`} minted="" /> : undefined}
        />
        <MetricCard
          value={bridgeStats ? fmt(bridgeStats.current) : "..."}
          label="On Flow EVM"
          desc={bridgeStats && bridgeStats.allTime ? `${fmt(bridgeStats.allTime)} bridged all-time` : undefined}
        />
      </div>

      {/* History first: the collection strip, then the
          badges (facts about the moment's place in NBA history), then
          in-season vs historical, then the scarcity mechanics */}
      <h3 className="home-section-title">{accountMatrices ? "Owned badges by series" : "Badges by series"}</h3>
      <TierMatrix league="NBA" rows={badgeRows.NBA} columns={BADGE_ORDER} colors={BADGE_COLORS} headOf={(t) => <BadgeHead column={t} />} titleOf={badgeTitleFor(badgeRows.NBA, "moments")} unit="moments" totalLabel="Any badge" totalTitle={badgeTotalTitle("moments")} linkOf={badgeLinkOf("NBA")} linkText={playsText} />
      <TierMatrix league="WNBA" rows={badgeRows.WNBA} columns={BADGE_ORDER} colors={BADGE_COLORS} headOf={(t) => <BadgeHead column={t} />} titleOf={badgeTitleFor(badgeRows.WNBA, "moments")} unit="moments" totalLabel="Any badge" totalTitle={badgeTotalTitle("moments")} linkOf={badgeLinkOf("WNBA")} linkText={playsText} />

      <h3 className="home-section-title">{accountMatrices ? "Owned badges by player" : "Badges by player"}</h3>
      <TierMatrix rows={playerRows} columns={PLAYER_BADGE_ORDER} colors={PLAYER_BADGE_COLORS} headOf={(t) => <BadgeHead column={t} />} titleOf={badgeTitleFor(playerRows, "moments")} unit="moments" totalLabel="Total" totalTitle={playerTotalTitle("moments")} linkOf={playerLinkOf} linkText={playsText} />
      <form className="spotlight-add" onSubmit={addSpotlight}>
        <label htmlFor="spotlightInput" className="spotlight-add-label">Compare another player</label>
        <input id="spotlightInput" className="form-control spotlight-input" list="spotlightNames" value={spotlightDraft} onInput={(e) => { setSpotlightDraft(e.target.value); if (spotlightNote) setSpotlightNote(""); }} placeholder="Player name" autoComplete="off" />
        <datalist id="spotlightNames">{playerNames.list.map((n) => <option key={n} value={n} />)}</datalist>
        <button type="submit" className="btn-primary spotlight-add-btn">Add</button>
        {extraPlayers.map((n) => (
          <button key={n} type="button" className="spotlight-chip" onClick={() => removeSpotlight(n)} title={`Remove ${n}`}>
            {n} <span aria-hidden="true">✕</span>
          </button>
        ))}
        <span className="spotlight-note" aria-live="polite">{spotlightNote}</span>
      </form>

      <h3 className="home-section-title">{accountMatrices ? "Owned in-season vs historical by series" : "In-season vs historical mints by series"}</h3>
      <SplitMatrix league="NBA" rows={eraRows.NBA} columns={ERA_ORDER} colors={ERA_COLORS} hollow={ERA_HOLLOW} titleOf={eraTitleFor(eraRows.NBA, "mints")} linkOf={eraLinkOf("NBA")} linkText={playsText} />
      <SplitMatrix league="WNBA" rows={eraRows.WNBA} columns={ERA_ORDER} colors={ERA_COLORS} hollow={ERA_HOLLOW} titleOf={eraTitleFor(eraRows.WNBA, "mints")} linkOf={eraLinkOf("WNBA")} linkText={playsText} />

      <h3 className="home-section-title">{accountMatrices ? "Owned tiers by series" : "Tiers by series"}</h3>
      <TierMatrix league="NBA" rows={accountMatrices ? accountMatrices.tiers.NBA : seriesTiersByLeague.NBA} ipfs={accountMatrices ? undefined : (ipfsBySeries ? ipfsBySeries.NBA : null)} linkOf={tierLink("NBA")} linkText={setsText} />
      <TierMatrix league="WNBA" rows={accountMatrices ? accountMatrices.tiers.WNBA : seriesTiersByLeague.WNBA} ipfs={accountMatrices ? undefined : (ipfsBySeries ? ipfsBySeries.WNBA : null)} linkOf={tierLink("WNBA")} linkText={setsText} />

      <h3 className="home-section-title">{accountMatrices ? "Owned parallels by series" : "Parallels by series"}</h3>
      <TierMatrix league="NBA" rows={accountMatrices ? accountMatrices.parallels.NBA : parallelsBySeries.NBA} columns={PARALLEL_ORDER} colors={PARALLEL_COLORS} notes={parallelsBySeries.notes.NBA} linkOf={parallelLink("NBA")} linkText={setsText} />
      <TierMatrix league="WNBA" rows={accountMatrices ? accountMatrices.parallels.WNBA : parallelsBySeries.WNBA} columns={PARALLEL_ORDER} colors={PARALLEL_COLORS} notes={parallelsBySeries.notes.WNBA} linkOf={parallelLink("WNBA")} linkText={setsText} />

      <h3 className="home-section-title">{accountMatrices ? "Owned special serials by series" : "Special serials by series"}</h3>
      <TierMatrix league="NBA" rows={accountMatrices ? accountMatrices.serials.NBA : serialsBySeries.NBA} columns={SERIAL_ORDER} colors={SERIAL_COLORS} unit="serials" linkOf={accountMatrices ? linkOfFor("NBA", (k) => ({ special: SERIAL_SPECIAL_KEYS[k] })) : undefined} />
      <TierMatrix league="WNBA" rows={accountMatrices ? accountMatrices.serials.WNBA : serialsBySeries.WNBA} columns={SERIAL_ORDER} colors={SERIAL_COLORS} unit="serials" linkOf={accountMatrices ? linkOfFor("WNBA", (k) => ({ special: SERIAL_SPECIAL_KEYS[k] })) : undefined} />

      <h3 className="home-section-title">Players, teams and arenas</h3>
      <div className="stats-metric-grid">
        <MetricCard
          to="/players"
          value={peopleStats
            ? (owned ? <OwnedFraction owned={peopleStats.ownedPlayers.total} total={peopleStats.players.total} greenWhenFull /> : fmt(peopleStats.players.total))
            : "..."}
          label="Players"
          desc={peopleStats
            ? (owned
              ? ownedSplitDesc(peopleStats.ownedPlayers.nba, peopleStats.players.nba, peopleStats.ownedPlayers.wnba, peopleStats.players.wnba)
              : splitDesc(peopleStats.players.nba, peopleStats.players.wnba))
            : undefined}
        />
        <MetricCard
          to={ROOKIE_PLAYS_LINK}
          value={peopleStats
            ? (owned ? <OwnedFraction owned={peopleStats.ownedRookies.total} total={peopleStats.rookies.total} greenWhenFull /> : fmt(peopleStats.rookies.total))
            : "..."}
          label="Rookies"
          desc={peopleStats
            ? (owned
              ? ownedSplitDesc(peopleStats.ownedRookies.nba, peopleStats.rookies.nba, peopleStats.ownedRookies.wnba, peopleStats.rookies.wnba)
              : splitDesc(peopleStats.rookies.nba, peopleStats.rookies.wnba))
            : undefined}
        />
        <MetricCard
          to="/teams"
          value={ownedFranchises
            ? <OwnedFraction owned={ownedFranchises.nba + ownedFranchises.wnba} total={franchiseStats.teams.nba + franchiseStats.teams.wnba} greenWhenFull />
            : fmt(franchiseStats.teams.nba + franchiseStats.teams.wnba)}
          label="Teams"
          desc={ownedFranchises
            ? ownedSplitDesc(ownedFranchises.nba, franchiseStats.teams.nba, ownedFranchises.wnba, franchiseStats.teams.wnba)
            : splitDesc(franchiseStats.teams.nba, franchiseStats.teams.wnba)}
        />
        <MetricCard
          to="/arenas"
          value={fmt(franchiseStats.arenas.total)}
          label="Arenas"
          desc={splitDesc(franchiseStats.arenas.nba, franchiseStats.arenas.wnba)}
        />
        {/* The collectors themselves, from the census (data/census_stats.json):
            Dapper wallets that have held Top Shot, and how many have linked
            another wallet through account linking */}
        <MetricCard
          value={fmt(censusStats.dapperWallets)}
          label="Collectors"
          desc={`${fmt(censusStats.linkedDapperWallets)} linked to another wallet · ${fmt(censusStats.activeThisYear)} active this year`}
          note={`as of ${censusStats.asOf}`}
        />
      </div>

      {/* Data quality describes the dataset, not a collection; hidden while
          browsing as an account */}
      {!owned && <>
      {/* High-level media stats from the probed per-CID lookup */}
      <h3 className="home-section-title">IPFS media</h3>
      <div className="stats-metric-grid">
        <MetricCard
          value={ipfsMediaStats ? fmt(ipfsMediaStats.total) : "..."}
          label="Media Files on IPFS"
          desc={ipfsMediaStats
            ? `${fmt(ipfsMediaStats.videos)} MP4 · ${fmt(ipfsMediaStats.jpg)} JPG · ${fmt(ipfsMediaStats.png)} PNG · ${ipfsMediaStats.mpo} MPO`
            : undefined}
        />
        <MetricCard
          value={ipfsMediaStats ? `${(ipfsMediaStats.seconds / 86400).toFixed(1)} days` : "..."}
          label="Total Video Runtime"
          desc={ipfsMediaStats
            ? `${Math.round(ipfsMediaStats.seconds / 3600).toLocaleString()} hours across ${fmt(ipfsMediaStats.videos)} clips`
            : undefined}
        />
        <MetricCard
          value={ipfsMediaStats ? `${(ipfsMediaStats.bytes / 1e12).toFixed(2)} TB` : "..."}
          label="Total Media Size"
          desc="sizes partly estimated from bitrate"
        />
        <MetricCard
          value={ipfsMediaStats ? fmt(ipfsMediaStats.dead) : "..."}
          label="Missing files"
          desc="registered on chain, nothing at the gateway"
          accent="var(--status-mismint)"
        />
      </div>
      <div className="glass-panel res-panel">
        <div className="res-row">
          <span className="res-row-label text-muted">Videos</span>
          {ipfsMediaStats.vidDims.map(([d, n]) => (
            <span key={d} className="res-chip">
              <span className="res-chip-dim font-mono">{d}</span>
              <span className="res-chip-count">{fmt(n)}</span>
            </span>
          ))}
        </div>
        <div className="res-row">
          <span className="res-row-label text-muted">Images</span>
          {ipfsMediaStats.imgDims.map(([d, n]) => (
            <span key={d} className="res-chip">
              <span className="res-chip-dim font-mono">{d}</span>
              <span className="res-chip-count">{fmt(n)}</span>
            </span>
          ))}
          {ipfsMediaStats.imgDimsMore > 0 && (
            <span className="res-chip res-chip-more">+{fmt(ipfsMediaStats.imgDimsMore)} more sizes</span>
          )}
        </div>
      </div>

      <h3 className="home-section-title">Corrections</h3>
      {/* What the corrections are, by kind: the ledger's own labels
          (audit.service classifyCorrection), so this matches the Corrections
          page exactly. Two strips, one per tier */}
      {corrections && (
        <div className="glass-panel corrections-kinds">
          {[["factual", "Factual fixes"], ["routine", "Normalizations"]].map(([tier, title]) => (
            <div key={tier} className="corrections-kind">
              <span className="corrections-kind-title">{title}</span>
              <div className="stat-strip stat-strip-sm">
                {CORRECTION_KINDS[tier].map((label) => (
                  <div key={label} className="stat-item" title={CORRECTION_KIND_HELP[label]} style={{ cursor: "help" }}>
                    <span className="stat-label">{label}</span>
                    <span className="stat-value">{fmt(corrections.byLabel[label] || 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="stats-metric-grid">
        {/* Real corrections only (factual fixes + normalizations); context
            additions such as Dapper Labs ids and tags are not corrections and
            stay hidden in the ledger by default too */}
        <MetricCard
          to="/corrections?tab=ledger"
          value={corrections ? fmt(corrections.factual + corrections.routine) : "..."}
          label="Corrections Applied"
          desc={corrections ? `${fmt(corrections.factual)} factual fixes · ${fmt(corrections.routine)} normalizations · ${fmt(corrections.plays)} plays` : undefined}
          accent="var(--primary)"
        />
        <MetricCard
          to="/corrections?tab=findings"
          value={openFindings === null ? "..." : fmt(openFindings)}
          label="Open Findings"
          desc="automated audits awaiting judgment"
        />
        <MetricCard
          to="/corrections?tab=ledger&mismints=1"
          value={fmt(playsExclude.length)}
          label="Known Contract Mismints"
          accent="var(--status-mismint)"
        />
      </div>
      </>}

      <style>{`
        .home-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .hero-banner {
          padding: 40px 30px;
          text-align: center;
          background: linear-gradient(135deg, rgba(139, 92, 246, 0.08) 0%, rgba(59, 130, 246, 0.08) 100%);
          border-color: var(--border-glow);
        }
        .hero-title {
          font-size: 2.8rem;
          font-weight: 800;
          margin-bottom: 12px;
        }
        .hero-subtitle {
          font-size: 1.1rem;
          max-width: 800px;
          margin: 0 auto;
          line-height: 1.6;
        }
        .hero-subtitle a {
          color: inherit;
          text-decoration: underline;
          text-decoration-style: dotted;
          text-decoration-color: rgba(148, 163, 184, 0.5);
          text-underline-offset: 3px;
        }
        .hero-subtitle a:hover {
          color: var(--primary-hover);
          text-decoration-style: solid;
        }
        .home-section-title {
          margin: 28px 0 14px;
          font-size: 1rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
          font-weight: 700;
        }
        .res-panel {
          padding: 14px 20px;
          margin-top: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          min-height: 68px;
          justify-content: center;
        }
        .res-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          font-size: 0.85rem;
        }
        .res-row-label {
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          min-width: 64px;
        }
        .res-chip {
          display: inline-flex;
          align-items: baseline;
          gap: 7px;
          padding: 3px 10px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          white-space: nowrap;
        }
        .res-chip-dim {
          font-size: 0.78rem;
          color: #fff;
        }
        .res-chip-count {
          font-size: 0.72rem;
          color: var(--text-muted);
        }
        .res-chip-more {
          font-size: 0.72rem;
          color: var(--text-muted);
          background: transparent;
        }
        .tier-col-head-noted {
          align-self: start;
        }
        /* Badge column heads: one fixed-height row of full-size circles (a
           group's side by side) so the names under them all sit on the
           same line */
        .badge-head {
          display: flex;
          align-items: center;
          gap: 2px;
          height: 24px;
        }
        .tier-col-note {
          display: block;
          margin-top: 3px;
          font-size: 0.62rem;
          font-weight: 500;
          text-transform: none;
          letter-spacing: 0;
          color: var(--text-muted);
          line-height: 1.3;
        }
        .stats-metric-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
          gap: 20px;
        }
        .metric-link {
          text-decoration: none;
          color: inherit;
          display: block;
        }
        .metric-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 20px;
          text-align: center;
          transition: var(--transition-smooth);
          height: 100%;
        }
        .metric-card:hover {
          transform: translateY(-4px);
        }
        .metric-value {
          font-size: 1.8rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 4px;
        }
        .metric-label {
          font-size: 0.85rem;
          color: var(--text-muted);
          font-weight: 500;
        }
        .metric-desc {
          font-size: 0.72rem;
          color: var(--text-muted);
          margin-top: 6px;
          opacity: 0.8;
        }
        .home-view-tabs {
          display: flex;
          gap: 12px;
          margin-top: 20px;
        }
        .home-view-tab {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 16px 20px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          cursor: pointer;
          font: inherit;
          transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .home-view-tab:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
        }
        .home-view-tab.active {
          background: rgba(139, 92, 246, 0.15);
          border-color: rgba(139, 92, 246, 0.5);
          color: #fff;
          box-shadow: 0 0 12px rgba(139, 92, 246, 0.25);
        }
        .home-view-tab-name {
          font-size: 1.15rem;
          font-weight: 700;
        }
        .home-view-tab-mark {
          display: inline-block;
          width: 1.2em;
          text-align: left;
        }
        .home-view-tab-sub {
          font-size: 0.78rem;
          opacity: 0.85;
        }
        .collector-profile {
          padding: 20px 24px 16px;
          margin-top: 20px;
        }
        .collector-profile-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          justify-content: space-between;
          gap: 4px 18px;
        }
        .collector-profile-title {
          margin: 0;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--text-muted);
        }
        .collector-profile-address {
          font-size: 0.78rem;
          color: var(--text-muted);
        }
        .collector-profile-lead {
          margin: 6px 0 16px;
          font-size: 1.5rem;
          line-height: 1.25;
          color: #fff;
          font-weight: 700;
        }
        /* One tile per lean, as many across as the width allows */
        .lean-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 12px;
        }
        .lean-tile {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
          padding: 14px 16px 12px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: inherit;
          text-decoration: none;
          cursor: help;
        }
        .lean-tile-link {
          cursor: pointer;
        }
        .lean-tile-link:hover {
          background: rgba(139, 92, 246, 0.12);
          border-color: rgba(139, 92, 246, 0.4);
        }
        .lean-tile-head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 8px;
        }
        .lean-tile-dim {
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          color: var(--text-muted);
        }
        .lean-tile-lift {
          font-size: 1.35rem;
          font-weight: 800;
          line-height: 1;
          color: #fff;
          white-space: nowrap;
        }
        .lean-tile-lift-cap {
          margin-left: 5px;
          font-size: 0.68rem;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .lean-tile-value {
          font-size: 1.1rem;
          font-weight: 600;
          color: #fff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lean-bars {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr) max-content;
          column-gap: 8px;
          row-gap: 5px;
          align-items: center;
          margin-top: 4px;
        }
        .lean-bar-label {
          font-size: 0.66rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-muted);
        }
        .lean-bar-track {
          display: block;
          height: 10px;
          border-radius: 4px;
          background: rgba(0, 0, 0, 0.22);
          overflow: hidden;
        }
        .lean-bar {
          display: block;
          height: 100%;
          border-radius: 4px;
        }
        .lean-bar-you {
          background: linear-gradient(90deg, var(--primary) 0%, var(--accent-nba) 100%);
        }
        .lean-bar-label-you {
          color: #fff;
        }
        .lean-bar-expected {
          box-sizing: border-box;
          min-width: 14px;
          border: 2px solid rgba(255, 255, 255, 0.45);
          background: transparent;
        }
        .lean-bar-num {
          min-width: 4ch;
          font-size: 0.78rem;
          color: #fff;
          text-align: right;
          white-space: nowrap;
        }
        .lean-bar-num-expected {
          color: var(--text-muted);
        }
        .lean-tile-foot {
          margin-top: 2px;
          font-size: 0.72rem;
          color: var(--text-muted);
        }
        @media (max-width: 640px) {
          .home-view-tabs {
            flex-direction: column;
          }
          .collector-profile-lead {
            font-size: 1.2rem;
          }
        }
        .corrections-kinds {
          display: flex;
          flex-wrap: wrap;
          gap: 18px 40px;
          padding: 16px 24px 18px;
          margin-bottom: 20px;
        }
        .corrections-kind {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .corrections-kind-title {
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-muted);
        }
        .metric-note {
          font-size: 0.66rem;
          color: var(--text-muted);
          margin-top: 3px;
          opacity: 0.6;
        }
        .series-panel {
          padding: 18px 24px 20px;
        }
        /* The compare box under the player panels: one row, chips for the
           reader's own players, a note that only speaks when a name fails */
        .spotlight-add {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          margin-top: 12px;
          min-height: 40px;
        }
        .spotlight-add-label {
          font-size: 0.8rem;
          color: var(--text-muted);
          white-space: nowrap;
        }
        .spotlight-input {
          width: 240px;
          max-width: 100%;
          padding: 8px 12px;
          font-size: 0.85rem;
        }
        .spotlight-add-btn {
          padding: 8px 16px;
          font-size: 0.85rem;
        }
        .spotlight-chip {
          background: rgba(255, 255, 255, 0.06);
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 999px;
          padding: 5px 12px;
          font-size: 0.8rem;
          cursor: pointer;
          white-space: nowrap;
        }
        .spotlight-chip:hover {
          border-color: var(--primary-hover);
          color: var(--primary-hover);
        }
        .spotlight-note {
          font-size: 0.8rem;
          color: var(--text-muted);
        }
        .series-panel + .series-panel {
          margin-top: 16px;
        }
        .league-chart-title {
          margin: 0 0 12px;
          font-size: 0.85rem;
          letter-spacing: 1px;
          color: #fff;
        }
        .tier-matrix {
          display: grid;
          column-gap: 14px;
          row-gap: 7px;
          align-items: center;
          /* Phones: the matrix scrolls inside its panel; the page itself
             must never scroll horizontally */
          overflow-x: auto;
          max-width: 100%;
        }
        .tier-matrix-row {
          display: contents;
        }
        .tier-col-head {
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .tier-total-head {
          color: var(--text-muted);
          text-align: right;
        }
        .series-label {
          font-size: 0.85rem;
          color: #fff;
          text-decoration: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Player names wrap rather than truncate: a name cut short is a
           wrong name */
        .series-label-wrap {
          white-space: normal;
          line-height: 1.2;
        }
        .tier-cell {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .tier-cell-bar-track {
          display: block;
          position: relative;
          height: 8px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.04);
          overflow: hidden;
        }
        /* The burned span of a cell, visible while the pointer is on the
           cell and its number swaps: the tier colour at half strength under
           a hatch, so it reads as texture whether it extends the bar or
           overlays its tail */
        .tier-cell-bar-burn {
          min-width: 3px;
          position: absolute;
          top: 0;
          bottom: 0;
          opacity: 0;
          border-radius: 3px;
          background-image: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.55) 0 2px, transparent 2px 5px);
          transition: opacity 0.15s ease;
        }
        .tier-cell:hover .tier-cell-bar-burn {
          opacity: 0.75;
        }
        /* A cell with nothing in it: the track sinks a shade below the
           panel instead of sitting a shade above it, so empty reads as
           empty rather than as a bar too short to see */
        .tier-cell-bar-track-empty {
          background: rgba(0, 0, 0, 0.22);
        }
        .tier-cell-bar {
          display: block;
          height: 100%;
          border-radius: 3px;
        }
        .tier-cell-num {
          font-size: 0.68rem;
          color: var(--text-muted);
          line-height: 1;
        }
        .tier-head-link {
          text-decoration: none;
        }
        .tier-head-link:hover {
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        /* Account mode: cells are links into the filtered collection */
        .tier-cell-link {
          text-decoration: none;
          color: inherit;
          cursor: pointer;
        }
        .tier-cell-link:hover .tier-cell-num,
        .tier-cell-link.tier-total:hover {
          color: var(--primary-hover);
        }
        .tier-cell-link:hover .tier-cell-bar-track {
          background: rgba(139, 92, 246, 0.14);
        }
        .tier-total {
          text-align: right;
          font-size: 0.78rem;
          color: #fff;
          align-self: center;
        }
        .tier-sum-label {
          font-size: 0.72rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-muted);
          padding-top: 4px;
        }
        .tier-sum {
          color: #fff;
          font-weight: 700;
          padding-top: 4px;
        }
        /* Split matrix: one stacked bar per row, both sides on one scale */
        .split-matrix {
          row-gap: 9px;
        }
        .split-bar {
          display: flex;
          height: 13px;
          border-radius: 4px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.04);
        }
        .split-seg {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          font-size: 0.58rem;
          font-weight: 800;
          color: #0f1118;
          text-decoration: none;
          overflow: hidden;
          white-space: nowrap;
          flex-shrink: 0;
        }
        a.split-seg:hover {
          filter: brightness(1.2);
        }
        /* The norm draws as a soft grey fill with a faint outline
           (fully hollow read as empty), dim beside the colour */
        .split-seg-hollow {
          box-sizing: border-box;
          background: rgba(148, 163, 184, 0.22);
          border: 1px solid rgba(255, 255, 255, 0.10);
          color: var(--text-muted);
          font-weight: 600;
        }
        a.split-seg-hollow:hover {
          border-color: rgba(139, 92, 246, 0.6);
          color: var(--primary-hover);
        }
        @media (max-width: 760px) {
          .tier-matrix {
            column-gap: 8px;
          }
          .tier-col-head {
            font-size: 0.6rem;
            letter-spacing: 0;
          }
          .series-label {
            font-size: 0.72rem;
          }
        }
      `}</style>
    </div>
  );
}
