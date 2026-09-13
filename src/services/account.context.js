import { getCollectionIDs, getCollectionData, getAccountGraph, getEvmCollectionIDsAll, getEscrowMomentData } from "./fcl.service";
import { getAccountCollectionDB, saveAccountCollectionDB } from "./db.service";

/*
 * Account context: the Flow address the user is currently browsing AS.
 * Not a login (there is no auth; anyone can enter any address): it is a
 * lens. When set, the whole app annotates itself with what that address
 * owns: the home page becomes a collection summary, list pages gain
 * owned/total fractions.
 *
 * The collection is fetched from the chain in data-only batches
 * ([momentID, setID, playID, serial, subeditionID] per moment, ~2,000 per
 * script call), cached in IndexedDB per address, and refreshed in the
 * background when the cache is older than REFRESH_AFTER_MS. The refresh is
 * incremental: moment data is immutable once minted, so it only re-reads
 * the ID list, drops departed moments, and fetches data for new IDs.
 * Pages consume it through the useAccountCollection hook.
 */

const STORAGE_KEY = "topshot_account_context";
// Addresses looked up before, most recent first, so exiting the account
// view never loses them (the nav input and the account menu list them)
const HISTORY_KEY = "topshot_account_history";
const HISTORY_MAX = 8;
// Linked accounts (HybridCustody parents/children) the user has checked
// into the context, per primary address: { [primary]: [address, ...] }.
// Their moments merge with the primary's in everything the app shows.
const GROUP_KEY = "topshot_account_group";
const CHUNK = 2000;
const REFRESH_AFTER_MS = 10 * 60 * 1000;

let state = {
  address: null,
  graph: null, // getAccountGraph result: dapper flag, parents, children, COAs (null for an EVM address)
  included: [], // linked addresses checked into the context (persisted)
  linked: {}, // per included address: { status, moments, fetchedAt, error }

  status: "idle", // idle | loading | ready | error
  moments: null, // [[momentID, setID, playID, serial, subeditionID], ...]
  fetchedAt: null,
  progress: 0,
  error: null
};

const listeners = new Set();

function notify() {
  listeners.forEach((l) => l({ ...state }));
}

function update(patch) {
  state = { ...state, ...patch };
  notify();
}

export function subscribeAccountContext(listener) {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export function getAccountContext() {
  return { ...state };
}

// The account menu's Reload. Pages holding their own view of the
// collection (the account page) subscribe and refetch alongside.
const reloadListeners = new Set();
export function subscribeAccountReload(listener) {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

/** Refetch the collection now, cache age ignored (new moments merge into
 *  the cached rows; unchanged collections keep their array). */
export async function reloadAccount() {
  if (!state.address || state.status === "loading") return;
  reloadListeners.forEach((l) => { try { l(); } catch (err) { console.warn("reload listener failed:", err); } });
  update({ status: "loading", progress: 0, error: null });
  state.included.forEach((a) => loadLinked(a, { force: true }));
  await fetchCollection(state.address, state.moments);
}

const historyListeners = new Set();
function notifyHistory() {
  const list = getRecentAddresses();
  historyListeners.forEach((l) => l(list));
}

/** Previously looked-up addresses, most recent first (never the empty string) */
export function getRecentAddresses() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((a) => typeof a === "string" && a) : [];
  } catch {
    return [];
  }
}

export function subscribeRecentAddresses(listener) {
  historyListeners.add(listener);
  listener(getRecentAddresses());
  return () => historyListeners.delete(listener);
}

/** Move an address to the front of the lookup history (added if new) */
// Usernames the box has resolved, by address, so the menu and the recent
// list can say "@name" beside an address. Only username and address are
// kept, with the date they were looked up (a username can change).
const NAMES_KEY = "topshot_usernames";
const readNames = () => { try { return JSON.parse(localStorage.getItem(NAMES_KEY) || "{}") || {}; } catch { return {}; } };
export function rememberUsername(address, username, fetchedAt) {
  const addr = normalizeAddress(address);
  if (!addr || !username) return;
  const names = readNames();
  names[addr] = { username, fetchedAt: fetchedAt || new Date().toISOString() };
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* private mode */ }
}
export function usernameOf(address) {
  const entry = readNames()[normalizeAddress(address)];
  return entry ? entry.username : null;
}

export function rememberAddress(input) {
  const address = normalizeAddress(input);
  if (!address) return;
  const list = [address, ...getRecentAddresses().filter((a) => a !== address)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* private mode */ }
  notifyHistory();
}

export function forgetAddress(input) {
  const address = normalizeAddress(input);
  if (!address) return;
  const list = getRecentAddresses().filter((a) => a !== address);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* private mode */ }
  notifyHistory();
}

function readGroup(primary) {
  try {
    const all = JSON.parse(localStorage.getItem(GROUP_KEY) || "{}");
    const list = all && all[primary];
    return Array.isArray(list) ? list.filter((a) => typeof a === "string" && a && a !== primary) : [];
  } catch {
    return [];
  }
}

function writeGroup(primary, list) {
  try {
    const all = JSON.parse(localStorage.getItem(GROUP_KEY) || "{}") || {};
    if (list.length > 0) all[primary] = list; else delete all[primary];
    localStorage.setItem(GROUP_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/** An EVM address (0x and forty hex characters), as the account in view
 *  can be one: the bridge's ERC721 lists what any EVM address holds, so
 *  it needs no Cadence account behind it. Nothing links it to anything. */
export const isEvmAddress = (input) => /^0x[0-9a-f]{40}$/.test(String(input || "").trim().toLowerCase());

/** The EVM addresses whose Top Shot holdings count as a Cadence account's:
 *  its Cadence-owned EVM accounts (COAs), as the chain reports them */
export const evmAddressesOf = (graph) => ((graph && graph.evms) || (graph && graph.evm ? [graph.evm] : [])).map((a) => String(a).toLowerCase());

function setLinked(address, patch) {
  if (!state.included.includes(address)) return;
  update({ linked: { ...state.linked, [address]: { ...(state.linked[address] || {}), ...patch } } });
}

/**
 * Load one linked account's collection into state.linked: the cached
 * copy first, then the chain when the cache is stale (or force). Aborts
 * quietly if the primary changes or the account is unchecked meanwhile.
 */
async function loadLinked(address, { force = false } = {}) {
  const primary = state.address;
  const alive = () => state.address === primary && state.included.includes(address);
  setLinked(address, { status: "loading", error: null });
  let cached = null;
  try { cached = await getAccountCollectionDB(address); } catch { /* no cache */ }
  if (!alive()) return;
  if (cached && Array.isArray(cached.moments)) {
    setLinked(address, { status: "ready", moments: cached.moments, fetchedAt: cached.fetchedAt });
    if (!force && Date.now() - (cached.fetchedAt || 0) < REFRESH_AFTER_MS) return;
    setLinked(address, { status: "loading" });
  }
  try {
    const graph = await getAccountGraph(address).catch(() => null);
    if (!alive()) return;
    const cadenceIDs = (await getCollectionIDs(address)).map(Number);
    if (!alive()) return;
    const evmList = await getEvmCollectionIDsAll(evmAddressesOf(graph)).catch(() => []);
    if (!alive()) return;
    const evmIDs = new Set(evmList);
    const ids = [...cadenceIDs, ...evmList.filter((id) => !cadenceIDs.includes(id))];
    const result = await syncCollectionTuples(address, ids, {
      evmIDs,
      cachedMoments: cached ? cached.moments : null,
      shouldAbort: () => !alive(),
      saveAlways: true
    });
    if (!result || !alive()) return;
    setLinked(address, { status: "ready", moments: result.moments, fetchedAt: Date.now(), error: null });
  } catch (err) {
    console.error(`Failed to fetch linked collection for ${address}:`, err);
    if (!alive()) return;
    setLinked(address, { status: cached ? "ready" : "error", error: err.message || String(err) });
  }
}

/** Check or uncheck a linked account (a parent or child of the primary)
 *  into the context; checked accounts' moments merge into every view. */
export function toggleLinkedAccount(input) {
  const address = normalizeAddress(input);
  if (!address || !state.address || address === state.address) return;
  if (state.included.includes(address)) {
    const included = state.included.filter((a) => a !== address);
    const linked = { ...state.linked };
    delete linked[address];
    writeGroup(state.address, included);
    update({ included, linked });
    return;
  }
  const included = [...state.included, address];
  writeGroup(state.address, included);
  update({ included });
  loadLinked(address);
}

export function normalizeAddress(input) {
  let addr = String(input || "").trim().toLowerCase();
  if (!addr) return null;
  if (!addr.startsWith("0x")) addr = "0x" + addr;
  return addr; // Flow addresses are 8 bytes, but let the chain be the judge of validity
}

// Monotonically increasing token so a stale fetch (address changed mid-run)
// never writes into the new context
let fetchToken = 0;

/**
 * The cache-merging tuple fetch, shared by this context's refresh and the
 * Account page (which used to carry a line-for-line copy writing the SAME
 * IndexedDB record): moments are immutable once minted, so cached rows are
 * reused and only unknown ids hit the chain, in 2000-id chunks.
 *
 * saveAlways: the context persists even when nothing changed so fetchedAt
 * advances and the next load inside the refresh window skips the chain;
 * the page passes false (it saves only on growth, so a plain visit does
 * not reset the context's refresh window). The write is best-effort: a
 * broken IndexedDB must not hide chain data just fetched.
 *
 * Returns { moments, newCount, cachedCount }, or null when shouldAbort
 * fired mid-fetch.
 */
export async function syncCollectionTuples(address, ids, { cachedMoments = null, onProgress = null, shouldAbort = null, saveAlways = true, evmIDs = null } = {}) {
  const known = new Map((cachedMoments || []).map((m) => [Number(m[0]), m]));
  const idSet = new Set(ids);
  // Tuples carry a sixth element, 1 while the moment is held on EVM (the
  // Cadence NFT then sits in the bridge escrow). Ownership facts are
  // immutable but that flag is not, so it is re-stamped on every sync
  // from the caller's current EVM id set; a row keeps its identity when
  // nothing changed.
  const onEVM = (id) => Boolean(evmIDs && evmIDs.has(id));
  const stamp = (m) => {
    const id = Number(m[0]);
    const flag = onEVM(id) ? 1 : 0;
    if ((m[5] || 0) === flag) return m;
    return flag ? [...m.slice(0, 5), 1] : m.slice(0, 5);
  };
  const moments = [];
  known.forEach((m, id) => { if (idSet.has(id)) moments.push(stamp(m)); });
  const newIDs = ids.filter((id) => !known.has(id));
  const newCadence = newIDs.filter((id) => !onEVM(id));
  const newEVM = newIDs.filter(onEVM);

  let done = 0;
  const progress = () => { if (onProgress) onProgress(Math.round((done / newIDs.length) * 100)); };
  for (let i = 0; i < newCadence.length; i += CHUNK) {
    const batch = await getCollectionData(address, newCadence.slice(i, i + CHUNK));
    if (shouldAbort && shouldAbort()) return null;
    moments.push(...batch);
    done += batch.length;
    progress();
  }
  for (let i = 0; i < newEVM.length; i += CHUNK) {
    const batch = await getEscrowMomentData(newEVM.slice(i, i + CHUNK));
    if (shouldAbort && shouldAbort()) return null;
    moments.push(...batch.map((m) => [...m, 1]));
    done += batch.length;
    progress();
  }

  if (saveAlways || newIDs.length > 0) {
    const record = { address: normalizeAddress(address), fetchedAt: Date.now(), moments };
    try { await saveAccountCollectionDB(record); } catch { /* view-only this session */ }
  }
  return { moments, newCount: newIDs.length, cachedCount: known.size };
}

async function fetchCollection(address, cachedMoments) {
  const token = ++fetchToken;
  try {
    // An EVM address on its own has no Cadence account the chain can name:
    // no graph, no Cadence collection; what it holds on Flow EVM is the
    // whole collection, every moment marked EVM
    const evm = isEvmAddress(address);
    // What the address is (Dapper or not, linked parents and
    // children, its EVM accounts); optional, the collection loads without it
    const graph = evm ? null : await getAccountGraph(address).catch((err) => { console.warn("account graph unavailable:", err); return null; });
    if (token !== fetchToken) return;
    update({ graph });
    const cadenceIDs = evm ? [] : (await getCollectionIDs(address)).map(Number);
    if (token !== fetchToken) return;
    // Moments the address holds on Flow EVM through its COAs join the
    // collection, flagged; parents' and children's holdings stay theirs
    const evmList = await getEvmCollectionIDsAll(evm ? [address] : evmAddressesOf(graph)).catch((err) => { console.warn("EVM collection unavailable:", err); return []; });
    if (token !== fetchToken) return;
    const evmIDs = new Set(evmList);
    const ids = [...cadenceIDs, ...evmList.filter((id) => !cadenceIDs.includes(id))];

    const result = await syncCollectionTuples(address, ids, {
      evmIDs,
      cachedMoments,
      onProgress: (p) => { if (token === fetchToken) update({ progress: p }); },
      shouldAbort: () => token !== fetchToken,
      saveAlways: true
    });
    if (!result || token !== fetchToken) return;

    // Unchanged collection keeps the same array reference so pages do not
    // rebuild their owned indexes for nothing
    const unchanged = state.moments && result.newCount === 0 && result.moments.length === result.cachedCount;
    update({ status: "ready", moments: unchanged ? state.moments : result.moments, fetchedAt: Date.now(), progress: 100, error: null });
  } catch (err) {
    console.error(`Failed to fetch collection for ${address}:`, err);
    if (token !== fetchToken) return;
    // Keep any cached moments usable; only report error when we have nothing
    update({ status: state.moments ? "ready" : "error", error: err.message || String(err) });
  }
}

export async function setAccountAddress(input, { remember = true } = {}) {
  const address = normalizeAddress(input);
  if (!address) return;
  try { localStorage.setItem(STORAGE_KEY, address); } catch { /* private mode */ }
  if (remember) rememberAddress(address);
  const included = readGroup(address);
  update({ address, graph: null, status: "loading", moments: null, fetchedAt: null, progress: 0, error: null, included, linked: {} });
  included.forEach((a) => loadLinked(a));

  // Serve the cached copy instantly, then refresh from chain if it is old
  let cached = null;
  try { cached = await getAccountCollectionDB(address); } catch { /* no cache */ }
  if (state.address !== address) return; // user moved on
  if (cached && Array.isArray(cached.moments)) {
    update({ status: "ready", moments: cached.moments, fetchedAt: cached.fetchedAt, progress: 100 });
    if (Date.now() - (cached.fetchedAt || 0) < REFRESH_AFTER_MS) {
      // Fresh cache skips the collection fetch, which is where the graph
      // (Dapper flag, parents, children, EVM address) normally loads, so
      // the menu would otherwise show none of it until the next reload
      if (!isEvmAddress(address)) {
        getAccountGraph(address)
          .then((graph) => { if (state.address === address) update({ graph }); })
          .catch((err) => console.warn("account graph unavailable:", err));
      }
      return;
    }
    await fetchCollection(address, cached.moments);
    return;
  }
  await fetchCollection(address, null);
}

export function clearAccountAddress() {
  fetchToken++; // cancel any in-flight fetch
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  update({ address: null, graph: null, status: "idle", moments: null, fetchedAt: null, progress: 0, error: null, included: [], linked: {} });
}

// Restore the persisted context on module load
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  // Restoring is not a new lookup: the history keeps its order
  if (saved) setAccountAddress(saved, { remember: false });
} catch { /* private mode */ }
