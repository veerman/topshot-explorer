/*
 * The offers book and the event fold that keeps it current. Runtime
 * agnostic on purpose: the same code runs in three places:
 *   - the Cloudflare Worker cron (deploy/cloudflare/worker.js) folds the
 *     events since the book's height every half hour and republishes it
 *     to the cache bucket;
 *   - the browser (offers.service.js) folds the few minutes since the
 *     published book so the Offers page reads as of the sealed block;
 *   - the deploy-time script (scripts/scan-offers.mjs) folds, then
 *     VERIFIES the book against every buyer's live offer collection and
 *     re-bases the bucket from the result.
 * Only fetch and the Flow REST primitives in flowEvents.service are used.
 *
 * Why a fold works: an OfferAvailable event carries the whole offer (id,
 * buyer, amount, collection, targeting params) and an OfferCompleted event
 * carries the id and whether it was bought or cancelled, so a correct book
 * at height H stays correct by applying the events after H. Enumerating
 * buyers' books (the expensive part) is only for building the base and
 * for the occasional verification.
 *
 * Book (in memory): { format, height, time, offers: { edition,
 * subedition, nft }, other, purchasedInBooks }. Each Top Shot map holds
 * every active offer per key as [amount, buyer, offerId, createdAtMs|0],
 * highest first; keys are "setId_playId", "setId_playId_subId" and the
 * moment id. `other` holds active offers on every other collection as
 * [collection, amount, buyer, offerId, createdAtMs, level, paramsBlob];
 * `purchasedInBooks` holds bought offers a buyer has not cleaned up yet.
 *
 * Bucket layout (all public, under offers/):
 *   book.json    the Top Shot book plus headline counts (what the page
 *                needs first, ~3 MB)
 *   other.json   other collections and purchased-in-book rows
 *   stats.json   accepted-offer aggregates plus the newest accepted rows
 *   state.json   the fold's working state: height, buyer registry,
 *                creation times, retained accepted history
 *   accepted-YYYY-MM.json   the accepted-offer archive, one object per
 *                month, appended by the fold, never trimmed
 */
import { getEvents, decodeEventPayload, restBase, MAX_EVENT_SPAN, TOPSHOT_NFT_TYPE } from "./flowEvents.service.js";

export const AVAILABLE_EVENT = "A.b8ea91944fd51c43.OffersV2.OfferAvailable";
export const COMPLETED_EVENT = "A.b8ea91944fd51c43.OffersV2.OfferCompleted";
export const BOOK_FORMAT = 3;
export const OFFERS_PREFIX = "offers";
export const BOOK_KEY = `${OFFERS_PREFIX}/book.json`;
export const OTHER_KEY = `${OFFERS_PREFIX}/other.json`;
export const STATS_KEY = `${OFFERS_PREFIX}/stats.json`;
export const STATE_KEY = `${OFFERS_PREFIX}/state.json`;
export const shardKey = (month) => `${OFFERS_PREFIX}/accepted-${month}.json`;
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
// The newest accepted rows the stats object carries for the page's feed
// (the monthly shards are the full record)
export const ACCEPTED_FEED_CAP = 5000;
// Accepted rows the working state retains for the leader boards
export const ACCEPTED_STATE_CAP = 50000;

// "A.e4cf4bdc1751c65d.AllDay.NFT" -> "AllDay"
export const collectionOf = (typeID) => {
  const parts = String(typeID || "").split(".");
  return parts.length >= 3 ? parts[2] : String(typeID || "");
};

// Targeting params as a display blob for collections we cannot enrich
const PARAM_SKIP = new Set(["_type", "typeId", "resolver"]);
export const paramsBlob = (params) =>
  Object.entries(params || {})
    .filter(([k]) => !PARAM_SKIP.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");

export function emptyBook() {
  return { format: BOOK_FORMAT, height: 0, time: null, offers: { edition: {}, subedition: {}, nft: {} }, other: [], purchasedInBooks: [] };
}

export function emptyState() {
  return { format: BOOK_FORMAT, height: 0, firstHeight: 0, buyers: [], created: {}, accepted: [], rebasedAt: 0, rebasedHeight: 0 };
}

/** One offer record from an OfferAvailable payload (block time = creation time) */
export function offerFromEvent(d, ts) {
  const p = d.offerParamsString || {};
  const collection = collectionOf(d.nftType);
  return {
    buyer: d.offerAddress || "",
    offerId: String(d.offerId),
    amount: Number(d.offerAmount) || 0,
    level: p._type || "",
    setId: p.setId || "",
    playId: p.playId || "",
    subId: p.subeditionId || "",
    nftId: p.nftId || "",
    purchased: 0,
    collection: collection || "TopShot",
    blob: d.nftType === TOPSHOT_NFT_TYPE ? "" : paramsBlob(p),
    createdAt: ts || 0
  };
}

/** An accepted-offer history row from an OfferCompleted payload (purchased) */
export function acceptedRowFromEvent(d, ts) {
  const p = d.offerParamsString || {};
  const isTopShot = d.nftType === TOPSHOT_NFT_TYPE;
  return [
    ts,
    collectionOf(d.nftType),
    Number(d.offerAmount) || 0,
    d.offerAddress || "",
    d.acceptingAddress || "",
    p._type || "",
    p.setId || "",
    p.playId || "",
    p.subeditionId || "",
    d.nftId != null ? String(d.nftId) : "",
    isTopShot ? "" : paramsBlob(p)
  ];
}

/** Where an active offer lives in the book: [bucket, key] */
export function slotOf(o) {
  if (o.collection !== "TopShot") return ["other", null];
  if (o.level === "NFT" && o.nftId) return ["nft", String(o.nftId)];
  if (o.level === "TopShotSubedition" && o.setId && o.playId) return ["subedition", `${Number(o.setId)}_${Number(o.playId)}_${Number(o.subId) || 0}`];
  if (o.level === "TopShotEdition" && o.setId && o.playId) return ["edition", `${Number(o.setId)}_${Number(o.playId)}`];
  return [null, null];
}

/** offerId -> [bucket, key] over everything the book holds */
export function indexBook(book) {
  const idx = new Map();
  for (const bucket of ["edition", "subedition", "nft"]) {
    for (const [key, list] of Object.entries(book.offers[bucket])) {
      for (const e of list) idx.set(String(e[2]), [bucket, key]);
    }
  }
  for (const row of book.other) idx.set(String(row[3]), ["other", null]);
  for (const row of book.purchasedInBooks) idx.set(String(row[3]), ["purchased", null]);
  return idx;
}

/** Adds an offer record to the book (idempotent by offer id) */
export function addOffer(book, o, idx) {
  const id = String(o.offerId);
  if (idx && idx.has(id)) return false;
  if (o.purchased) {
    book.purchasedInBooks.push([o.collection, o.amount, o.buyer, id, o.level, o.setId, o.playId, o.subId, o.nftId, o.blob, o.createdAt || 0]);
    if (idx) idx.set(id, ["purchased", null]);
    return true;
  }
  const [bucket, key] = slotOf(o);
  if (bucket === "other") {
    book.other.push([o.collection, o.amount, o.buyer, id, o.createdAt || 0, o.level, o.blob]);
    book.other.sort((a, b) => b[1] - a[1]);
    if (idx) idx.set(id, ["other", null]);
    return true;
  }
  if (!bucket) return false;
  const list = (book.offers[bucket][key] = book.offers[bucket][key] || []);
  if (list.some((e) => String(e[2]) === id)) return false;
  list.push([o.amount, o.buyer, id, o.createdAt || 0]);
  list.sort((a, b) => b[0] - a[0]);
  if (idx) idx.set(id, [bucket, key]);
  return true;
}

/** Removes an offer by id wherever it sits; true when something was removed */
export function removeOffer(book, offerId, idx) {
  const id = String(offerId);
  const where = idx ? idx.get(id) : null;
  const dropFrom = (arr, pos) => { if (pos >= 0) arr.splice(pos, 1); return pos >= 0; };
  if (where) {
    const [bucket, key] = where;
    idx.delete(id);
    if (bucket === "other") return dropFrom(book.other, book.other.findIndex((r) => String(r[3]) === id));
    if (bucket === "purchased") return dropFrom(book.purchasedInBooks, book.purchasedInBooks.findIndex((r) => String(r[3]) === id));
    const list = book.offers[bucket][key];
    if (!list) return false;
    const ok = dropFrom(list, list.findIndex((e) => String(e[2]) === id));
    if (list.length === 0) delete book.offers[bucket][key];
    return ok;
  }
  // No index: scan (rare path)
  for (const bucket of ["edition", "subedition", "nft"]) {
    for (const [key, list] of Object.entries(book.offers[bucket])) {
      const pos = list.findIndex((e) => String(e[2]) === id);
      if (pos >= 0) { list.splice(pos, 1); if (list.length === 0) delete book.offers[bucket][key]; return true; }
    }
  }
  if (dropFrom(book.other, book.other.findIndex((r) => String(r[3]) === id))) return true;
  return dropFrom(book.purchasedInBooks, book.purchasedInBooks.findIndex((r) => String(r[3]) === id));
}

/** Headline counts the page shows */
export function bookCounts(book) {
  let total = 0;
  const buyers = new Set();
  for (const bucket of ["edition", "subedition", "nft"]) {
    for (const list of Object.values(book.offers[bucket])) {
      total += list.length;
      for (const e of list) buyers.add(e[1]);
    }
  }
  return { totalOffers: total, topshotBuyers: buyers.size, totalOtherOffers: book.other.length };
}

// ---- events -----------------------------------------------------------

/** [from, to] windows of at most MAX_EVENT_SPAN heights */
export function windowsFor(from, to) {
  const out = [];
  for (let h = from; h <= to; h += MAX_EVENT_SPAN) out.push([h, Math.min(h + MAX_EVENT_SPAN - 1, to)]);
  return out;
}

// Bounded-concurrency pool (scripts/lib/pool.mjs, inlined so the browser
// and the Worker need no scripts/ import)
export async function runPool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function withRetry(fn, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) { last = err; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

/** Timestamp (ms) of a block, or 0 */
export async function blockTimeMs(height) {
  try {
    const res = await fetch(`${restBase()}/v1/blocks?height=${height}`);
    if (!res.ok) return 0;
    const b = await res.json();
    return Date.parse(b?.[0]?.header?.timestamp || "") || 0;
  } catch {
    return 0;
  }
}

/**
 * Applies every offer event in [from, to] to the book (and the state's
 * buyer registry and creation times). Windows fetch in parallel, events
 * apply in block order. Returns { accepted: rows (newest first), added,
 * removed, windows }. The caller advances state.height once it has
 * persisted the result: the fold itself never moves it.
 */
export async function foldEvents(book, state, from, to, { concurrency = 4, onProgress } = {}) {
  const windows = windowsFor(from, to);
  const idx = indexBook(book);
  const buyers = new Set(state.buyers || []);
  const perWindow = new Array(windows.length);
  let done = 0;
  await runPool(windows, concurrency, async ([start, end], i) => {
    const [created, completed] = await Promise.all([
      withRetry(() => getEvents(AVAILABLE_EVENT, start, end)),
      withRetry(() => getEvents(COMPLETED_EVENT, start, end))
    ]);
    const evs = [];
    for (const b of created || []) {
      const ts = Date.parse(b.block_timestamp) || 0;
      const h = Number(b.block_height) || start;
      (b.events || []).forEach((e, n) => {
        try { evs.push({ h, n, ts, kind: "available", d: decodeEventPayload(e.payload) }); } catch { /* malformed: skip */ }
      });
    }
    for (const b of completed || []) {
      const ts = Date.parse(b.block_timestamp) || 0;
      const h = Number(b.block_height) || start;
      (b.events || []).forEach((e, n) => {
        try { evs.push({ h, n, ts, kind: "completed", d: decodeEventPayload(e.payload) }); } catch { /* malformed: skip */ }
      });
    }
    perWindow[i] = evs;
    done++;
    if (onProgress) onProgress(done, windows.length);
  });
  const events = perWindow.flat().sort((a, b) => (a.h - b.h) || (a.kind === b.kind ? a.n - b.n : (a.kind === "available" ? -1 : 1)));
  const accepted = [];
  let added = 0, removed = 0;
  for (const ev of events) {
    const d = ev.d;
    if (ev.kind === "available") {
      if (d.offerAddress) buyers.add(d.offerAddress);
      if (d.offerId == null) continue;
      const o = offerFromEvent(d, ev.ts);
      if (state.created) state.created[o.offerId] = ev.ts;
      if (addOffer(book, o, idx)) added++;
    } else {
      if (d.offerId != null) {
        if (removeOffer(book, d.offerId, idx)) removed++;
        if (state.created) delete state.created[String(d.offerId)];
      }
      if (d.purchased === true) accepted.push(acceptedRowFromEvent(d, ev.ts));
    }
  }
  state.buyers = [...buyers];
  accepted.sort((a, b) => b[0] - a[0]);
  return { accepted, added, removed, windows: windows.length };
}

// ---- accepted history ---------------------------------------------------

const rowKey = (r) => r.join("|");

/** Newest-first merge of accepted rows, deduped on the whole row */
export function mergeAccepted(existing, incoming, cap = Infinity) {
  const seen = new Set();
  const out = [];
  for (const r of [...(incoming || []), ...(existing || [])]) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => b[0] - a[0]);
  if (out.length > cap) out.length = cap;
  return out;
}

/** Accepted rows grouped by the month they happened in */
export function shardRows(rows) {
  const byMonth = {};
  for (const r of rows || []) (byMonth[monthOf(r[0])] = byMonth[monthOf(r[0])] || []).push(r);
  return byMonth;
}

/** Totals plus buyer/seller leader boards (by value and by count) */
export function acceptedAgg(rows) {
  const buyers = new Map();
  const sellers = new Map();
  let value = 0;
  const bump = (map, addr, amount) => {
    if (!addr) return;
    const cur = map.get(addr) || [0, 0];
    cur[0]++;
    cur[1] += amount;
    map.set(addr, cur);
  };
  for (const [, , amount, buyer, seller] of rows) {
    value += amount;
    bump(buyers, buyer, amount);
    bump(sellers, seller, amount);
  }
  const board = (map, idx) => [...map.entries()]
    .map(([addr, [count, val]]) => [addr, count, Math.round(val * 100) / 100])
    .sort((a, b) => (b[idx] - a[idx]) || (b[idx === 1 ? 2 : 1] - a[idx === 1 ? 2 : 1]))
    .slice(0, 100);
  return {
    count: rows.length,
    value: Math.round(value * 100) / 100,
    buyers: board(buyers, 2),
    sellers: board(sellers, 2),
    buyersByCount: board(buyers, 1),
    sellersByCount: board(sellers, 1)
  };
}

/** { all, topshot, byColl } over the retained accepted history */
export function acceptedStats(rows) {
  const byColl = {};
  for (const r of rows) (byColl[r[1]] = byColl[r[1]] || []).push(r);
  const stats = Object.fromEntries(Object.entries(byColl).map(([c, list]) => [c, acceptedAgg(list)]));
  return { all: acceptedAgg(rows), topshot: stats.TopShot || acceptedAgg([]), byColl: stats };
}

// ---- serialization -------------------------------------------------------

/** The bucket objects for a book + state at `height` (time in ms) */
export function bakeObjects(book, state, { height, time, fetchedAt = Date.now() }) {
  const counts = bookCounts(book);
  const meta = {
    format: BOOK_FORMAT,
    fetchedAt,
    height,
    time: time || null,
    // The base: when the book was last verified against every buyer's
    // live collection (the deploy-time re-base)
    rebasedAt: state.rebasedAt || 0,
    rebasedHeight: state.rebasedHeight || 0,
    // The buyer-discovery window: offer events folded since this height
    scannedFromHeight: state.firstHeight || null,
    scannedToHeight: height
  };
  return {
    [BOOK_KEY]: { ...meta, buyers: (state.buyers || []).length, ...counts, offers: book.offers },
    [OTHER_KEY]: { ...meta, other: book.other, purchasedInBooks: book.purchasedInBooks },
    [STATS_KEY]: { ...meta, acceptedStats: acceptedStats(state.accepted || []), accepted: (state.accepted || []).slice(0, ACCEPTED_FEED_CAP) }
  };
}

/** Rebuilds the in-memory book from the bucket objects (other is optional) */
export function bookFromObjects(bookObj, otherObj) {
  const book = emptyBook();
  if (!bookObj || !bookObj.offers) return null;
  book.height = Number(bookObj.height) || 0;
  book.time = bookObj.time || null;
  book.offers = { edition: bookObj.offers.edition || {}, subedition: bookObj.offers.subedition || {}, nft: bookObj.offers.nft || {} };
  book.other = (otherObj && otherObj.other) || [];
  book.purchasedInBooks = (otherObj && otherObj.purchasedInBooks) || [];
  return book;
}

/**
 * The page-facing snapshot: the shape src/pages/Offers.jsx has always
 * read (offers, other, purchasedInBooks, accepted, acceptedStats, the
 * headline counts and the watch window), assembled from the objects
 */
export function snapshotFrom(bookObj, otherObj, statsObj) {
  const counts = bookObj.totalOffers !== undefined ? {} : bookCounts(bookFromObjects(bookObj, otherObj));
  return {
    ...bookObj,
    ...counts,
    other: (otherObj && otherObj.other) || [],
    purchasedInBooks: (otherObj && otherObj.purchasedInBooks) || [],
    accepted: (statsObj && statsObj.accepted) || [],
    acceptedStats: (statsObj && statsObj.acceptedStats) || acceptedStats([])
  };
}
