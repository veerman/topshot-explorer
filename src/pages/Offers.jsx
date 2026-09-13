import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Loader } from "../components/Loader";
import { writeFilters, useFacetFilters, useSortState, readSort, cascadeOf } from "../hooks/useFacetFilters";
import { SortableTh } from "../components/SortableTh";
import { useToggleSet } from "../hooks/useToggleSet";
import { Link } from "react-router-dom";
import { subeditionLabel } from "../services/fcl.service";
import { Pagination } from "../components/Pagination";
import { getAllPlaysDB, getAllSetsDB } from "../services/db.service";
import { tierFacetRank as tierRank } from "../utils/display.utils";
import { EditionCells } from "../components/MomentIdentity";
import { buildIdentityContext, BLANK_IDENTITY, EDITION_HEADINGS } from "../services/identity.service";
import { externalNftUrlByName, externalEditionUrlByName } from "../services/flowEvents.service";
import { loadOffersSnapshot, formatOfferAmount } from "../services/offers.service";
import { MultiSelect } from "../components/MultiSelect";
import { toQuery } from "../utils/query";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { useUsernames, addressTitle } from "../services/usernames.service";
import { AddressName } from "../components/AddressName";
import { SignInNote } from "../components/SignInNote";

/*
 * Marketplace-wide offers, from the baked snapshot (npm run offers).
 *
 * Active tab: edition-level and subedition-level Top Shot offers on the
 * same play COLLAPSE into one row per edition id (top offer shown; the
 * Offers count expands into every individual offer); serial-level offers
 * get a row per targeted moment (they only carry the moment id on chain,
 * no global moment -> edition index, so those rows link out to
 * nbatopshot.com). The Collection facet scopes the page (default: Top
 * Shot alone); other collections' offers show their raw targeting
 * params since we hold no local metadata to enrich them with.
 *
 * Accepted tab: offers that were actually accepted (sales via offers),
 * from the OfferCompleted event stream; cancellations are not tracked.
 */

const TYPE_LABELS = { serial: "Serial", edition: "Edition", subedition: "Subedition" };

// Raw targeting params are stored as "k=v · k=v"; shown as "k: v, k: v".
// "marketplace" is hidden (every MFL offer carries the same value). An
// "expiry" param that has passed means the offer can no longer resolve,
// so the row is dropped from the Active tab entirely.
const HIDDEN_PARAMS = new Set(["marketplace"]);
const blobPairs = (blob) => String(blob || "").split(" · ").filter(Boolean).map((part) => {
  const i = part.indexOf("=");
  return i < 0 ? [part, ""] : [part.slice(0, i), part.slice(i + 1)];
}).filter(([k]) => !HIDDEN_PARAMS.has(k));
// Friendly names for the common targeting params
const PARAM_LABELS = { nftId: "NFT #", editionId: "Edition #", serialNumber: "Serial #" };
const paramText = ([k, v]) => (PARAM_LABELS[k] ? `${PARAM_LABELS[k]}${v}` : v ? `${k}: ${v}` : k);
const blobExpired = (blob, nowMs) =>
  blobPairs(blob).some(([k, v]) => k === "expiry" && Number(v) > 0 && Number(v) * 1000 < nowMs);

// Target params for OTHER collections; an nftId or editionId links
// straight to the vendor's page when the catalogue knows one
// (MFL, AllDay, Golazos, ...). `exclude` drops params another column
// already carries.
const otherTarget = (coll, blob, exclude) => {
  const pairs = blobPairs(blob).filter(([k]) => !exclude || !exclude.includes(k));
  if (pairs.length === 0) return "-";
  const parts = pairs.map((pair, i) => {
    const [k, v] = pair;
    const url = k === "nftId" ? externalNftUrlByName(coll, v)
      : k === "editionId" ? externalEditionUrlByName(coll, v)
      : null;
    return url
      ? <a key={`${k}${i}`} href={url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: "600", whiteSpace: "nowrap" }}>{paramText(pair)} ↗</a>
      : <span key={`${k}${i}`} style={{ whiteSpace: "nowrap" }}>{paramText(pair)}</span>;
  });
  return parts.flatMap((p, i) => (i > 0 ? [", ", p] : [p]));
};
const typeKeyOf = (level) => (
  level === "NFT" ? "serial"
  : level === "TopShotEdition" ? "edition"
  : level === "TopShotSubedition" ? "subedition"
  : (level || "unknown"));

// Filters live in the URL, same convention as the account pages; ?tab=
// and ?all= ride along so the whole view is shareable. The read/write/
// cascade machinery is shared (hooks/useFacetFilters).
// `owned` is a number, not a list: offers on what the account in context
// holds at least that many copies of (Active tab, account mode only)
const EMPTY_FILTERS = { otype: [], coll: [], league: [], series: [], set: [], sub: [], tier: [], type: [], year: [], player: [], team: [], owned: "" };
const FILTER_KEYS = Object.keys(EMPTY_FILTERS);

const DEFAULT_SORT = { key: "amount", dir: "desc" };
// The Accepted tab sorts independently (its own columns), newest first
const DEFAULT_ACCEPTED_SORT = { key: "when", dir: "desc" };

function writeStateToLocation(filters, tab, sort, acceptedSort) {
  const params = new URLSearchParams();
  if (tab !== "active") params.set("tab", tab);
  writeFilters(params, filters, EMPTY_FILTERS);
  // The Collection scope stays URL-compatible with the retired "Top Shot
  // only" checkbox: the Top Shot default writes nothing, "everything"
  // writes the old all=1, an explicit selection rides in coll= as usual
  if (filters.coll.length === 1 && filters.coll[0] === "TopShot") params.delete("coll");
  else if (filters.coll.length === 0) params.set("all", "1");
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  if (acceptedSort.key !== DEFAULT_ACCEPTED_SORT.key || acceptedSort.dir !== DEFAULT_ACCEPTED_SORT.dir) {
    params.set("asort", acceptedSort.key);
    params.set("adir", acceptedSort.dir);
  }
  const qs = toQuery(params);
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

// Blank play facts for rows with no local metadata (serial-level and
// other-collection offers)
const BLANK_FACTS = BLANK_IDENTITY;

export function Offers() {
  const [snap, setSnap] = useState(null);
  // Browsing as an account: the Owned filter and the names of buyers
  const owned = useAccountCollection();
  useUsernames();
  const [missing, setMissing] = useState(false);
  const [localMeta, setLocalMeta] = useState(null);
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "accepted" || t === "leaders" ? t : "active";
  });
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  const resetPage = useCallback(() => setCurrentPage(1), []);
  // A static snapshot only needs one "now" for age labels
  const [now] = useState(() => Date.now());
  // Rows whose full offer list is expanded
  const [expanded, toggleExpanded] = useToggleSet();

  // The Collection facet replaced the "Top Shot only" checkbox
  // (2026-09-07): it defaults to Top Shot alone and an empty selection
  // means every collection. Old URLs keep their meaning: no param reads
  // as Top Shot, the retired checkbox's ?all=1 reads as "everything".
  const [emptyFilters] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return { ...EMPTY_FILTERS, coll: p.get("all") === "1" ? [] : ["TopShot"] };
  });
  const { filters, setFilter, clearFilters } = useFacetFilters(emptyFilters, { onChange: resetPage });
  // Scope shorthands: showAll keeps its old name because a dozen render
  // spots (Collection columns, stats buckets) key off it unchanged
  const topShotScoped = filters.coll.length === 1 && filters.coll[0] === "TopShot";
  const showAll = !topShotScoped;
  // "Filters active" for the count label and Clear button: neither the
  // default Top Shot scope nor the all-collections scope counts
  const anyExtraFilter = FILTER_KEYS.some((k) => (k === "coll"
    ? filters.coll.length > 0 && !topShotScoped
    : filters[k].length > 0));

  // Sort lives in the URL alongside the filters, so a sorted view is
  // shareable and survives refresh (only non-default sorts are written)
  const { sort, sortBy } = useSortState(readSort(DEFAULT_SORT), { onChange: resetPage });
  const { sort: acceptedSort, sortBy: acceptedSortBy } = useSortState(
    readSort(DEFAULT_ACCEPTED_SORT, { keyParam: "asort", dirParam: "adir" }),
    { onChange: resetPage }
  );

  useEffect(() => {
    writeStateToLocation(filters, tab, sort, acceptedSort);
  }, [filters, tab, sort, acceptedSort]);

  useEffect(() => {
    let cancelled = false;
    loadOffersSnapshot().then((s) => {
      if (cancelled) return;
      if (s) setSnap(s);
      else setMissing(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllPlaysDB(), getAllSetsDB()])
      .then(([plays, sets]) => {
        if (cancelled) return;
        // The shared identity facts (components/MomentIdentity): names,
        // badges, tier, league per edition, cached inside the context
        setLocalMeta(buildIdentityContext(plays, sets));
      })
      .catch(() => { if (!cancelled) setLocalMeta(buildIdentityContext([], [])); });
    return () => { cancelled = true; };
  }, []);

  const ageOf = (ts) => {
    if (!ts) return null;
    const secs = Math.max(0, (now - ts) / 1000);
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  };
  const ageCell = (ts, note) => (ts
    ? <span title={new Date(ts).toLocaleString()}>{ageOf(ts)}</span>
    : <span className="text-muted" title={note || "This offer predates the watch window, so its creation time is unknown"}>-</span>);

  // Stable identity matters: this sits in the deps of the offerFacts and
  // acceptedFacts memos, which rebuild fact arrays over the whole
  // snapshot; a fresh arrow every render would defeat both
  const playFactsOf = useCallback((setID, playID) => (localMeta ? localMeta.factsOf(setID, playID) : {}), [localMeta]);

  // One fact record per ACTIVE-tab row: Top Shot serial rows per moment,
  // Top Shot edition/subedition offers collapsed per edition id, other
  // collections grouped per (collection, level, params)
  const offerFacts = useMemo(() => {
    if (!snap || !localMeta) return null;
    const out = [];
    // entry arrays are [amount, buyer, offerId, createdAt]
    const byEdition = new Map();
    const groupOf = (setID, playID) => {
      const key = `${setID}_${playID}`;
      let g = byEdition.get(key);
      if (!g) byEdition.set(key, (g = { key, setID, playID, entries: [], subs: new Set(), types: new Set() }));
      return g;
    };
    Object.entries(snap.offers.edition).forEach(([key, list]) => {
      const [setID, playID] = key.split("_").map(Number);
      const g = groupOf(setID, playID);
      g.types.add("edition");
      list.forEach(([amount, buyer, , created]) => g.entries.push({ sub: null, amount, buyer, created: created || 0 }));
    });
    Object.entries(snap.offers.subedition).forEach(([key, list]) => {
      const [setID, playID, subID] = key.split("_").map(Number);
      const g = groupOf(setID, playID);
      g.types.add("subedition");
      g.subs.add(subID);
      list.forEach(([amount, buyer, , created]) => g.entries.push({ sub: subID, amount, buyer, created: created || 0 }));
    });
    byEdition.forEach((g) => {
      g.entries.sort((a, b) => b.amount - a.amount);
      const best = g.entries[0];
      out.push({
        rowKey: `e:${g.key}`, kind: "edition", coll: "TopShot", setID: g.setID, playID: g.playID, nftID: null,
        entries: g.entries, subs: g.subs, types: g.types, blob: "",
        amount: best.amount, buyer: best.buyer, created: best.created, count: g.entries.length,
        ...playFactsOf(g.setID, g.playID)
      });
    });
    Object.entries(snap.offers.nft).forEach(([momentID, list]) => {
      out.push({
        rowKey: `n:${momentID}`, kind: "serial", coll: "TopShot", setID: null, playID: null, nftID: momentID,
        entries: list.map(([amount, buyer, , created]) => ({ sub: null, amount, buyer, created: created || 0 })),
        subs: new Set(), types: new Set(["serial"]), blob: "",
        amount: list[0][0], buyer: list[0][1], created: list[0][3] || 0, count: list.length,
        ...BLANK_FACTS
      });
    });
    // Other collections: [collection, amount, buyer, offerId, createdAt, level, blob]
    const byOther = new Map();
    (snap.other || []).forEach(([coll, amount, buyer, , created, level, blob]) => {
      if (blob && blobExpired(blob, now)) return;
      const key = `o:${coll}|${level}|${blob}`;
      let g = byOther.get(key);
      if (!g) byOther.set(key, (g = { key, coll, level, blob, entries: [] }));
      g.entries.push({ sub: null, amount, buyer, created: created || 0 });
    });
    byOther.forEach((g) => {
      g.entries.sort((a, b) => b.amount - a.amount);
      const best = g.entries[0];
      out.push({
        rowKey: g.key, kind: "other", coll: g.coll, setID: null, playID: null, nftID: null,
        entries: g.entries, subs: new Set(), types: new Set([typeKeyOf(g.level)]), blob: g.blob,
        amount: best.amount, buyer: best.buyer, created: best.created, count: g.entries.length,
        ...BLANK_FACTS
      });
    });
    return out;
  }, [snap, localMeta, playFactsOf, now]);

  // Every collection's rows enter the cascade; the Collection facet
  // itself does the scoping (default Top Shot), so its options always
  // list what else is out there

  // Copies the account holds of exactly what a row's offers want: per
  // parallel for an edition row (an edition-level offer is the standard
  // run), the moment itself for a serial offer. Other collections: none.
  const ownedMoments = useMemo(() => {
    if (!owned || !owned.index) return null;
    const set = new Set();
    owned.index.ids.forEach((list) => list.forEach((id) => set.add(Number(id))));
    return set;
  }, [owned]);
  const ownedCopiesOf = useCallback((f) => {
    if (!owned || !owned.index) return 0;
    if (f.kind === "serial") return ownedMoments && ownedMoments.has(Number(f.nftID)) ? 1 : 0;
    if (f.kind !== "edition") return 0;
    let best = 0;
    f.entries.forEach((e) => {
      const n = (owned.index.serials.get(`${f.setID}_${f.playID}_${e.sub === null ? 0 : e.sub}`) || []).length;
      if (n > best) best = n;
    });
    return best;
  }, [owned, ownedMoments]);

  const passFns = useMemo(() => ({
    // A collapsed row passes Type when ANY of its offers is of that type,
    // and Subedition when any offer targets that parallel
    otype: (types) => filters.otype.length === 0 || filters.otype.some((t) => types.has(t)),
    // Active tab only: accepted offers are already sold
    owned: (f) => tab !== "active" || !filters.owned || !owned || ownedCopiesOf(f) >= Number(filters.owned),
    coll: (v) => filters.coll.length === 0 || filters.coll.includes(v),
    league: (v) => filters.league.length === 0 || (Boolean(v) && filters.league.includes(v)),
    series: (v) => filters.series.length === 0 || (v != null && filters.series.includes(String(v))),
    set: (v) => filters.set.length === 0 || (Boolean(v) && filters.set.includes(v)),
    sub: (subs) => filters.sub.length === 0 || filters.sub.some((s) => subs.has(Number(s))),
    tier: (v) => filters.tier.length === 0 || (Boolean(v) && filters.tier.includes(v)),
    type: (v) => filters.type.length === 0 || (Boolean(v) && filters.type.includes(v)),
    year: (v) => filters.year.length === 0 || (Boolean(v) && filters.year.includes(v)),
    player: (v) => filters.player.length === 0 || (Boolean(v) && filters.player.includes(v)),
    team: (v) => filters.team.length === 0 || (Boolean(v) && filters.team.includes(v))
  }), [filters, tab, owned, ownedCopiesOf]);

  // Cascade rule shared with the account pages (hooks/useFacetFilters);
  // used by both the Active and Accepted tabs, whose fact records carry
  // the same field names.
  const computeFacets = useCallback((list) => {
    const opts = { otype: new Set(), coll: new Set(), league: new Set(), series: new Set(), set: new Set(), sub: new Set(), tier: new Set(), type: new Set(), year: new Set(), player: new Set(), team: new Set() };
    const matched = [];
    list.forEach((f) => {
      const pass = {
        otype: passFns.otype(f.types),
        coll: passFns.coll(f.coll),
        league: passFns.league(f.league),
        series: passFns.series(f.series),
        set: passFns.set(f.setName),
        sub: passFns.sub(f.subs),
        tier: passFns.tier(f.tier),
        type: passFns.type(f.ptype),
        year: passFns.year(f.year),
        player: passFns.player(f.player),
        team: passFns.team(f.team),
        owned: passFns.owned(f)
      };
      const { matched: rowMatched, offer } = cascadeOf(pass, FILTER_KEYS);
      if (rowMatched) matched.push(f);
      if (offer("otype")) f.types.forEach((t) => opts.otype.add(t));
      if (offer("coll")) opts.coll.add(f.coll);
      if (offer("league") && f.league) opts.league.add(f.league);
      if (offer("series") && f.series != null) opts.series.add(f.series);
      // By name: the same set name across series is one option, and the
      // Series facet narrows it to that series' set
      if (offer("set") && f.setName) opts.set.add(f.setName);
      if (offer("sub")) f.subs.forEach((s) => opts.sub.add(s));
      if (offer("tier") && f.tier) opts.tier.add(f.tier);
      if (offer("type") && f.ptype) opts.type.add(f.ptype);
      if (offer("year") && f.year) opts.year.add(f.year);
      if (offer("player") && f.player) opts.player.add(f.player);
      if (offer("team") && f.team) opts.team.add(f.team);
    });
    return { opts, matched };
  }, [passFns]);

  const facetData = useMemo(() => {
    if (!offerFacts) return null;
    const r = computeFacets(offerFacts);
    r.matched.sort((a, b) => (b.amount - a.amount) || (b.count - a.count) || ((b.playID || 0) - (a.playID || 0)));
    return r;
  }, [offerFacts, computeFacets]);

  // Click-to-sort for the active table's headings
  const sortedMatched = useMemo(() => {
    if (!facetData) return null;
    // Default view: matched is already in exactly this order (same early
    // return sortedAccepted has)
    if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) return facetData.matched;
    const val = (f) => {
      switch (sort.key) {
        case "coll": return f.coll;
        case "set": return f.setName || "";
        case "player": return f.player || "";
        case "created": return f.created || 0;
        case "count": return f.count;
        default: return f.amount;
      }
    };
    const dir = sort.dir === "asc" ? 1 : -1;
    const rows = [...facetData.matched];
    rows.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return (cmp * dir) || (b.amount - a.amount) || (b.count - a.count);
    });
    return rows;
  }, [facetData, sort]);
  // The Set/Play/Subedition/Player columns only mean anything for Top
  // Shot rows; when the matched list holds none (say, Collection
  // filtered to AllDay) they disappear entirely
  const editionCols = !showAll || !sortedMatched || sortedMatched.length === 0
    || sortedMatched.some((f) => f.coll === "TopShot");

  const sortTh = (label, key, title) => (
    <SortableTh label={label} sortKey={key} sort={sort} onSort={sortBy} title={title ? `${title} Click to sort.` : `Sort by ${label}`} />
  );
  const accTh = (label, key, title) => (
    <SortableTh label={label} sortKey={key} sort={acceptedSort} onSort={acceptedSortBy} title={title || `Sort by ${label.toLowerCase()}`} />
  );

  // Leaders tab scope: a collection dropdown; empty = follow the
  // Collection facet (a single selected collection carries over, anything
  // else means every collection). "all" means every collection, otherwise
  // a collection name matching the baked per-collection aggregates.
  const [leadersColl, setLeadersColl] = useState("");
  const leadersScope = leadersColl || (filters.coll.length === 1 ? filters.coll[0] : "all");

  // Leader boards: active-offer commitments computed from the snapshot
  // (it holds every active offer); accepted aggregates come pre-baked
  // from the FULL history (the visible accepted feed is capped)
  const leaders = useMemo(() => {
    if (!snap) return null;
    const buyersActive = new Map();
    let activeCount = 0;
    let activeValue = 0;
    const bump = (addr, amount) => {
      const cur = buyersActive.get(addr) || [0, 0, 0];
      cur[0]++;
      cur[1] += amount;
      cur[2] = Math.max(cur[2], amount);
      buyersActive.set(addr, cur);
      activeCount++;
      activeValue += amount;
    };
    if (leadersScope === "all" || leadersScope === "TopShot") {
      for (const map of [snap.offers.edition, snap.offers.subedition, snap.offers.nft]) {
        for (const list of Object.values(map)) for (const [amount, buyer] of list) bump(buyer, amount);
      }
    }
    if (leadersScope !== "TopShot") {
      // Same rule as the Active tab: a passed expiry param means the
      // offer is dead, so it commits nothing (Top Shot offers never
      // carry an expiry)
      for (const [coll, amount, buyer, , , , blob] of (snap.other || [])) {
        if (blob && blobExpired(blob, now)) continue;
        if (leadersScope === "all" || coll === leadersScope) bump(buyer, amount);
      }
    }
    // Kept unsliced: the render re-ranks by value, count or top on demand
    const buyersBoard = [...buyersActive.entries()]
      .map(([addr, [count, value, top]]) => ({ addr, count, value, top }))
      .sort((a, b) => b.value - a.value);
    const stats = snap.acceptedStats;
    const accepted = !stats ? null
      : leadersScope === "all" ? stats.all
      : (stats.byColl && stats.byColl[leadersScope]) || (leadersScope === "TopShot" ? stats.topshot : null);
    return { activeCount, activeValue, buyersBoard, accepted };
  }, [snap, leadersScope, now]);

  // Collections offered by the Leaders dropdown, Top Shot first
  const leaderColls = useMemo(() => {
    if (!snap) return ["TopShot"];
    const names = new Set(["TopShot"]);
    Object.keys(snap.acceptedStats?.byColl || {}).forEach((c) => names.add(c));
    (snap.other || []).forEach(([coll]) => names.add(coll));
    return ["TopShot", ...[...names].filter((c) => c !== "TopShot").sort()];
  }, [snap]);

  // Each leader board can rank by value (default) or by count; the
  // accepted boards come pre-baked both ways because the top-100 by one
  // metric can miss the leaders of the other
  const [rankActive, setRankActive] = useState("value");
  const [rankBuyers, setRankBuyers] = useState("value");
  const [rankSellers, setRankSellers] = useState("value");
  const rankTh = (label, key, cur, setCur) => (
    <th
      onClick={() => setCur(key)}
      title={`Rank the board by ${label.toLowerCase()}`}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      {label}{cur === key ? " ▼" : ""}
    </th>
  );
  const byCount = (list) => [...list].sort((a, b) => (b[1] - a[1]) || (b[2] - a[2]));

  // Accepted tab rows: [ts, collection, amount, buyer, seller, level,
  // setId, playId, subId, soldNftId, blob], newest first from the bake;
  // the Collection facet scopes them through the shared cascade
  const acceptedRows = useMemo(() => (snap ? (snap.accepted || []) : null), [snap]);

  // One fact record per accepted row, same field names as the active
  // facts, so the SAME facet bar and cascade filter the feed
  const acceptedFacts = useMemo(() => {
    if (!acceptedRows || !localMeta) return null;
    return acceptedRows.map((row) => {
      const [, coll, , , , level, setId, playId, subId] = row;
      const isTS = coll === "TopShot";
      const hasFacts = isTS && setId && playId;
      const facts = hasFacts ? playFactsOf(Number(setId), Number(playId)) : BLANK_FACTS;
      return {
        row,
        coll,
        types: new Set([typeKeyOf(level)]),
        setID: isTS && setId ? Number(setId) : null,
        subs: isTS && subId ? new Set([Number(subId)]) : new Set(),
        // For acceptedCells: null mirrors its own "no facts" state, so the
        // renderer never re-derives what this memo already computed
        cellFacts: hasFacts ? facts : null,
        ...facts
      };
    });
  }, [acceptedRows, localMeta, playFactsOf]);

  const acceptedFacetData = useMemo(() => {
    if (!acceptedFacts) return null;
    return computeFacets(acceptedFacts);
  }, [acceptedFacts, computeFacets]);
  const acceptedMatched = acceptedFacetData?.matched || null;

  // Click-to-sort for the accepted table; row layout reminder:
  // [ts, coll, amount, buyer, seller, level, setId, playId, subId, ...]
  const sortedAccepted = useMemo(() => {
    if (!acceptedMatched) return null;
    const { key, dir } = acceptedSort;
    if (key === DEFAULT_ACCEPTED_SORT.key && dir === DEFAULT_ACCEPTED_SORT.dir) return acceptedMatched;
    const val = (af) => {
      switch (key) {
        case "coll": return af.coll;
        case "set": return af.setName || "";
        case "player": return af.player || "";
        case "sub": return Number(af.row[8]) || 0;
        case "amount": return af.row[2];
        case "buyer": return af.row[3] || "";
        case "seller": return af.row[4] || "";
        default: return af.row[0];
      }
    };
    const d = dir === "asc" ? 1 : -1;
    const rows = [...acceptedMatched];
    rows.sort((a, b) => {
      let cmp;
      if (key === "edition") {
        cmp = (Number(a.row[6]) - Number(b.row[6])) || (Number(a.row[7]) - Number(b.row[7]));
      } else {
        const va = val(a);
        const vb = val(b);
        cmp = typeof va === "string" ? va.localeCompare(vb) : (Number(va) || 0) - (Number(vb) || 0);
      }
      // Ties fall back to newest first
      return (cmp * d) || (b.row[0] - a.row[0]);
    });
    return rows;
  }, [acceptedMatched, acceptedSort]);

  // Same rule as the active table: Set/Player/Subedition columns only
  // exist while the visible accepted rows hold Top Shot sales
  const acceptedEditionCols = !showAll || !acceptedMatched || acceptedMatched.length === 0
    || acceptedMatched.some((f) => f.coll === "TopShot");

  // The TRUE accepted total for the current scope, from the baked full
  // history; the feed itself keeps only the newest rows, so the table
  // can hold fewer than this
  const acceptedTotal = snap?.acceptedStats
    ? snap.acceptedStats[showAll ? "all" : "topshot"].count
    : (acceptedRows || []).length;

  const totalPages = tab === "accepted"
    ? (Math.ceil((acceptedMatched?.length || 0) / pageSize) || 1)
    : tab === "active"
      ? (Math.ceil((sortedMatched?.length || 0) / pageSize) || 1)
      : 1;
  const pageRows = tab === "accepted"
    ? (sortedAccepted ? sortedAccepted.slice((currentPage - 1) * pageSize, currentPage * pageSize) : [])
    : (sortedMatched ? sortedMatched.slice((currentPage - 1) * pageSize, currentPage * pageSize) : []);

  const subLabel = subeditionLabel;
  const msFacet = (label, key, options) => ((options.length > 1 || filters[key].length > 0)
    ? <MultiSelect label={label} values={filters[key]} options={options} onChange={(vals) => setFilter(key, vals)} />
    : null);

  const money = (amount) => (
    <span className="font-mono" style={{ color: "var(--status-success)", fontWeight: "700", whiteSpace: "nowrap" }}>
      {formatOfferAmount(amount)}
    </span>
  );
  // Addresses show as @username when the directory knows them, the full
  // address otherwise; the hover always carries the address
  const buyerLink = (addr) => (
    <Link to={`/account/${addr}/offers`} className="font-mono" title={addressTitle(addr, "the buyer; opens their offers page")}><AddressName address={addr} /></Link>
  );
  // Leader boards show the FULL address (Flow addresses are short
  // enough; never ellipsize a wallet address), at a reduced size so three
  // boards still sit side by side
  const boardBuyer = (addr) => (
    <Link to={`/account/${addr}/offers`} className="font-mono" style={{ whiteSpace: "nowrap", fontSize: "0.72rem" }} title={addressTitle(addr, "opens their offers page")}><AddressName address={addr} /></Link>
  );
  const boardSeller = (addr) => (
    <Link to={`/account/${addr}`} className="font-mono" style={{ whiteSpace: "nowrap", fontSize: "0.72rem" }} title={addressTitle(addr, "opens their account page")}><AddressName address={addr} /></Link>
  );

  const dashCell = <span className="text-muted">-</span>;

  /** Edition / NFT / Set / Player / Subedition cells for an accepted sale
      or a purchased-in-book offer. Everything here is a sold NFT, so the
      NFT column carries the bare id. */
  const acceptedCells = (coll, level, setId, playId, subId, soldNftId, blob, cellFacts) => {
    const isTS = coll === "TopShot";
    // Callers with a fact record in hand (the accepted feed) pass it;
    // undefined means derive here (the purchased-in-books table)
    const f = cellFacts !== undefined ? cellFacts : (isTS && setId && playId ? playFactsOf(Number(setId), Number(playId)) : null);
    const nftUrl = soldNftId
      ? (isTS ? `https://nbatopshot.com/moment/${soldNftId}?tab=details` : externalNftUrlByName(coll, soldNftId))
      : null;
    return (
      <>
        <td className="font-mono" style={isTS ? undefined : { fontSize: "0.8rem", maxWidth: "300px", overflowWrap: "anywhere" }}>
          {f ? <Link to={`/editions/${Number(setId)}_${Number(playId)}`}>{Number(setId)}_{Number(playId)}</Link>
            : !isTS && blob ? <span className="text-muted">{otherTarget(coll, blob, ["nftId"])}</span>
            : !isTS && level ? <span className="text-muted">{level}</span>
            : dashCell}
        </td>
        {/* "NFT #id": the id, never a serial (the feed has no lookups);
            the Live page shows "#serial" once it has resolved one */}
        <td className="font-mono" style={{ whiteSpace: "nowrap" }}>
          {soldNftId
            ? (nftUrl
              ? <a href={nftUrl} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: "nowrap" }}>NFT #{soldNftId} ↗</a>
              : <>NFT #{soldNftId}</>)
            : dashCell}
        </td>
        {acceptedEditionCols && (
          <EditionCells facts={f} setID={Number(setId)} playID={Number(playId)} subID={isTS && subId ? Number(subId) : 0} />
        )}
      </>
    );
  };

  if (missing) {
    return (
      <div className="glass-panel text-center" style={{ padding: "60px 20px" }}>
        <h3>No offers snapshot</h3>
        <p className="text-muted mt-8">
          This page reads the active-offers snapshot, which has not been generated on this deployment.
          Run <span className="font-mono">npm run offers</span> and rebuild.
        </p>
      </div>
    );
  }

  const tabBtn = (key, label) => (
    <button
      type="button"
      onClick={() => { setTab(key); setCurrentPage(1); }}
      className="btn-primary"
      style={{
        padding: "5px 16px", fontSize: "0.85rem", boxShadow: "none",
        background: tab === key ? "var(--primary)" : "rgba(255,255,255,0.06)",
        border: `1px solid ${tab === key ? "var(--primary)" : "rgba(255,255,255,0.12)"}`
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ maxWidth: "1250px", margin: "0 auto", width: "100%" }}>
      <div className="glass-panel" style={{ padding: "30px" }}>
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <h1 style={{ fontSize: "2rem" }}>Offers</h1>
            <p className="text-muted mt-8" style={{ fontSize: "0.9rem" }}>
              Every active marketplace offer, one row per edition (or per moment for serial-level offers), and the offers
              that were accepted. Offers are read live from the Flow Blockchain: active offers of any age, accepted
              ones within the watched window.
            </p>
            <SignInNote />
            {/* Header stats are Top Shot only; other collections sit
                behind the Collection facet's scope. Plain text on
                purpose: the old pill badges read as buttons next to the
                real tab buttons below. The segments
                follow the pipeline in order (watch a window of blocks ->
                discover buyers -> read their standing offers, any age ->
                acceptances inside the window) so the window is understood
                FIRST and nobody reads the offer count as "every offer
                ever" or the window as "8 days of offers". */}
            {snap && (() => {
              const numStyle = { color: "#fff", fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: "0.95rem", marginRight: "3px" };
              const from = snap.scannedFromTime ? new Date(snap.scannedFromTime) : null;
              const to = snap.scannedToTime ? new Date(snap.scannedToTime) : new Date(snap.fetchedAt);
              const days = from ? ((to - from) / 86400000).toFixed(1) : null;
              const blocks = snap.scannedFromHeight && snap.scannedToHeight ? snap.scannedToHeight - snap.scannedFromHeight + 1 : null;
              const windowTip = blocks
                ? `Offer events watched between block ${snap.scannedFromHeight.toLocaleString()}${from ? ` (${from.toLocaleString()})` : ""} and block ${snap.scannedToHeight.toLocaleString()} (${to.toLocaleString()}); ${blocks.toLocaleString()} blocks. The window DISCOVERS buyers; their standing offers are then read live and can be far older than it. Only the accepted history is bounded by it.`
                : undefined;
              return (
                <div className="d-flex flex-wrap mt-8" style={{ gap: "6px 18px", alignItems: "baseline", fontSize: "0.85rem", color: "var(--text-muted)", cursor: "default" }}>
                  {days && (
                    <span title={windowTip}>
                      watched the last <strong style={numStyle}>{days}</strong> days{blocks ? ` (${blocks.toLocaleString()} blocks)` : ""}
                    </span>
                  )}
                  <span title="Accounts seen making or updating offers inside the watched window, holding at least one active Top Shot offer now">
                    found <strong style={numStyle}>{Number(snap.topshotBuyers ?? snap.buyers).toLocaleString()}</strong> buyers
                  </span>
                  <span title="Every active Top Shot offer those buyers have standing. Each buyer's whole offer book is read live, so these can be of ANY age, not just the watch window.">
                    holding <strong style={{ ...numStyle, color: "var(--status-success)" }}>{Number(snap.totalOffers).toLocaleString()}</strong> active offers, any age
                  </span>
                  {snap.acceptedStats?.topshot?.count > 0 && (
                    <span title="Top Shot offers accepted during the watch window; acceptances before it are not on record">
                      <strong style={{ ...numStyle, color: "#60a5fa" }}>{snap.acceptedStats.topshot.count.toLocaleString()}</strong> accepted in the window
                    </span>
                  )}
                  {/* Where the book came from: the published book (folded
                      every half hour) caught up in this browser to the
                      sealed block, or the bundled fallback */}
                  <span title={snap.caughtUp
                    ? `${snap.source === "bundled" ? "Bundled snapshot from the last deploy" : "Published book (refreshed every half hour)"}${snap.caughtUp.windows > 0 ? `, then ${snap.caughtUp.windows} block windows of offer events folded in this browser (+${snap.caughtUp.added} / -${snap.caughtUp.removed} offers)` : ""}; as of block ${snap.caughtUp.height.toLocaleString()}`
                    : snap.source === "bundled"
                      ? `Bundled snapshot from the last deploy (${new Date(snap.fetchedAt).toLocaleString()}); the live book was not reachable`
                      : `Published book as of block ${Number(snap.height || snap.scannedToHeight || 0).toLocaleString()}${snap.behindWindows ? "; too far behind the chain to catch up here" : ""}`}>
                    as of {new Date(snap.fetchedAt).toLocaleString()}{snap.caughtUp ? " (live)" : ""}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="glass-panel table-panel mt-20">
        {!snap || !offerFacts || !facetData ? (
          <Loader message={<>Loading the offers snapshot...</>} />
        ) : (
          <div>
            <div className="d-flex align-center gap-10 flex-wrap" style={{ paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              {tabBtn("active", "Active offers")}
              {tabBtn("accepted", `Accepted (${acceptedTotal.toLocaleString()})`)}
              {tabBtn("leaders", "Leaders")}
            </div>

            {/* The Active and Accepted tabs share the facet bar (and the
                selections); options cascade from the tab's own rows */}
            {(tab === "active" || tab === "accepted") && (() => {
              const fd = tab === "accepted" ? acceptedFacetData : facetData;
              const totalCount = tab === "accepted" ? (acceptedFacts?.length || 0) : offerFacts.length;
              const noun = tab === "accepted" ? "accepted offers" : "offer targets";
              if (!fd) return null;
              return (
                <div className="d-flex align-center flex-wrap" style={{ gap: "10px 12px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {msFacet("Collection", "coll", [...fd.opts.coll].sort().map((c) => [c, c]))}
                  {msFacet("Type", "otype", [...fd.opts.otype].sort().map((t) => [t, TYPE_LABELS[t] || t]))}
                  {msFacet("League", "league", [...fd.opts.league].sort().map((l) => [l, l]))}
                  {msFacet("Series", "series", [...fd.opts.series].sort((a, b) => a - b).map((s) => [String(s), `Series ${s}`]))}
                  {msFacet("Set", "set", [...fd.opts.set].sort((a, b) => a.localeCompare(b)).map((name) => [name, name]))}
                  {msFacet("Subedition", "sub", [...fd.opts.sub].sort((a, b) => a - b).map((s) => [String(s), subLabel(s)]))}
                  {msFacet("Tier", "tier", [...fd.opts.tier].sort((a, b) => tierRank(a) - tierRank(b)).map((t) => [t, t]))}
                  {msFacet("Play type", "type", [...fd.opts.type].sort().map((t) => [t, t]))}
                  {msFacet("Year", "year", [...fd.opts.year].sort().reverse().map((y) => [y, y]))}
                  {msFacet("Player", "player", [...fd.opts.player].sort((a, b) => a.localeCompare(b)).map((p) => [p, p]))}
                  {msFacet("Team", "team", [...fd.opts.team].sort((a, b) => a.localeCompare(b)).map((t) => [t, t]))}
                  {owned && tab === "active" && (
                    <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }} title="Only offers on what you hold at least this many copies of: the parallel the offer names, or the very moment for a serial offer">
                      Owned
                      <input
                        type="number"
                        min="1"
                        value={filters.owned}
                        onChange={(e) => setFilter("owned", e.target.value)}
                        style={{ width: "64px", padding: "3px 8px", fontSize: "0.82rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", borderRadius: "4px", fontFamily: "inherit" }}
                      />
                    </label>
                  )}
                  {anyExtraFilter && (
                    <button
                      className="btn-primary"
                      style={{ padding: "3px 10px", fontSize: "0.8rem", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", boxShadow: "none" }}
                      onClick={clearFilters}
                    >
                      ✕ Clear
                    </button>
                  )}
                  {/* Without extra filters, matched = the scoped total
                      (the Collection scope is the only active facet) */}
                  <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                    {anyExtraFilter
                      ? `${fd.matched.length.toLocaleString()} of ${totalCount.toLocaleString()} ${noun} match`
                      : `${fd.matched.length.toLocaleString()} ${noun}`}
                  </span>
                </div>
              );
            })()}

            {tab === "active" ? (
              <div>
                <div className="table-wrapper">
                  <table className="premium-table">
                    <thead>
                      <tr>
                        {showAll && sortTh("Collection", "coll")}
                        <th>Type</th>
                        <th>Edition</th>
                        <th title="A serial-level offer names one NFT; the link opens it on nbatopshot.com">NFT</th>
                        {/* The shared identity order (components/MomentIdentity) */}
                        {editionCols && sortTh(EDITION_HEADINGS[0], "set")}
                        {editionCols && sortTh(EDITION_HEADINGS[1], "player")}
                        {editionCols && <th>{EDITION_HEADINGS[2]}</th>}
                        {editionCols && <th>{EDITION_HEADINGS[3]}</th>}
                        {sortTh("Top Offer", "amount", "The highest standing offer on this target.")}
                        {sortTh("Age", "created", "Age of the top offer; '-' means it predates the watch window.")}
                        {sortTh("Offers", "count", "How many offers stand on this target.")}
                        <th>Buyer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((f) => {
                        const isOpen = expanded.has(f.rowKey);
                        // The Subedition cell belongs to the offer on that
                        // row: the parallel it targets, or Any for an
                        // edition-level offer that accepts every parallel
                        const subCell = (e) => (
                          e.sub == null
                            ? <span className="text-muted" title="An edition-level offer accepts any subedition of the play">Any</span>
                            : <Link to={`/editions/${f.setID}_${f.playID}_${e.sub}`}>{subLabel(e.sub)}</Link>);
                        const top = f.entries[0];
                        return (
                          <React.Fragment key={f.rowKey}>
                          <tr>
                            {showAll && <td>{f.coll}</td>}
                            <td>{f.kind === "serial" ? "Serial" : f.kind === "other" ? ([...f.types].map((t) => TYPE_LABELS[t] || t).join(", ")) : "Edition"}</td>
                            {f.kind === "serial" ? (
                              <>
                                {/* On-chain the offer carries only the moment
                                    id; its edition is on the target page */}
                                <td className="text-muted">-</td>
                                <td className="font-mono">
                                  <a href={`https://nbatopshot.com/moment/${f.nftID}?tab=details`} target="_blank" rel="noopener noreferrer" style={{ fontWeight: "600", whiteSpace: "nowrap" }}>
                                    NFT #{f.nftID} ↗
                                  </a>
                                </td>
                                {editionCols && <EditionCells />}
                              </>
                            ) : f.kind === "other" ? (
                              <>
                                {/* Raw targeting params: no local metadata
                                    exists for other collections */}
                                <td className="font-mono text-muted" style={{ fontSize: "0.8rem", maxWidth: "340px", overflowWrap: "anywhere" }}>{otherTarget(f.coll, f.blob)}</td>
                                <td className="text-muted">-</td>
                                {editionCols && <EditionCells />}
                              </>
                            ) : (
                              <>
                                <td className="font-mono">
                                  <Link to={`/editions/${f.setID}_${f.playID}`}>{f.setID}_{f.playID}</Link>
                                </td>
                                <td className="text-muted" title="An edition-level offer accepts any NFT of the edition">-</td>
                                <EditionCells facts={f} setID={f.setID} playID={f.playID} sub={subCell(top)} />
                              </>
                            )}
                            <td>{money(f.amount)}</td>
                            <td className="font-mono" style={{ whiteSpace: "nowrap" }}>{ageCell(f.created)}</td>
                            <td className="font-mono">
                              {f.count > 1 ? (
                                <button
                                  type="button"
                                  onClick={() => toggleExpanded(f.rowKey)}
                                  title={isOpen ? "Hide the individual offers" : "Show every offer on this target"}
                                  style={{ background: "none", border: "none", color: "var(--primary-hover)", cursor: "pointer", font: "inherit", padding: 0, whiteSpace: "nowrap" }}
                                >
                                  {f.count} {isOpen ? "▴" : "▾"}
                                </button>
                              ) : f.count}
                            </td>
                            <td className="font-mono">{buyerLink(f.buyer)}</td>
                          </tr>
                          {isOpen && f.entries.slice(1).map((e, i) => (
                            <tr key={`${f.rowKey}:${i}`} className="offer-child-row">
                              {showAll && <td />}
                              <td />
                              <td />
                              <td />
                              {editionCols && (
                                <>
                                  <td />
                                  <td />
                                  <td>{f.kind === "edition" ? subCell(e) : null}</td>
                                  <td />
                                </>
                              )}
                              <td>{money(e.amount)}</td>
                              <td className="font-mono" style={{ whiteSpace: "nowrap" }}>{ageCell(e.created)}</td>
                              <td />
                              <td className="font-mono">{buyerLink(e.buyer)}</td>
                            </tr>
                          ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
              </div>
            ) : tab === "leaders" ? (
              <div>
                {/* Scope selector: any single collection, exact from the
                    baked per-collection aggregates */}
                <div className="d-flex align-center flex-wrap" style={{ gap: "10px 12px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <label className="d-flex align-center" style={{ gap: "6px", fontSize: "0.85rem", color: "var(--text-muted)" }}>
                    Collection
                    <select
                      value={leadersScope}
                      onChange={(e) => setLeadersColl(e.target.value)}
                      style={{ padding: "3px 8px", fontSize: "0.82rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", borderRadius: "4px", cursor: "pointer" }}
                    >
                      <option value="all" style={{ background: "#1a1a1a" }}>All collections</option>
                      {leaderColls.map((c) => (
                        <option key={c} value={c} style={{ background: "#1a1a1a" }}>{c === "TopShot" ? "Top Shot" : c}</option>
                      ))}
                    </select>
                  </label>
                  {/* One scope statement for every figure on this tab */}
                  <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                    Active figures are offers standing right now, of any age; accepted figures cover the watch window only.
                  </span>
                </div>

                {/* Headline quantities: active commitments from the full
                    snapshot; accepted totals baked from the FULL history,
                    not the capped feed. Dollar figures round up to whole
                    dollars on this tab. */}
                <div className="d-flex flex-wrap gap-10" style={{ marginBottom: "18px" }}>
                  {[
                    ["Active offers", leaders.activeCount.toLocaleString(), null],
                    ["Committed", formatOfferAmount(Math.ceil(leaders.activeValue)), "Face value of every standing offer. Funds are only withdrawn at acceptance, so this is intent, not escrow."],
                    ...(leaders.accepted ? [
                      ["Accepted", leaders.accepted.count.toLocaleString(), "Offers accepted during the watch window."],
                      ["Accepted value", formatOfferAmount(Math.ceil(leaders.accepted.value)), null],
                      ["Avg sale", leaders.accepted.count > 0 ? formatOfferAmount(Math.ceil(leaders.accepted.value / leaders.accepted.count)) : "-", null]
                    ] : [])
                  ].map(([label, value, tip]) => (
                    <div key={label} title={tip || undefined} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", padding: "12px 18px", minWidth: "130px" }}>
                      <div className="text-muted" style={{ fontSize: "0.75rem", marginBottom: "4px" }}>{label}</div>
                      <div style={{ fontSize: "1.3rem", fontWeight: "700", color: "#fff" }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Boards are built to FIT side by side: smaller text and
                    shortened addresses (full address in the tooltip) */}
                <div className="d-flex flex-wrap" style={{ gap: "24px", alignItems: "flex-start" }}>
                  <div style={{ flex: "1 1 300px", minWidth: "270px" }}>
                    <h4 style={{ fontSize: "0.95rem", marginBottom: "8px" }} title="Accounts ranked by the offers they have standing right now (any age); click Offers, Committed or Top to switch the ranking">Most committed buyers (active offers)</h4>
                    <div className="table-wrapper">
                      <table className="premium-table" style={{ fontSize: "0.82rem" }}>
                        <thead><tr><th>Buyer</th>{rankTh("Offers", "count", rankActive, setRankActive)}{rankTh("Committed", "value", rankActive, setRankActive)}{rankTh("Top", "top", rankActive, setRankActive)}</tr></thead>
                        <tbody>
                          {(rankActive === "count"
                            ? [...leaders.buyersBoard].sort((a, b) => (b.count - a.count) || (b.value - a.value))
                            : rankActive === "top"
                              ? [...leaders.buyersBoard].sort((a, b) => (b.top - a.top) || (b.value - a.value))
                              : leaders.buyersBoard
                          ).slice(0, 50).map((b) => (
                            <tr key={b.addr}>
                              <td>{boardBuyer(b.addr)}</td>
                              <td className="font-mono">{b.count.toLocaleString()}</td>
                              <td>{money(Math.ceil(b.value))}</td>
                              <td>{money(Math.ceil(b.top))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {leaders.accepted && (
                    <div style={{ flex: "1 1 250px", minWidth: "230px" }}>
                      <h4 style={{ fontSize: "0.95rem", marginBottom: "8px" }} title="Accounts whose offers were accepted the most (what they bought via offers), in the watch window; click Bought or Spent to switch the ranking">Top buyers (accepted)</h4>
                      <div className="table-wrapper">
                        <table className="premium-table" style={{ fontSize: "0.82rem" }}>
                          <thead><tr><th>Buyer</th>{rankTh("Bought", "count", rankBuyers, setRankBuyers)}{rankTh("Spent", "value", rankBuyers, setRankBuyers)}</tr></thead>
                          <tbody>
                            {(rankBuyers === "count"
                              ? (leaders.accepted.buyersByCount || byCount(leaders.accepted.buyers))
                              : leaders.accepted.buyers
                            ).slice(0, 50).map(([addr, count, value]) => (
                              <tr key={addr}>
                                <td>{boardBuyer(addr)}</td>
                                <td className="font-mono">{count.toLocaleString()}</td>
                                <td>{money(Math.ceil(value))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {leaders.accepted && (
                    <div style={{ flex: "1 1 250px", minWidth: "230px" }}>
                      <h4 style={{ fontSize: "0.95rem", marginBottom: "8px" }} title="Accounts that accepted the most offers (what they sold via offers), in the watch window; click Sold or Earned to switch the ranking">Top sellers (accepted)</h4>
                      <div className="table-wrapper">
                        <table className="premium-table" style={{ fontSize: "0.82rem" }}>
                          <thead><tr><th>Seller</th>{rankTh("Sold", "count", rankSellers, setRankSellers)}{rankTh("Earned", "value", rankSellers, setRankSellers)}</tr></thead>
                          <tbody>
                            {(rankSellers === "count"
                              ? (leaders.accepted.sellersByCount || byCount(leaders.accepted.sellers))
                              : leaders.accepted.sellers
                            ).slice(0, 50).map(([addr, count, value]) => (
                              <tr key={addr}>
                                <td>{boardSeller(addr)}</td>
                                <td className="font-mono">{count.toLocaleString()}</td>
                                <td>{money(Math.ceil(value))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
                {!leaders.accepted && (
                  <p className="text-muted mt-20" style={{ fontSize: "0.85rem" }}>
                    Accepted-offer aggregates appear after the next <span className="font-mono">npm run offers</span> (older snapshot format).
                  </p>
                )}
              </div>
            ) : (
              <div>
                {(acceptedRows || []).length < acceptedTotal && (
                  <p className="text-muted" style={{ fontSize: "0.8rem", marginBottom: "10px" }}>
                    Newest {(acceptedRows || []).length.toLocaleString()} of {acceptedTotal.toLocaleString()} accepted offers
                    (the snapshot feed keeps the most recent 5,000 across all collections; totals and the Leaders boards cover everything).
                  </p>
                )}
                <div className="table-wrapper">
                  <table className="premium-table">
                    <thead>
                      <tr>
                        {accTh("When", "when")}
                        {showAll && accTh("Collection", "coll")}
                        {accTh("Edition", "edition")}
                        <th>NFT</th>
                        {acceptedEditionCols && (
                          <>
                            {accTh(EDITION_HEADINGS[0], "set")}
                            {accTh(EDITION_HEADINGS[1], "player")}
                            {accTh(EDITION_HEADINGS[2], "sub")}
                            <th>{EDITION_HEADINGS[3]}</th>
                          </>
                        )}
                        {accTh("Price", "amount")}
                        {accTh("Buyer", "buyer")}
                        {accTh("Seller", "seller")}
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((af, i) => {
                        const [ts, coll, amount, buyer, seller, level, setId, playId, subId, soldNftId, blob] = af.row;
                        return (
                          <tr key={`${ts}:${i}`}>
                            <td className="font-mono" style={{ whiteSpace: "nowrap" }}>{ageCell(ts)}</td>
                            {showAll && <td>{coll}</td>}
                            {acceptedCells(coll, level, setId, playId, subId, soldNftId, blob, af.cellFacts)}
                            <td>{money(amount)}</td>
                            <td className="font-mono">{buyerLink(buyer)}</td>
                            <td className="font-mono">{seller ? <Link to={`/account/${seller}`}>{seller}</Link> : dashCell}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {pageRows.length === 0 && (
                  <p className="text-muted text-center" style={{ padding: "30px" }}>No accepted offers on record yet; the history fills as scans run.</p>
                )}
                <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />

                {(snap.purchasedInBooks || []).length > 0 && (
                  <div className="mt-20" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "14px" }}>
                    <h4 style={{ fontSize: "0.95rem" }} title="Offers whose purchased flag is set but whose resource still sits in the buyer's book, awaiting cleanup">
                      Purchased offers still in buyers' books ({snap.purchasedInBooks.length})
                    </h4>
                    <div className="table-wrapper mt-8">
                      <table className="premium-table">
                        <thead>
                          <tr>
                            {showAll && <th>Collection</th>}
                            <th>Edition</th>
                            <th>NFT</th>
                            {acceptedEditionCols && EDITION_HEADINGS.map((h) => <th key={h}>{h}</th>)}
                            <th>Price</th>
                            <th>Buyer</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snap.purchasedInBooks.slice(0, 100).map(([coll, amount, buyer, offerId, level, setId, playId, subId, nftId, blob], i) => (
                            <tr key={`${offerId}:${i}`}>
                              {showAll && <td>{coll}</td>}
                              {acceptedCells(coll, level, setId, playId, subId, nftId, blob)}
                              <td>{money(amount)}</td>
                              <td className="font-mono">{buyerLink(buyer)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
