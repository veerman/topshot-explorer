/*
 * The offers book for the Offers page. Three sources, best first:
 *   1. the published book in the cache bucket (offers/book.json plus
 *      other.json and stats.json), refreshed every half hour by the
 *      Worker cron (deploy/cloudflare/worker.js);
 *   2. then, in this browser, a catch-up fold of the offer events between
 *      the published height and the sealed block (offers.core.js), so the
 *      page reads as of now rather than as of the last cron run;
 *   3. failing the bucket (no VITE_MEDIA_BASE, offline, a portable
 *      build), the snapshot bundled at deploy time by `npm run offers`.
 * Optional everywhere: pages degrade to "no offer data" without any of it.
 *
 * Snapshot shape (unchanged for the page): { fetchedAt, height, buyers,
 * topshotBuyers, totalOffers, offers: { edition, subedition, nft },
 * other, purchasedInBooks, accepted, acceptedStats, scannedFrom/To... }
 * plus `source` ("bucket" | "bundled") and `caughtUp` ({ from, height,
 * windows, added, removed } when the browser fold ran, null otherwise).
 */
import { MEDIA_BASE } from "./media.service";
import { getSealedHeight, MAX_EVENT_SPAN, TOPSHOT_NFT_TYPE } from "./flowEvents.service";
import {
  bookFromObjects, foldEvents, snapshotFrom, mergeAccepted, bookCounts,
  BOOK_KEY, OTHER_KEY, STATS_KEY, ACCEPTED_FEED_CAP
} from "./offers.core";

// The browser catches up at most this many event windows (~6 hours of
// blocks); a bigger gap means the cron is down, and the published book
// stands as is rather than costing every visitor a long scan
const MAX_CATCHUP_WINDOWS = 120;
const CATCHUP_CONCURRENCY = 6;

let snapshotPromise = null;

// The ?v= content hash (baked at build time) makes each bundled
// snapshot's URL unique, so the immutable /seed/* cache rule applies
const BUNDLED_URL = `/seed/topshot-offers.json?v=${typeof __OFFERS_VERSION__ !== "undefined" ? __OFFERS_VERSION__ : "0"}`;

const bucketUrl = (key) => (MEDIA_BASE ? `${MEDIA_BASE}/${key}` : null);

async function fetchJson(url, init) {
  if (!url) return null;
  try {
    const res = await fetch(url, init);
    // The SPA fallback answers missing assets with 200 HTML, so the
    // content type is the real existence check
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadPublished() {
  const [book, other, stats] = await Promise.all([
    fetchJson(bucketUrl(BOOK_KEY), { cache: "no-cache" }),
    fetchJson(bucketUrl(OTHER_KEY), { cache: "no-cache" }),
    fetchJson(bucketUrl(STATS_KEY), { cache: "no-cache" })
  ]);
  if (!book || !book.offers) return null;
  return { ...snapshotFrom(book, other, stats), source: "bucket" };
}

async function loadBundled() {
  const snap = await fetchJson(BUNDLED_URL);
  return snap && snap.offers ? { ...snap, source: "bundled" } : null;
}

// Folds the events since the snapshot's height onto it, in place of the
// page waiting for the next cron run
async function catchUp(snap) {
  const base = Number(snap.height || snap.scannedToHeight) || 0;
  if (!base) return { ...snap, caughtUp: null };
  let tip;
  try { tip = await getSealedHeight(); } catch { return { ...snap, caughtUp: null }; }
  if (tip <= base) return { ...snap, caughtUp: { from: base, height: base, windows: 0, added: 0, removed: 0 } };
  const gap = Math.ceil((tip - base) / MAX_EVENT_SPAN);
  if (gap > MAX_CATCHUP_WINDOWS) return { ...snap, caughtUp: null, behindWindows: gap };
  const book = bookFromObjects(snap, snap);
  const state = { buyers: [], created: null };
  let r;
  try {
    r = await foldEvents(book, state, base + 1, tip, { concurrency: CATCHUP_CONCURRENCY });
  } catch {
    return { ...snap, caughtUp: null };
  }
  const accepted = mergeAccepted(snap.accepted, r.accepted, ACCEPTED_FEED_CAP);
  // The published aggregates cover the retained history; only the counts
  // move for the few minutes folded here
  const stats = snap.acceptedStats ? JSON.parse(JSON.stringify(snap.acceptedStats)) : null;
  if (stats) {
    const topshot = r.accepted.filter((row) => row[1] === "TopShot").length;
    if (stats.all) stats.all.count += r.accepted.length;
    if (stats.topshot) stats.topshot.count += topshot;
  }
  return {
    ...snap,
    offers: book.offers,
    other: book.other,
    purchasedInBooks: book.purchasedInBooks,
    accepted,
    acceptedStats: stats || snap.acceptedStats,
    ...bookCounts(book),
    height: tip,
    scannedToHeight: tip,
    scannedToTime: new Date().toISOString(),
    fetchedAt: Date.now(),
    caughtUp: { from: base, height: tip, windows: r.windows, added: r.added, removed: r.removed }
  };
}

export function loadOffersSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = (async () => {
      const published = await loadPublished();
      const snap = published || await loadBundled();
      if (!snap) return null;
      return catchUp(snap);
    })().catch(() => null);
  }
  return snapshotPromise;
}

export const formatOfferAmount = (amount) =>
  `$${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export { TOPSHOT_NFT_TYPE };
