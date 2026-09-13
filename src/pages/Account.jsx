import { isSigned } from "../services/autograph.service";
import { useUsernames, introOf } from "../services/usernames.service";
import { approxCreatedAt, formatMonth, accountClockAsOf } from "../services/flow.address";
import { sizePercentile, holdersCounted, collectionSizesAsOf } from "../services/census.stats";
import { foldedEntryOf } from "../services/wall.service";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getAccountDetails, getAccountMoments, getSaleData, subeditionLabel, getAccountGraph, getEvmCollectionIDsAll } from "../services/fcl.service";
import { Pagination } from "../components/Pagination";
import { getAccountCollectionDB, getAllPlaysDB, getAllSetsDB, getAllEditionsDB, getAllIPFSDB } from "../services/db.service";
import { CubeOverlay } from "../components/CubeOverlay";
import { CubeTrigger } from "../components/MomentCube";
import { buildCubeConfig, cubeFaceFor, cubeThumbFor, resolveCubeFace } from "../services/cube.service";
import { useIpfsMedia } from "../hooks/useIpfsMedia";
import { serialKinds, playSerialFacts, runSizeFor, SPECIAL_LABELS } from "../utils/serials.utils";
import { MultiSelect } from "../components/MultiSelect";
import { normalizeAddress, syncCollectionTuples, subscribeAccountReload, rememberAddress, evmAddressesOf, isEvmAddress } from "../services/account.context";
import { lockStateOf, clearLockCache, loadAccountLocks } from "../services/account.locks";

const EMPTY_LOCKS = new Map();
import { writeFilters, useFacetFilters, useSortState, readSort, cascadeOf } from "../hooks/useFacetFilters";
import { useLoad } from "../hooks/useLoad";
import { SortableTh } from "../components/SortableTh";
import { applyPlayOverrides, getCalculatedPlayTags, buildTsdIndex, buildMintClock, editionTags, compareBadges } from "../services/overrides.service";

// A moment's badges: the play's tags plus the edition's own (a reward
// edition carries Dapper's reward badge; the same play elsewhere does
// not), and the Autograph only on a signed parallel
const momentTags = (pf, setID, playID, sub) => {
  const extra = editionTags(setID, playID);
  const base = (pf && pf.tags) || new Set();
  const tags = extra.length === 0 ? base : new Set([...base, ...extra]);
  if (!tags.has("Autograph") || isSigned(setID, playID, sub)) return tags;
  const narrowed = new Set(tags);
  narrowed.delete("Autograph");
  return narrowed;
};
import { playSummary, lockCell, getLeagueName, tierFacetRank as tierRank, playerPath, formatUsd } from "../utils/display.utils";
import { Badges } from "../components/Badges";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { getEditionTier } from "../services/set.status";
import { isMismintPlay } from "../services/overrides.service";
import { toQuery } from "../utils/query";

// Fetches the light data-only tuples [momentID, setID, playID, serial,
// subeditionID] for an account's WHOLE collection (sharing the account
// context's IndexedDB cache; moments are immutable so cached rows never
// go stale and only new IDs hit the chain, merged back for the context to
// reuse), folds in marketplace listings (V3 listings stay inside the
// MomentCollection; V1 listings are escrowed OUT of it, so their tuples
// come from the sale collection and their ids join the list), and returns
// everything sorted in the page's global default order: highest play,
// then highest subedition, then lowest set, then lowest moment id.
async function buildCollectionIndex(address, summary, onProgress, evmList = []) {
  const cadenceIDs = summary.momentIDs.map(Number);
  const evmIDs = new Set(evmList);
  const ids = [...cadenceIDs, ...evmList.filter((id) => !cadenceIDs.includes(id))];
  let cached = null;
  try { cached = await getAccountCollectionDB(normalizeAddress(address)); } catch { /* no cache */ }
  // Shared with the account context (services/account.context.js), which
  // reads and writes the same store record; saveAlways false keeps this
  // page's visits from resetting the context's refresh window
  const { moments: tuples } = await syncCollectionTuples(address, ids, {
    evmIDs,
    cachedMoments: cached?.moments,
    onProgress,
    saveAlways: false
  });

  const idSet = new Set(ids);
  const saleIds = (summary.saleMomentIDs || []).map(Number);
  const escrowed = saleIds.filter((id) => !idSet.has(id));
  for (let i = 0; i < escrowed.length; i += 2000) {
    tuples.push(...await getSaleData(address, escrowed.slice(i, i + 2000), false));
  }

  const byID = new Map(tuples.map((m) => [Number(m[0]), m]));
  const sortedIDs = [...ids, ...escrowed].sort((a, b) => {
    const ma = byID.get(a), mb = byID.get(b);
    // Unborrowable moments (no tuple) sink to the end in id order
    if (!ma || !mb) return ma ? -1 : mb ? 1 : a - b;
    return (mb[2] - ma[2]) || (mb[4] - ma[4]) || (ma[1] - mb[1]) || (a - b);
  });
  return { tuples, sortedIDs, saleIds };
}


// Facet filters live in the URL query string so a filtered view is
// shareable and survives refresh; multi facets are comma-joined values.
// The read/write/cascade machinery is shared (hooks/useFacetFilters).
const EMPTY_FILTERS = { league: [], series: [], set: [], sub: [], tier: [], type: [], year: [], player: [], team: [], badge: [], special: [], listed: "", locking: "", held: "", owned: "", serial: "" };
const MULTI_FILTER_KEYS = ["league", "series", "set", "sub", "tier", "type", "year", "player", "team", "badge", "special"];
const SINGLE_FILTER_KEYS = ["listed", "locking", "held", "owned", "serial"];

// Column sort. Each key's first click uses its natural direction, a
// second click flips it, a third returns to the default order (newest
// first). The active sort rides in the URL with the filters.
const SORT_DEFAULT_DIR = { edition: "asc", set: "asc", play: "asc", sub: "asc", player: "asc", serial: "asc", badges: "desc", qty: "desc", locked: "desc" };
const DEFAULT_SORT = { key: "", dir: "desc" };

function writeFiltersToLocation(filters, groupByEdition, sort) {
  const params = new URLSearchParams();
  if (groupByEdition) params.set("group", "1");
  writeFilters(params, filters, EMPTY_FILTERS);
  if (sort.key) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  const qs = toQuery(params);
  // replaceState keeps this out of the history stack (Back leaves the
  // page, not the filters) and never triggers a router re-render
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

// Run raw on-chain play metadata through the same overrides/normalization
// pipeline every other page uses, so corrections apply here too
const compileMomentMetadata = (details) =>
  details.map((m) => ({
    ...m,
    playMetadata: applyPlayOverrides({ playID: m.playID, ...m.playMetadata })
  }));

// The edition key every per-edition map in this page shares
const editionKeyOf = (setID, playID, sub) => `${setID}_${playID}_${sub}`;

// Every facet the cascade knows; derived so a new filter key cannot be
// added to one list and forgotten in the other
const FACET_KEYS = [...MULTI_FILTER_KEYS, ...SINGLE_FILTER_KEYS];

// Edition tier depends only on the static additions files, so the cache is
// module-level and permanent: a 61k-moment collection asks ~1k distinct
// editions, not 61k
const tierCache = new Map();
const tierOf = (setID, playID) => {
  const key = `${Number(setID)}_${Number(playID)}`;
  if (!tierCache.has(key)) tierCache.set(key, getEditionTier(setID, playID));
  return tierCache.get(key);
};

export function Account() {
  useUsernames();
  const { address } = useParams();
  const earlyAdopter = foldedEntryOf(address);
  
  const [allMomentIDs, setAllMomentIDs] = useState([]);
  const totalMomentsCount = allMomentIDs.length;

  const [moments, setMoments] = useState([]);
  const [keyProgress, setKeyProgress] = useState(null); // % while fetching sort keys
  // Full-collection tuples [momentID, setID, playID, serial, sub], kept
  // from the sort-key fetch; they are all the grouped view needs
  const [collectionTuples, setCollectionTuples] = useState(null);
  const [saleSet, setSaleSet] = useState(() => new Set()); // momentIDs listed for sale
  const [lockMapState, setLockMap] = useState(null); // momentID -> lock expiry (locked moments only)
  const [graph, setGraph] = useState(null); // wallet kind, linked accounts, EVM account
  const [evmSet, setEvmSet] = useState(() => new Set()); // momentIDs held on Flow EVM
  const [groupByEdition, setGroupByEdition] = useState(() => new URLSearchParams(window.location.search).get("group") === "1");
  // The 3D cube beside each edition id: media CIDs per edition from the
  // local database (one read, cached), the media lookup for what fronts
  // the cube, and the overlay showing the open one
  const [ipfsByEdition, setIpfsByEdition] = useState(null);
  const ipfsMedia = useIpfsMedia();
  const [cubeOverlay, setCubeOverlay] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getAllIPFSDB()
      .then((records) => { if (!cancelled) setIpfsByEdition(new Map(records.map((r) => [`${Number(r.setID)}_${Number(r.playID)}`, r]))); })
      .catch((err) => console.warn("ipfs records unavailable for cubes:", err));
    return () => { cancelled = true; };
  }, []);
  const cubeCell = (setID, playID, play, series, title) => {
    const rec = ipfsByEdition ? ipfsByEdition.get(`${Number(setID)}_${Number(playID)}`) : null;
    const cids = rec ? rec.cids : null;
    const face = play && cids ? cubeFaceFor({ cids, ipfsMedia, series }) : null;
    if (!face) return <td className="cube-cell" />;
    return (
      <td className="cube-cell">
        <CubeTrigger
          thumb={cubeThumbFor(cids, ipfsMedia)}
          title={face.title}
          onOpen={async () => {
            const resolved = await resolveCubeFace(face);
            if (!resolved) return;
            setCubeOverlay({ title, config: buildCubeConfig(play, getEditionTier(setID, playID), resolved) });
          }}
        />
      </td>
    );
  };
  // Edition keys whose full serial list is expanded in the grouped view
  const [expandedSerials, setExpandedSerials] = useState(() => new Set());
  const toggleSerials = (key) => setExpandedSerials((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const [localMeta, setLocalMeta] = useState(null); // { plays: Map, playsArr, sets: Map } for grouping and filters

  // Pagination state (declared before the filters: changing either
  // filters or sort resets to page 1)
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  // The setter is listed in the dependency arrays that call it: the React
  // Compiler does not infer this one as stable (it is handed around as a
  // value too) and refuses to compile the component when the manual
  // arrays disagree with its own inference (eslint preserve-manual-
  // memoization). A setter never changes, so the entry costs nothing.
  const resetPage = useCallback(() => setCurrentPage(1), [setCurrentPage]);

  // Facet filters. Multi-value facets hold arrays of STRING values ([] =
  // no constraint); listed/owned are single values. Options are built
  // from what the account actually owns, CASCADED: each facet only
  // offers values still reachable under every OTHER active filter.
  const { filters, setFilter, clearFilters, anyFilter } = useFacetFilters(EMPTY_FILTERS, { onChange: resetPage });

  const { sort, sortBy } = useSortState(readSort(DEFAULT_SORT, { validKeys: SORT_DEFAULT_DIR }), { naturalDirs: SORT_DEFAULT_DIR, onChange: resetPage });
  const sortTh = (label, key) => (
    <SortableTh
      label={label}
      sortKey={key}
      sort={sort}
      onSort={sortBy}
      title={`Sort by ${label.toLowerCase()}; a third click restores the default order (newest first)`}
    />
  );

  // Keep the URL in step with the filters, the sort, and the view toggle
  useEffect(() => {
    writeFiltersToLocation(filters, groupByEdition, sort);
  }, [filters, groupByEdition, sort]);

  const [loading, setLoading] = useState(true);
  const [momentsLoading, setMomentsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Search by ID state
  const [searchID, setSearchID] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  // Format Address Helper
  const formattedAddress = useMemo(() => {
    if (!address) return "";
    return address.startsWith("0x") ? address : "0x" + address;
  }, [address]);

  // Load account's high-level moment list, then sort it GLOBALLY before
  // any paging: the default order (highest play, then highest subedition,
  // then lowest set, then lowest moment id) needs the edition facts for
  // every moment, not just the visible page. Those come as light
  // data-only tuples [momentID, setID, playID, serial, subeditionID],
  // sharing the account context's IndexedDB cache (moments are immutable,
  // so cached rows never go stale; only new IDs hit the chain, and the
  // merged result is saved back for the context to reuse).
  const forceLockRefresh = useRef(false);
  const loadAccountSummary = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      // An EVM address on its own: no Cadence account, no graph; what the
      // bridge's ERC721 says it holds is the whole collection
      const evm = isEvmAddress(address);
      const summary = evm ? { momentIDs: [], saleMomentIDs: [] } : await getAccountDetails(address);
      const g = evm ? null : await getAccountGraph(address).catch((e) => { console.warn("account graph unavailable:", e); return null; });
      setGraph(g);
      const evmList = await getEvmCollectionIDsAll(evm ? [address] : evmAddressesOf(g)).catch((e) => { console.warn("EVM collection unavailable:", e); return []; });
      setEvmSet(new Set(evmList));
      // The strict check matters: the button's click event lands here too
      if (forceRefresh === true) {
        // Reload refetches lock states; a plain page load reuses the cache
        forceLockRefresh.current = true;
        clearLockCache(address);
        setLockMap(null);
      }
      const { tuples, sortedIDs, saleIds } = await buildCollectionIndex(address, summary, setKeyProgress, evmList);
      setSaleSet(new Set(saleIds));
      setAllMomentIDs(sortedIDs);
      setCollectionTuples(tuples);
      setCurrentPage(1); // reset to page 1
    } catch (err) {
      console.error("Error fetching account summary:", err);
      setError(`Failed to retrieve account details for ${formattedAddress}. Ensure the address is valid and has a TopShot collection initialized.`);
    } finally {
      setLoading(false);
      setKeyProgress(null);
    }
  }, [address, formattedAddress, setCurrentPage]);

  useLoad(loadAccountSummary, [address]);

  // Opening a collection page counts as a lookup (parent/child links
  // included), so the nav's history offers it later
  useEffect(() => { rememberAddress(address); }, [address]);

  // Load detailed moment metadata for current page
  const loadPageMoments = useCallback(async (page, idsList) => {
    if (idsList.length === 0) {
      setMoments([]);
      return;
    }
    
    setMomentsLoading(true);
    try {
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const pageIDs = idsList.slice(startIndex, endIndex);
      
      const details = await getAccountMoments(address, pageIDs);
      setMoments(compileMomentMetadata(details));
    } catch (err) {
      console.error("Failed to load moments metadata:", err);
    } finally {
      setMomentsLoading(false);
    }
  }, [address, pageSize]);

  // The grouped view and the facet filters need names and play metadata
  // for every edition in the collection, so they read the local database
  // (seed/sync) instead of the chain
  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllPlaysDB(), getAllSetsDB(), getAllEditionsDB()])
      .then(([plays, sets, editions]) => {
        if (cancelled) return;
        setLocalMeta({
          plays: new Map(plays.map((p) => [Number(p.playID), p])),
          playsArr: plays,
          sets: new Map(sets.map((s) => [Number(s.id), s])),
          editionCounts: new Map(editions.map((e) => [e.id, Number(e.momentCount) || 0]))
        });
      })
      .catch((err) => {
        console.warn("local metadata unavailable for grouping/filters:", err);
        if (!cancelled) setLocalMeta({ plays: new Map(), playsArr: [], sets: new Map(), editionCounts: new Map() });
      });
    return () => { cancelled = true; };
  }, []);

  // An EVM address holds its moments through the bridge escrow, which
  // cannot lock, and an empty collection has nothing to look up: both
  // read as an empty map right away so the Locking select never sits on
  // "Loading...".
  const lockMap = lockMapState || (isEvmAddress(address) || (!loading && allMomentIDs.length === 0) ? EMPTY_LOCKS : null);

  // Lock states for the whole collection load in the background once the
  // id list is known; the Locking filter appears when they arrive
  useEffect(() => {
    if (!address || allMomentIDs.length === 0 || isEvmAddress(address)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const map = await loadAccountLocks(address, allMomentIDs, { force: forceLockRefresh.current, shouldAbort: () => cancelled });
        forceLockRefresh.current = false;
        if (map && !cancelled) setLockMap(map);
      } catch (err) {
        console.warn("lock data unavailable:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [address, allMomentIDs]);

  // The account menu's Reload refetches this page's view too
  useEffect(() => subscribeAccountReload(() => loadAccountSummary(true)), [loadAccountSummary]);

  // Per owned play: overridden metadata distilled to the filterable facts
  // (category, year, calculated badges like TSD / Rookie Year)
  const playFacts = useMemo(() => {
    if (!collectionTuples || !localMeta) return null;
    const tsdIndex = buildTsdIndex(localMeta.playsArr);
    const mintClock = buildMintClock(localMeta.playsArr);
    const out = new Map();
    new Set(collectionTuples.map((m) => Number(m[2]))).forEach((playID) => {
      const rec = localMeta.plays.get(playID);
      if (!rec) { out.set(playID, { category: "", year: "", date: "", tags: new Set(), player: "", team: "", league: "" }); return; }
      const play = applyPlayOverrides({ playID, ...rec });
      const team = (play.TeamAtMoment || "").trim();
      out.set(playID, {
        category: (play.PlayCategory || play.PlayType || "").trim(),
        year: play.DateOfMoment ? String(play.DateOfMoment).slice(0, 4) : "",
        // Sort key for the Play column (its text leads with this date)
        date: play.DateOfMoment ? String(play.DateOfMoment).slice(0, 10) : "",
        tags: new Set(getCalculatedPlayTags(play, null, tsdIndex, mintClock)),
        player: (play.FullName || "").trim(),
        team,
        league: team ? getLeagueName(team) : "",
        // Numeric facts a "special serial" can coincide with
        ...playSerialFacts(play)
      });
    });
    return out;
  }, [collectionTuples, localMeta]);

  // Census approximations for the header chips (services/flow.address,
  // services/census.stats): creation month from the address, size rank
  // among holders, and the mint month of the newest moment held (its
  // play's place on the mint clock)
  const createdAt = useMemo(() => approxCreatedAt(formattedAddress), [formattedAddress]);
  const sizeRank = useMemo(() => {
    const p = sizePercentile(totalMomentsCount);
    if (!p) return null;
    if (p >= 99) return "Top 1% of collections";
    if (p >= 95) return "Top 5% of collections";
    if (p >= 90) return "Top 10% of collections";
    return `Larger than ${p}% of collections`;
  }, [totalMomentsCount]);
  const lastMint = useMemo(() => {
    if (!collectionTuples || collectionTuples.length === 0 || !localMeta) return null;
    let top = null;
    collectionTuples.forEach((m) => { if (!top || Number(m[0]) > Number(top[0])) top = m; });
    const clock = buildMintClock(localMeta.playsArr);
    const d = clock.get(Number(top[2]));
    return d ? new Date(`${d}T00:00:00Z`) : null;
  }, [collectionTuples, localMeta]);

  // Owned and listed counts per edition, in ONE pass over the tuples
  // (they were two separate full passes building the same keys)
  const perEdition = useMemo(() => {
    if (!collectionTuples) return null;
    const qty = new Map();
    const listed = new Map();
    collectionTuples.forEach(([momentID, setID, playID, , sub]) => {
      const key = editionKeyOf(setID, playID, sub);
      qty.set(key, (qty.get(key) || 0) + 1);
      if (saleSet.has(Number(momentID))) listed.set(key, (listed.get(key) || 0) + 1);
    });
    return { qty, listed };
  }, [collectionTuples, saleSet]);

  // Lock states present per edition, for the Locking filter in grouped view
  const lockStatesByEdition = useMemo(() => {
    if (!collectionTuples || !lockMap) return null;
    const out = new Map();
    collectionTuples.forEach(([momentID, setID, playID, , sub]) => {
      const key = editionKeyOf(setID, playID, sub);
      let states = out.get(key);
      if (!states) out.set(key, (states = new Set()));
      states.add(lockStateOf(lockMap.get(Number(momentID))));
    });
    return out;
  }, [collectionTuples, lockMap]);

  // Mint-run size per owned edition; serialKinds/runSizeFor are shared
  // with the set page's ownership summary (utils/serials.utils.js).
  // Precomputed over the ~1k distinct editions: runSizeFor was called once
  // per MOMENT (a reduce over the parallels config each time) in a 61k
  // collection.
  const runSizes = useMemo(() => {
    if (!perEdition || !localMeta) return null;
    const out = new Map();
    perEdition.qty.forEach((_, key) => {
      const [setID, playID, sub] = key.split("_").map(Number);
      out.set(key, runSizeFor(setID, sub, localMeta.editionCounts.get(`${setID}_${playID}`)));
    });
    return out;
  }, [perEdition, localMeta]);
  const runSizeOf = useCallback((setID, playID, sub) => (
    runSizes
      ? runSizes.get(editionKeyOf(Number(setID), Number(playID), Number(sub)))
      : runSizeFor(setID, sub, localMeta?.editionCounts?.get(`${Number(setID)}_${Number(playID)}`))
  ), [runSizes, localMeta]);

  // "99-250", "99-", "-250" or a single number; empty/invalid = no constraint
  const parsedSerialRange = useMemo(() => {
    const t = String(filters.serial).trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) { const n = Number(t); return { min: n, max: n }; }
    const m = t.match(/^(\d*)\s*-\s*(\d*)$/);
    if (!m || (!m[1] && !m[2])) return null;
    return { min: m[1] ? Number(m[1]) : 1, max: m[2] ? Number(m[2]) : Infinity };
  }, [filters.serial]);

  // Per-facet pass tests against the CURRENT filters (string-coerced
  // values; empty selection = no constraint). Memoized on the filters so
  // the memos below can list it as an honest dependency.
  const passFns = useMemo(() => ({
    league: (v) => filters.league.length === 0 || (Boolean(v) && filters.league.includes(v)),
    player: (v) => filters.player.length === 0 || (Boolean(v) && filters.player.includes(v)),
    team: (v) => filters.team.length === 0 || (Boolean(v) && filters.team.includes(v)),
    series: (v) => filters.series.length === 0 || (v != null && filters.series.includes(String(v))),
    set: (v) => filters.set.length === 0 || filters.set.includes(String(v)),
    sub: (v) => filters.sub.length === 0 || filters.sub.includes(String(v)),
    tier: (v) => filters.tier.length === 0 || (Boolean(v) && filters.tier.includes(v)),
    type: (v) => filters.type.length === 0 || (Boolean(v) && filters.type.includes(v)),
    year: (v) => filters.year.length === 0 || (Boolean(v) && filters.year.includes(v)),
    badge: (tags) => filters.badge.length === 0 || filters.badge.some((b) => tags && tags.has(b)),
    owned: (qty) => !filters.owned || qty >= Number(filters.owned),
    special: (kinds) => filters.special.length === 0 || filters.special.some((k) => kinds.includes(k)),
    serial: (serial) => !parsedSerialRange || (serial >= parsedSerialRange.min && serial <= parsedSerialRange.max),
    locking: (state) => !filters.locking || state === filters.locking,
    listedMoment: (listed) => !filters.listed || ((filters.listed === "yes") === listed),
    listedEdition: (count) => !filters.listed || (filters.listed === "yes" ? count > 0 : count === 0),
    // Where the moment is held: on Flow EVM (its Cadence NFT in the bridge
    // escrow) or in the Cadence collection. An edition passes when any of
    // its copies does.
    heldMoment: (onEvm) => !filters.held || ((filters.held === "evm") === onEvm),
    heldEdition: (evmCount, total) => !filters.held || (filters.held === "evm" ? evmCount > 0 : evmCount < total)
  }), [filters, parsedSerialRange]);

  // Serial-LEVEL filters (specials, serial range) need per-serial checks
  // in the grouped view; resolved once, not per rendered row
  const serialFiltersActive = filters.special.length > 0 || Boolean(parsedSerialRange);

  // One fact record per owned moment, feeding both the option cascade and
  // the actual filtering. Deliberately does NOT read lockMap: the lock
  // data lands seconds after the list, and folding it in here rebuilt all
  // ~61k records for one field; the cascade reads lockMap directly.
  const momentFacts = useMemo(() => {
    if (!collectionTuples || !localMeta || !playFacts || !perEdition) return null;
    return collectionTuples.map(([momentID, setID, playID, serial, sub, evm]) => {
      const sRec = localMeta.sets.get(Number(setID));
      const pf = playFacts.get(Number(playID)) || {};
      const serialNum = Number(serial);
      const series = sRec?.series != null ? Number(sRec.series) : null;
      return {
        momentID: Number(momentID),
        setID: Number(setID),
        playID: Number(playID),
        setName: sRec?.setName || `Set #${setID}`,
        series,
        sub: Number(sub),
        evm: evm === 1,
        tier: tierOf(setID, playID),
        type: pf.category || "",
        year: pf.year || "",
        date: pf.date || "",
        league: pf.league || "",
        player: pf.player || "",
        team: pf.team || "",
        tags: momentTags(pf, setID, playID, sub),
        listed: saleSet.has(Number(momentID)),
        qty: perEdition.qty.get(editionKeyOf(setID, playID, sub)) || 0,
        serial: serialNum,
        kinds: serialKinds(serialNum, pf, runSizeOf(setID, playID, sub), series)
      };
    });
  }, [collectionTuples, localMeta, playFacts, perEdition, saleSet, runSizeOf]);

  // Options per facet plus the set of moments matching every filter. The
  // cascade rule: a facet offers a value when some moment carries it and
  // fails no OTHER facet, so picking Series 1 narrows Sets to series-1
  // sets while Series itself keeps offering the alternatives.
  const facetData = useMemo(() => {
    if (!momentFacts) return null;
    const opts = { league: new Set(), series: new Set(), set: new Map(), sub: new Set(), tier: new Set(), type: new Set(), year: new Set(), player: new Set(), team: new Set(), badge: new Set(), special: new Set() };
    const matchIDs = new Set();
    momentFacts.forEach((f) => {
      const pass = {
        league: passFns.league(f.league),
        series: passFns.series(f.series),
        set: passFns.set(f.setID),
        sub: passFns.sub(f.sub),
        tier: passFns.tier(f.tier),
        type: passFns.type(f.type),
        year: passFns.year(f.year),
        player: passFns.player(f.player),
        team: passFns.team(f.team),
        badge: passFns.badge(f.tags),
        special: passFns.special(f.kinds),
        listed: passFns.listedMoment(f.listed),
        held: passFns.heldMoment(f.evm),
        // Lock state resolves here (not on the fact record) so the lock
        // data landing does not rebuild momentFacts
        locking: passFns.locking(lockStateOf(lockMap ? lockMap.get(f.momentID) : null)),
        owned: passFns.owned(f.qty),
        serial: passFns.serial(f.serial)
      };
      const { matched, offer } = cascadeOf(pass, FACET_KEYS);
      if (matched) matchIDs.add(f.momentID);
      if (offer("league") && f.league) opts.league.add(f.league);
      if (offer("player") && f.player) opts.player.add(f.player);
      if (offer("team") && f.team) opts.team.add(f.team);
      if (offer("series") && f.series != null) opts.series.add(f.series);
      if (offer("set")) opts.set.set(f.setID, f.setName);
      if (offer("sub")) opts.sub.add(f.sub);
      if (offer("tier") && f.tier) opts.tier.add(f.tier);
      if (offer("type") && f.type) opts.type.add(f.type);
      if (offer("year") && f.year) opts.year.add(f.year);
      if (offer("badge")) f.tags.forEach((t) => opts.badge.add(t));
      if (offer("special")) f.kinds.forEach((k) => opts.special.add(k));
    });
    return { opts, matchIDs };
  }, [momentFacts, passFns, lockMap]);

  // The flat view pages over the filtered id list (still globally sorted)
  const filteredIDs = useMemo(() => {
    if (!anyFilter || !facetData) return allMomentIDs;
    return allMomentIDs.filter((id) => facetData.matchIDs.has(id));
  }, [allMomentIDs, anyFilter, facetData]);

  // Column sort for the flat view, applied to the WHOLE filtered id list
  // before paging. The moment facts already hold every sort key locally,
  // so reordering never touches the chain. Serials compare numerically
  // (the rendered "#" prefix is cosmetic); Edition ID compares its three
  // groups (set, play, subedition) in turn.
  const factByID = useMemo(() => (momentFacts ? new Map(momentFacts.map((f) => [f.momentID, f])) : null), [momentFacts]);
  const sortedFilteredIDs = useMemo(() => {
    if (!sort.key || !factByID) return filteredIDs;
    const subName = subeditionLabel;
    const val = (f) => {
      switch (sort.key) {
        case "set": return f.setName;
        case "play": return f.date;
        case "sub": return subName(f.sub);
        case "player": return f.player;
        case "serial": return f.serial;
        case "badges": return f.tags.size;
        case "locked": return lockMap ? (lockMap.get(f.momentID) || 0) : 0;
        default: return 0;
      }
    };
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filteredIDs].sort((a, b) => {
      const fa = factByID.get(a);
      const fb = factByID.get(b);
      if (!fa || !fb) return fa ? -1 : fb ? 1 : a - b;
      let cmp;
      if (sort.key === "edition") {
        cmp = (fa.setID - fb.setID) || (fa.playID - fb.playID) || (fa.sub - fb.sub);
      } else {
        const va = val(fa);
        const vb = val(fb);
        cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      }
      return (cmp * dir) || (fa.serial - fb.serial) || (a - b);
    });
  }, [filteredIDs, factByID, sort, lockMap]);

  // One row per edition (set_play_subedition) with quantity and serials,
  // in the same global order as the flat view
  const groupedRows = useMemo(() => {
    if (!groupByEdition || !collectionTuples) return null;
    const groups = new Map();
    collectionTuples.forEach(([momentID, setID, playID, serial, sub]) => {
      const key = `${setID}_${playID}_${sub}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, setID, playID, sub, serials: [], momentBySerial: new Map() }));
      const s = Number(serial);
      g.serials.push(s);
      g.momentBySerial.set(s, Number(momentID));
    });
    const rows = [...groups.values()];
    rows.forEach((g) => g.serials.sort((a, b) => a - b));
    rows.sort((a, b) => (b.playID - a.playID) || (b.sub - a.sub) || (a.setID - b.setID));
    return rows;
  }, [groupByEdition, collectionTuples]);

  // Everything the grouped view's filter, sort AND render need per row,
  // derived ONCE per row instead of once per pass (the three used to each
  // re-derive set record, series, play facts, tier and the compiled play)
  const groupFacts = useMemo(() => {
    if (!groupedRows || !localMeta || !playFacts) return null;
    const out = new Map();
    groupedRows.forEach((g) => {
      const setRec = localMeta.sets.get(g.setID);
      const playRec = localMeta.plays.get(g.playID);
      out.set(g.key, {
        setRec,
        setName: setRec?.setName || `Set #${g.setID}`,
        series: setRec?.series != null ? Number(setRec.series) : null,
        pf: playFacts.get(g.playID) || {},
        tags: momentTags(playFacts.get(g.playID), g.setID, g.playID, g.sub),
        tier: tierOf(g.setID, g.playID),
        play: playRec ? applyPlayOverrides({ playID: g.playID, ...playRec }) : null
      });
    });
    return out;
  }, [groupedRows, localMeta, playFacts]);

  // Grouped rows filter on edition-level values; "listed" means the
  // edition has at least one listed copy
  const filteredGroupedRows = useMemo(() => {
    if (!groupedRows) return null;
    if (!anyFilter || !groupFacts) return groupedRows;
    return groupedRows.filter((g) => {
      const gf = groupFacts.get(g.key);
      const pf = gf.pf;
      // Serial-level filters: the edition passes when ANY owned serial
      // satisfies both the range and the special-serial selection
      const runSize = serialFiltersActive ? runSizeOf(g.setID, g.playID, g.sub) : null;
      const serialOk = !serialFiltersActive
        || g.serials.some((s) => passFns.serial(s) && passFns.special(serialKinds(s, pf, runSize, gf.series)));
      return serialOk
        && passFns.league(pf.league || "")
        && passFns.player(pf.player || "")
        && passFns.team(pf.team || "")
        && passFns.series(gf.series)
        && passFns.set(g.setID)
        && passFns.sub(g.sub)
        && passFns.tier(gf.tier)
        && passFns.type(pf.category || "")
        && passFns.year(pf.year || "")
        && passFns.badge(gf.tags)
        && passFns.owned(g.serials.length)
        && passFns.listedEdition(perEdition?.listed.get(g.key) || 0)
        && (!filters.held || passFns.heldEdition([...g.momentBySerial.values()].filter((id) => evmSet.has(id)).length, g.momentBySerial.size))
        && (!filters.locking || (lockStatesByEdition ? lockStatesByEdition.get(g.key)?.has(filters.locking) === true : true));
    });
  }, [groupedRows, anyFilter, groupFacts, serialFiltersActive, runSizeOf, passFns, perEdition, filters.held, evmSet, filters.locking, lockStatesByEdition]);

  // Column sort for the grouped view; same keys as the flat view plus
  // Quantity (the count of owned serials)
  const sortedGroupedRows = useMemo(() => {
    if (!filteredGroupedRows || !sort.key || !groupFacts) return filteredGroupedRows;
    const val = (g) => {
      const gf = groupFacts.get(g.key) || { pf: {} };
      switch (sort.key) {
        case "set": return gf.setName || `Set #${g.setID}`;
        case "play": return gf.pf.date || "";
        case "sub": return subeditionLabel(g.sub);
        case "player": return gf.pf.player || "";
        case "badges": return gf.tags ? gf.tags.size : 0;
        case "qty": return g.serials.length;
        default: return 0;
      }
    };
    const dir = sort.dir === "asc" ? 1 : -1;
    const rows = [...filteredGroupedRows];
    rows.sort((a, b) => {
      let cmp;
      if (sort.key === "edition") {
        cmp = (a.setID - b.setID) || (a.playID - b.playID) || (a.sub - b.sub);
      } else {
        const va = val(a);
        const vb = val(b);
        cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      }
      // Ties fall back to the default order (newest first)
      return (cmp * dir) || (b.playID - a.playID) || (b.sub - a.sub) || (a.setID - b.setID);
    });
    return rows;
  }, [filteredGroupedRows, sort, groupFacts]);

  // Trigger loading moments when current page, the id list, or the
  // filters change (the grouped view is served entirely from the
  // collection tuples, so it never pages the chain)
  useLoad(() => {
    if (groupByEdition) return;
    // An empty collection pages nothing (the loader clears the rows);
    // while a search is typed the current page stays put
    if (allMomentIDs.length === 0) loadPageMoments(currentPage, []);
    else if (!isSearching) loadPageMoments(currentPage, sortedFilteredIDs);
  }, [currentPage, allMomentIDs, sortedFilteredIDs, loadPageMoments, isSearching, groupByEdition]);

  // The fetched page details can arrive in any order; the rows render in
  // the exact order of the sorted id slice they were paged from
  const pageMoments = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    const order = new Map(sortedFilteredIDs.slice(start, start + pageSize).map((id, i) => [Number(id), i]));
    const pos = (m) => {
      const i = order.get(Number(m.momentID));
      return i === undefined ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...moments].sort((a, b) => (pos(a) - pos(b)) || (Number(a.momentID) - Number(b.momentID)));
  }, [moments, sortedFilteredIDs, currentPage, pageSize]);

  // Search by Moment ID Handler
  const handleSearchID = async (e) => {
    e.preventDefault();
    if (!searchID.trim()) {
      setIsSearching(false);
      loadPageMoments(1, allMomentIDs);
      setCurrentPage(1);
      return;
    }

    const value = String(searchID.trim());
    const hasMoment = allMomentIDs.some(id => String(id) === value);
    
    if (!hasMoment) {
      setMoments([]);
      setIsSearching(true);
      return;
    }

    setMomentsLoading(true);
    setIsSearching(true);
    try {
      const details = await getAccountMoments(address, [value]);
      setMoments(compileMomentMetadata(details));
    } catch (err) {
      console.error("Failed to fetch searched moment:", err);
    } finally {
      setMomentsLoading(false);
    }
  };

  // Pagination Math, over the FILTERED lists (the grouped view pages
  // over edition rows instead of moments)
  const totalPages = groupByEdition
    ? (Math.ceil((filteredGroupedRows?.length || 0) / pageSize) || 1)
    : (Math.ceil(filteredIDs.length / pageSize) || 1);

  // Facet filter bar, shared by both views. Order: Series, Set,
  // Subedition, Tier, then the play facets. Multi-select everywhere
  // except Listed and Owned; option lists cascade off the other filters.
  const selStyle = { padding: "3px 8px", fontSize: "0.82rem", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", borderRadius: "4px", cursor: "pointer", maxWidth: "180px" };
  const optStyle = { background: "#1a1a1a" };
  const subLabel = subeditionLabel;
  const msFacet = (label, key, options) => ((options.length > 1 || filters[key].length > 0)
    ? <MultiSelect label={label} values={filters[key]} options={options} onChange={(vals) => setFilter(key, vals)} />
    : null);
  const filterBar = facetData ? (
    <div className="d-flex align-center flex-wrap" style={{ gap: "10px 12px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      {msFacet("League", "league", [...facetData.opts.league].sort().map((l) => [l, l]))}
      {msFacet("Series", "series", [...facetData.opts.series].sort((a, b) => a - b).map((s) => [String(s), `Series ${s}`]))}
      {msFacet("Set", "set", [...facetData.opts.set.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => [String(id), name]))}
      {msFacet("Subedition", "sub", [...facetData.opts.sub].sort((a, b) => a - b).map((s) => [String(s), subLabel(s)]))}
      {msFacet("Tier", "tier", [...facetData.opts.tier].sort((a, b) => tierRank(a) - tierRank(b)).map((t) => [t, t]))}
      {msFacet("Type", "type", [...facetData.opts.type].sort().map((t) => [t, t]))}
      {msFacet("Year", "year", [...facetData.opts.year].sort().reverse().map((y) => [y, y]))}
      {msFacet("Player", "player", [...facetData.opts.player].sort((a, b) => a.localeCompare(b)).map((p) => [p, p]))}
      {msFacet("Team", "team", [...facetData.opts.team].sort((a, b) => a.localeCompare(b)).map((t) => [t, t]))}
      {msFacet("Badge", "badge", [...facetData.opts.badge].sort(compareBadges).map((b) => [b, b]))}
      {(facetData.opts.special.size > 0 || filters.special.length > 0) && (
        <MultiSelect
          label="Specials"
          values={filters.special}
          options={Object.keys(SPECIAL_LABELS).filter((k) => facetData.opts.special.has(k) || filters.special.includes(k)).map((k) => [k, SPECIAL_LABELS[k]])}
          onChange={(vals) => setFilter("special", vals)}
        />
      )}
      <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
        Serials
        <input
          type="text"
          value={filters.serial}
          onChange={(e) => setFilter("serial", e.target.value)}
          placeholder="1-99"
          style={{ ...selStyle, width: "76px", cursor: "text" }}
          title="Serial range: 99-250, 99-, -250, or a single number"
        />
      </label>
      {saleSet.size > 0 && (
        <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          Listed
          <select value={filters.listed} onChange={(e) => setFilter("listed", e.target.value)} style={selStyle}>
            <option value="" style={optStyle}>All</option>
            <option value="yes" style={optStyle}>Listed</option>
            <option value="no" style={optStyle}>Unlisted</option>
          </select>
        </label>
      )}
      {/* Always present so the bar never gains a control later; the
          select reads "Loading..." until the lock states arrive */}
      <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
        Locking
        {lockMap ? (
          <select value={filters.locking} onChange={(e) => setFilter("locking", e.target.value)} style={selStyle} title="Locked = lock still running; Unlockable = lock expired but not unlocked yet">
            <option value="" style={optStyle}>All</option>
            <option value="locked" style={optStyle}>Locked</option>
            <option value="unlockable" style={optStyle}>Unlockable</option>
            <option value="unlocked" style={optStyle}>Unlocked</option>
          </select>
        ) : (
          <select disabled value="" style={{ ...selStyle, cursor: "progress", opacity: 0.6 }} title="Lock states are still loading from the chain">
            <option value="" style={optStyle}>Loading...</option>
          </select>
        )}
      </label>
      {evmSet.size > 0 && (
        <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          Held on
          <select value={filters.held} onChange={(e) => setFilter("held", e.target.value)} style={selStyle} title="Where the moment is held: in the Cadence collection, or on Flow EVM through this account's EVM address">
            <option value="" style={optStyle}>Both</option>
            <option value="cadence" style={optStyle}>Cadence</option>
            <option value="evm" style={optStyle}>EVM</option>
          </select>
        </label>
      )}
      <label className="d-flex align-center" style={{ gap: "5px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
        Owned
        <input
          type="number"
          min="1"
          value={filters.owned}
          onChange={(e) => setFilter("owned", e.target.value)}
          style={{ ...selStyle, width: "64px", cursor: "text" }}
          title="Only editions the account owns at least this many of"
        />
      </label>
      {anyFilter && (
        <button
          className="btn-primary"
          style={{ padding: "3px 10px", fontSize: "0.8rem", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", boxShadow: "none" }}
          onClick={clearFilters}
        >
          ✕ Clear
        </button>
      )}
      {anyFilter && (
        <span className="text-muted" style={{ fontSize: "0.8rem" }}>
          {groupByEdition
            ? `${(filteredGroupedRows?.length || 0).toLocaleString()} of ${(groupedRows?.length || 0).toLocaleString()} editions match`
            : `${filteredIDs.length.toLocaleString()} of ${totalMomentsCount.toLocaleString()} moments match`}
        </span>
      )}
    </div>
  ) : null;

  if (loading) {
    return (
      <Loader message={`Loading Account details for ${formattedAddress}...`}>
        {keyProgress !== null && (
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>Indexing collection for sorting: {keyProgress}%</p>
        )}
      </Loader>
    );
  }

  if (error) {
    return <LoadError title="⚠️ Account Load Error" message={error} onRetry={() => loadAccountSummary(true)} retryLabel="Retry Load" />;
  }

  return (
    <div className="account-container">
      {/* Account Info Header */}
      <div className="glass-panel account-header">
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <span className="account-badge">{isEvmAddress(address) ? "EVM address" : "Account"}</span>
            <h1 className="account-title mt-8" style={isEvmAddress(address) ? { overflowWrap: "anywhere", fontSize: "1.35rem" } : undefined}>{formattedAddress}</h1>
            {introOf(formattedAddress) && <div className="account-username" title={introOf(formattedAddress).detail}>{introOf(formattedAddress).text}</div>}
            {/* One row of same-sized chips: counts (the clickable ones
                filter the table), custody, linked accounts, the EVM
                address (a smaller mono face, since it is 42 characters) */}
            <div className="acct-chips mt-8">
              <span className="acct-chip acct-chip-green">{totalMomentsCount.toLocaleString()} moments</span>
              {saleSet.size > 0 && (
                <button
                  type="button"
                  className={`acct-chip acct-chip-blue acct-chip-btn${filters.listed === "yes" ? " active" : ""}`}
                  title="Show only moments listed for sale"
                  onClick={() => setFilter("listed", filters.listed === "yes" ? "" : "yes")}
                >
                  {saleSet.size.toLocaleString()} listed
                </button>
              )}
              {evmSet.size > 0 && (
                <button
                  type="button"
                  className={`acct-chip acct-chip-blue acct-chip-btn${filters.held === "evm" ? " active" : ""}`}
                  title="Moments held on Flow EVM through this account's own EVM address (the Cadence moment sits in the bridge escrow meanwhile); click to show only those"
                  onClick={() => setFilter("held", filters.held === "evm" ? "" : "evm")}
                >
                  {evmSet.size.toLocaleString()} on EVM
                </button>
              )}
              {graph && graph.dapper && (
                <span className="acct-chip" title="A Dapper wallet: Dapper Labs holds the keys.">Dapper wallet</span>
              )}
              {earlyAdopter && (
                <Link to="/early-adopters" className="acct-chip acct-chip-link" title={`Signed the Early Adopters wall, signature #${earlyAdopter.seq.toLocaleString()}, at block ${earlyAdopter.block ? earlyAdopter.block.toLocaleString() : "unknown"}.`}>
                  Early Adopter #{earlyAdopter.seq.toLocaleString()}
                </Link>
              )}
              {/* Three approximations from the census work, each a month or
                  two either way: when the account was created (its address
                  decodes to a creation number), where its size sits among
                  every collection, and when its newest moment was minted */}
              {createdAt && (
                <span className="acct-chip acct-chip-dim" title={`Approximate: the Flow Blockchain hands out addresses in creation order, and this one dates to about ${formatMonth(createdAt)}. A month or two either way (calibration as of ${accountClockAsOf}).`}>
                  Collecting since ~{formatMonth(createdAt)}
                </span>
              )}
              {sizeRank && (
                <span className="acct-chip acct-chip-dim" title={`Against ${holdersCounted.toLocaleString()} collections holding at least one moment, as of ${collectionSizesAsOf}.`}>
                  {sizeRank}
                </span>
              )}
              {lastMint && (
                <span className="acct-chip acct-chip-dim" title={`The newest moment held was minted around ${formatMonth(lastMint)}, read from its place in the mint order. Approximate: a month or two either way.`}>
                  Last new moment ~{formatMonth(lastMint)}
                </span>
              )}
              {graph && graph.parents.map((p) => (
                <Link key={p.address} to={`/account/${p.address}`} className="acct-chip acct-chip-link" title="Account linking: the wallet this account is a child of (confirmed link)">
                  Parent <span className="font-mono">{p.address}</span>
                </Link>
              ))}
              {graph && graph.children.map((c) => (
                <Link key={c.address} to={`/account/${c.address}`} className="acct-chip acct-chip-link" title={`Account linking: a child account this wallet controls${c.dapper ? " (a Dapper wallet)" : ""}`}>
                  Child <span className="font-mono">{c.address}</span>{c.dapper ? " · Dapper" : ""}
                </Link>
              ))}
              {/* One chip per Cadence-owned EVM account; each filters to what
                  is held on EVM */}
              {evmAddressesOf(graph).map((evm) => (
                <button
                  key={evm}
                  type="button"
                  className={`acct-chip acct-chip-btn${filters.held === "evm" ? " active" : ""}`}
                  title="This account's own EVM address. Moments it holds are part of this collection; click to show only those."
                  onClick={() => setFilter("held", filters.held === "evm" ? "" : "evm")}
                >
                  EVM <span className="font-mono acct-chip-evm">{evm}</span>
                </button>
              ))}
              {isEvmAddress(address) && (
                <span className="acct-chip acct-chip-dim" title="An address on the EVM side of the Flow Blockchain, browsed on its own: what it holds through the Top Shot bridge, nothing more. No Cadence account is linked to it here.">
                  Held through the bridge
                </span>
              )}
            </div>
          </div>

          {!isEvmAddress(address) && <div className="d-flex gap-10">
            <Link
              to={`/account/${formattedAddress}/offers`}
              className="btn-primary"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", boxShadow: "none", textDecoration: "none" }}
              title="Active marketplace offers this account has made"
            >
              Offers Made
            </Link>
          </div>}
        </div>
      </div>

      {/* Search Moment ID (moment ids have no meaning in the grouped view) */}
      {!groupByEdition && (
      <div className="glass-panel search-panel">
        <form onSubmit={handleSearchID} className="d-flex align-center justify-between flex-wrap gap-10">
          <div className="d-flex align-center gap-10">
            <h3>Search Moments</h3>
            <span className="text-muted" style={{ fontSize: "0.85rem" }}>Filter owned collection by exact moment ID</span>
          </div>
          <div className="d-flex gap-10">
            <input
              type="number"
              placeholder="Enter moment ID..."
              className="form-control"
              style={{ width: "200px" }}
              value={searchID}
              onChange={(e) => setSearchID(e.target.value)}
            />
            <button type="submit" className="btn-primary">Search</button>
          </div>
        </form>
      </div>
      )}

      {/* Moments Table Grid */}
      <div className="glass-panel table-panel mt-20">
        {/* View toggle: one row per moment, or one row per edition with
            quantity (built from the already-fetched collection tuples) */}
        <div className="d-flex align-center gap-10 flex-wrap" style={{ paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <label className="d-flex align-center" style={{ gap: "8px", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={groupByEdition}
              onChange={(e) => { setGroupByEdition(e.target.checked); setCurrentPage(1); }}
              style={{ cursor: "pointer", accentColor: "var(--primary)" }}
            />
            <span>Group by edition</span>
          </label>
          <span className="text-muted" style={{ fontSize: "0.8rem" }}>
            {groupByEdition
              ? `One row per edition with quantity and serials${groupedRows ? ` (${groupedRows.length.toLocaleString()} editions)` : ""}.`
              : "One row per owned moment."}
          </span>
        </div>

        {filterBar}

        {groupByEdition ? (
          !groupedRows || !localMeta ? (
            <Loader message="Building edition summary..." />
          ) : (
            <div>
              <div className="table-wrapper">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th className="cube-th" title="3D moment cube: the square video, or the player photo when the edition has none"></th>
                      {sortTh("Edition ID", "edition")}
                      {sortTh("Set", "set")}
                      {sortTh("Play", "play")}
                      {sortTh("Subedition", "sub")}
                      {sortTh("Player", "player")}
                      {sortTh("Badges", "badges")}
                      {sortTh("Quantity", "qty")}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedGroupedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((g) => {
                      const isMismint = isMismintPlay(g.playID);
                      const gf = groupFacts?.get(g.key) || { pf: {} };
                      const { setRec, play, series: rowSeries } = gf;
                      const subName = subeditionLabel(g.sub);
                      // Serial-level filters narrow the highlighted list
                      // to the serials that actually match
                      const pfacts = gf.pf;
                      const rowRunSize = serialFiltersActive ? runSizeOf(g.setID, g.playID, g.sub) : null;
                      const rowSerials = serialFiltersActive
                        ? g.serials.filter((s) => passFns.serial(s) && passFns.special(serialKinds(s, pfacts, rowRunSize, rowSeries)))
                        : g.serials;
                      const serialsOpen = expandedSerials.has(g.key);
                      const matchedSet = serialsOpen && serialFiltersActive ? new Set(rowSerials) : null;
                      return (
                        <React.Fragment key={g.key}>
                        <tr className={isMismint ? "mismint-row" : ""}>
                          {cubeCell(g.setID, g.playID, play, rowSeries, `${play?.FullName || playSummary(play, g.playID)} · ${setRec?.setName || `Set #${g.setID}`}`)}
                          <td className="font-mono"><Link to={`/editions/${g.key}`}>{g.key}</Link></td>
                          <td><Link to={`/sets/${g.setID}`}>{setRec?.setName || `Set #${g.setID}`}</Link></td>
                          <td><Link to={`/plays/${g.playID}`}>{playSummary(play, g.playID)}</Link></td>
                          <td>{subName}</td>
                          <td>
                            {play?.FullName && play.FullName.trim() !== "" ? (
                              <Link to={playerPath(play.FullName)} style={{ fontWeight: "600" }}>
                                {play.FullName.trim()}
                              </Link>
                            ) : (
                              <Link to={`/plays/${g.playID}`} style={{ fontWeight: "600" }}>
                                {(play?.TeamAtMoment || "").trim() || `Play #${g.playID}`}
                              </Link>
                            )}
                            {isMismint && <span className="mini-badge-mismint" style={{ marginLeft: "8px" }}>Mismint ⚠️</span>}
                          </td>
                          <td><Badges tags={[...(gf.tags || [])]} /></td>
                          <td className="font-mono">
                            {/* The quantity is the accordion handle: it
                                expands the row into the serial list */}
                            <button
                              type="button"
                              onClick={() => toggleSerials(g.key)}
                              title={serialsOpen ? "Hide the owned serials" : "Show the owned serials"}
                              style={{ background: "none", border: "none", color: "var(--primary-hover)", cursor: "pointer", font: "inherit", padding: 0, whiteSpace: "nowrap" }}
                            >
                              {serialFiltersActive ? `${rowSerials.length}/${g.serials.length}` : g.serials.length} {serialsOpen ? "▴" : "▾"}
                            </button>
                          </td>
                        </tr>
                        {serialsOpen && (
                          <tr>
                            <td colSpan={7} style={{ background: "rgba(139, 92, 246, 0.04)", padding: "10px 16px" }}>
                              {serialFiltersActive && (
                                <div className="text-muted" style={{ fontSize: "0.78rem", marginBottom: "6px" }}>
                                  {rowSerials.length} of {g.serials.length} serials match the serial filters (the rest are dimmed)
                                </div>
                              )}
                              {/* Same boxed chips as a roster row's play ids: equal widths, centred, marks inside the box */}
                              <div className="id-grid" style={{ fontSize: "0.8rem", "--id-w": "8em" }}>
                                {g.serials.map((s) => {
                                  const momentID = g.momentBySerial.get(s);
                                  const expiry = lockMap ? lockMap.get(momentID) : undefined;
                                  const listed = saleSet.has(momentID);
                                  const dim = matchedSet ? !matchedSet.has(s) : false;
                                  const lockNote = expiry === undefined ? "" : (lockStateOf(expiry) === "unlockable" ? "; lock expired, not unlocked yet" : `; locked until ${new Date(expiry * 1000).toLocaleString()}`);
                                  return (
                                    <a
                                      key={s}
                                      href={`https://nbatopshot.com/moment/${momentID}?tab=details`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="set-link"
                                      style={{ opacity: dim ? 0.35 : 1 }}
                                      title={`Moment ${momentID} on nbatopshot.com${listed ? "; listed for sale" : ""}${lockNote}`}
                                    >
                                      #{s}
                                      {listed && <span style={{ color: "var(--status-success)", fontWeight: "700" }}>$</span>}
                                      {expiry !== undefined && (lockStateOf(expiry) === "unlockable" ? "🔑" : "🔒")}
                                      {evmSet.has(momentID) && <span style={{ fontSize: "0.6rem", fontWeight: 700, color: "var(--primary-hover)", marginLeft: "2px" }} title="Held on Flow EVM">EVM</span>}
                                    </a>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
            </div>
          )
        ) : momentsLoading ? (
          <Loader message="Fetching moment details from the Flow Blockchain..." />
        ) : moments.length > 0 ? (
          <div>
            <div className="table-wrapper">
              <table className="premium-table">
                <thead>
                  <tr>
                    <th className="cube-th" title="3D moment cube: the square video, or the player photo when the edition has none"></th>
                    {sortTh("Edition ID", "edition")}
                    {sortTh("Set", "set")}
                    {sortTh("Play", "play")}
                    {sortTh("Subedition", "sub")}
                    {sortTh("Player", "player")}
                    {sortTh("Badges", "badges")}
                    {sortTh("Serial", "serial")}
                    {filters.listed === "yes" && <th title="Prices load per page, so this column cannot sort the whole collection">Price</th>}
                    {sortTh("Locked", "locked")}
                  </tr>
                </thead>
                <tbody>
                  {pageMoments.map((moment) => {
                    const isMismint = isMismintPlay(moment.playID);
                    const editionID = `${moment.setID}_${moment.playID}_${moment.subeditionID}`;

                    return (
                      <tr key={moment.momentID} className={isMismint ? "mismint-row" : ""}>
                        {cubeCell(moment.setID, moment.playID, moment.playMetadata, localMeta?.sets.get(Number(moment.setID))?.series, `${moment.playMetadata?.FullName || playSummary(moment.playMetadata, moment.playID)} · ${moment.setName || `Set #${moment.setID}`}`)}
                        <td className="font-mono"><Link to={`/editions/${editionID}`}>{editionID}</Link></td>
                        <td>
                          <Link to={`/sets/${moment.setID}`}>{moment.setName || `Set #${moment.setID}`}</Link>
                        </td>
                        <td>
                          <Link to={`/plays/${moment.playID}`}>{playSummary(moment.playMetadata, moment.playID)}</Link>
                        </td>
                        <td>{moment.subeditionName || subeditionLabel(Number(moment.subeditionID))}</td>
                        <td>
                          {/* Named players link to their player page (the
                              Play column already covers the play); team
                              moments fall back to the play */}
                          {moment.playMetadata.FullName && moment.playMetadata.FullName.trim() !== "" ? (
                            <Link to={playerPath(moment.playMetadata.FullName)} style={{ fontWeight: "600" }}>
                              {moment.playMetadata.FullName.trim()}
                            </Link>
                          ) : (
                            <Link to={`/plays/${moment.playID}`} style={{ fontWeight: "600" }}>
                              {(moment.playMetadata.TeamAtMoment || "").trim() || `Play #${moment.playID}`}
                            </Link>
                          )}
                          {isMismint && <span className="mini-badge-mismint" style={{ marginLeft: "8px" }}>Mismint ⚠️</span>}
                        </td>
                        <td><Badges tags={[...momentTags(playFacts?.get(Number(moment.playID)), moment.setID, moment.playID, moment.subeditionID)]} /></td>
                        {/* The serial cell carries the outbound moment link
                            (the Moment ID column it replaced) */}
                        <td className="font-mono" style={{ whiteSpace: "nowrap" }}>
                          <a
                            href={`https://nbatopshot.com/moment/${moment.momentID}?tab=details`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontWeight: "600" }}
                            title={`Moment ${moment.momentID} on nbatopshot.com`}
                          >
                            #{moment.serialNumber} ↗
                          </a>
                          {moment.onEVM && (
                            <span className="badge badge-nba ml-8" style={{ fontSize: "0.65rem", padding: "1px 5px" }} title="Held on Flow EVM; the Cadence moment is in the bridge escrow">EVM</span>
                          )}
                        </td>
                        {filters.listed === "yes" && (
                          <td className="font-mono" style={{ whiteSpace: "nowrap" }}>
                            {moment.salePrice != null ? (
                              <span style={{ color: "var(--status-success)", fontWeight: "700" }} title="Listed for sale at this price">
                                {formatUsd(moment.salePrice)}
                              </span>
                            ) : ""}
                          </td>
                        )}
                        <td style={{ whiteSpace: "nowrap" }}>{lockCell(moment.lockExpiry)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {!isSearching && <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />}
          </div>
        ) : (
          <div className="text-center text-muted" style={{ padding: "40px" }}>
            No moments found for this account!
          </div>
        )}
      </div>

      <CubeOverlay cube={cubeOverlay} onClose={() => setCubeOverlay(null)} />
      <style>{`
        .account-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .account-header {
          padding: 30px;
        }
        .account-badge {
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          font-size: 0.85rem;
          padding: 4px 10px;
          border-radius: 6px;
          font-weight: 600;
        }
        .account-title {
          font-size: 2rem;
          font-family: var(--font-mono);
          word-break: break-all;
        }
        .acct-chips {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
        }
        .acct-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 11px;
          border-radius: 9999px;
          font-size: 0.78rem;
          font-weight: 600;
          line-height: 1.3;
          color: #fff;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          white-space: nowrap;
          text-decoration: none;
        }
        .acct-chip .font-mono {
          font-weight: 500;
        }
        .acct-chip-green {
          background: var(--status-success-bg);
          color: var(--status-success);
          border-color: rgba(16, 185, 129, 0.3);
        }
        .acct-chip-blue {
          background: rgba(59, 130, 246, 0.12);
          color: var(--accent-nba);
          border-color: rgba(59, 130, 246, 0.3);
        }
        .acct-chip-btn {
          cursor: pointer;
          font-family: inherit;
        }
        .acct-chip-btn:hover,
        .acct-chip-btn.active {
          background: rgba(59, 130, 246, 0.28);
        }
        .acct-chip-link {
          color: var(--primary-hover);
          background: rgba(139, 92, 246, 0.12);
          border-color: rgba(139, 92, 246, 0.3);
        }
        .acct-chip-link:hover {
          background: rgba(139, 92, 246, 0.24);
        }
        /* The 42-character EVM address: same chip, smaller face */
        .acct-chip-evm {
          font-size: 0.68rem;
          letter-spacing: -0.01em;
          color: var(--text-muted);
        }
        @media (max-width: 600px) {
          .acct-chip-evm {
            font-size: 0.58rem;
          }
        }
        .search-panel {
          padding: 16px 24px;
        }
      `}</style>
    </div>
  );
}
