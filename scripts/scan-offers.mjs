/*
 * Dapper marketplace offers: the deploy-time verify-and-rebase step
 * (npm run offers). The book itself lives in the cache bucket under
 * offers/ and is kept current by the Worker cron fold (see
 * src/services/offers.core.js for the design and the object layout).
 * This script closes the loop from the developer's machine, where the
 * expensive work is free:
 *
 * 1. Download the cron's current book and state from the bucket (or,
 *    on a bootstrap, start from an event backfill of --days).
 * 2. Fold the offer events since its height, exactly as the cron does.
 * 3. VERIFY: read every known buyer's live offer collection (the
 *    proven two-phase pattern: the id list, then details for ids never
 *    seen) and rebuild the book from the truth. Offer details are
 *    immutable, so only new ids cost a details call.
 * 4. Write the bundled fallback (public/seed/topshot-offers.json, the
 *    page-facing snapshot shape) and re-base the bucket: book, other,
 *    stats, state and any monthly accepted-offer shards this run touched.
 *    The cron resumes from the new base; folding is idempotent per offer
 *    id, so a run it made meanwhile is simply re-applied.
 *
 * Usage:
 *   npm run offers                       verify against the bucket and re-base it
 *   npm run offers -- --no-upload        same, but leave the bucket alone
 *   npm run offers -- --local            ignore the bucket both ways (portable builds)
 *   npm run offers -- --skip-verify      fold only (no buyer enumeration)
 *   npm run offers -- --days 7           bootstrap backfill when no base exists
 *
 * Offers (DapperOffersV2/OffersV2 at 0xb8ea91944fd51c43) live in each
 * BUYER's account; there is no on-chain index by target moment or owner,
 * and offers never expire. OfferAvailable events reveal WHO makes offers;
 * a buyer whose last offer predates every folded window stays invisible
 * until they touch an offer again, so the registry converges over time.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import * as fcl from "@onflow/fcl";
import { restBase, getSealedHeight } from "../src/services/flowEvents.service.js";
import {
  emptyBook, emptyState, bookFromObjects, indexBook, addOffer, foldEvents, blockTimeMs,
  mergeAccepted, shardRows, bakeObjects, acceptedStats, bookCounts, collectionOf,
  BOOK_KEY, OTHER_KEY, STATS_KEY, STATE_KEY, shardKey, BOOK_FORMAT, ACCEPTED_STATE_CAP, ACCEPTED_FEED_CAP, runPool
} from "../src/services/offers.core.js";
import { ROOT } from "./lib/paths.mjs";
import { flag, num } from "./lib/args.mjs";
import { withRetries } from "./lib/retry.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const BUCKET = "topshot-explorer-cache";
const BASE_URL = process.env.OFFERS_BASE_URL || "https://cache.topshotexplorer.com";
// Local mirrors of the bucket objects (working data, outside public/ so
// deploys never ship them); the bundled fallback is the only public file
const MIRROR_DIR = join(ROOT, "scratch", "offers");
const OUT_PATH = join(ROOT, "public", "seed", "topshot-offers.json");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const LOCAL = flag("--local");
const UPLOAD = !LOCAL && !flag("--no-upload");
const VERIFY = !flag("--skip-verify");
const BACKFILL_DAYS = num("--days", 7) || 7;
const BLOCKS_PER_DAY = 118000; // upper bound
const FOLD_CONCURRENCY = 6;
const ENUM_CONCURRENCY = 4;
const DETAIL_CHUNK = 5000;
const RETRY = { attempts: 5, backoffMs: 1000 };

fcl.config({ "accessNode.api": restBase() });

// ---- sources -------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const mirrorPath = (key) => join(MIRROR_DIR, key.replace(/^offers\//, ""));
const readMirror = (key) => {
  try { return JSON.parse(readFileSync(mirrorPath(key), "utf8")); } catch { return null; }
};

/** The base to fold from: bucket first, then the local mirror, else null */
async function loadBase() {
  if (!LOCAL) {
    try {
      const [state, bookObj, otherObj] = await Promise.all([
        fetchJson(`${BASE_URL}/${STATE_KEY}`), fetchJson(`${BASE_URL}/${BOOK_KEY}`), fetchJson(`${BASE_URL}/${OTHER_KEY}`)
      ]);
      if (state && bookObj && state.format === BOOK_FORMAT) {
        console.log(`base: bucket book at height ${bookObj.height} (${bookObj.time || "no time"}), ${state.buyers.length} buyers known`);
        return { state, book: bookFromObjects(bookObj, otherObj), from: "bucket" };
      }
    } catch (err) {
      console.log(`bucket unreachable (${err.message}); trying the local mirror`);
    }
  }
  const state = readMirror(STATE_KEY);
  const bookObj = readMirror(BOOK_KEY);
  if (state && bookObj && state.format === BOOK_FORMAT) {
    console.log(`base: local mirror at height ${bookObj.height}, ${state.buyers.length} buyers known`);
    return { state, book: bookFromObjects(bookObj, readMirror(OTHER_KEY)), from: "mirror" };
  }
  return null;
}

// ---- verification: every buyer's live book ---------------------------------

const IDS_CADENCE = `
import DapperOffersV2 from 0xb8ea91944fd51c43

access(all) fun main(address: Address): [UInt64] {
  if let ref = getAccount(address).capabilities.borrow<&{DapperOffersV2.DapperOfferPublic}>(DapperOffersV2.DapperOffersPublicPath) {
    return ref.getOfferIds()
  }
  return []
}
`;

const DETAILS_CADENCE = `
import OffersV2 from 0xb8ea91944fd51c43
import DapperOffersV2 from 0xb8ea91944fd51c43

access(all) fun main(address: Address, ids: [UInt64]): [[String]] {
  let out: [[String]] = []
  if let ref = getAccount(address).capabilities.borrow<&{DapperOffersV2.DapperOfferPublic}>(DapperOffersV2.DapperOffersPublicPath) {
    for offerId in ids {
      if let offer = ref.borrowOffer(offerId: offerId) {
        let d = offer.getDetails()
        let p = d.offerParamsString
        var blob = ""
        if d.nftType.identifier != "A.0b2a3299cc857e29.TopShot.NFT" {
          for k in p.keys {
            if k == "_type" || k == "typeId" || k == "resolver" { continue }
            if blob.length > 0 { blob = blob.concat(" · ") }
            blob = blob.concat(k).concat("=").concat(p[k] ?? "")
          }
        }
        out.append([
          offerId.toString(),
          d.offerAmount.toString(),
          p["_type"] ?? "",
          p["setId"] ?? "",
          p["playId"] ?? "",
          p["subeditionId"] ?? "",
          p["nftId"] ?? "",
          d.purchased ? "1" : "0",
          d.nftType.identifier,
          blob
        ])
      }
    }
  }
  return out
}
`;

/**
 * Reads every known buyer's offer collection and rebuilds the book from
 * it. `known` (offerId -> record) supplies details for ids the fold
 * already holds, so only never-seen ids cost a details call. Returns the
 * verified book plus what changed against the folded one.
 */
async function verify(foldedBook, state) {
  // Everything the folded book knows, by id, so verification can reuse it
  const known = new Map();
  for (const bucket of ["edition", "subedition", "nft"]) {
    for (const [key, list] of Object.entries(foldedBook.offers[bucket])) {
      const [setId, playId, subId] = key.split("_");
      for (const [amount, buyer, offerId, createdAt] of list) {
        const level = bucket === "nft" ? "NFT" : bucket === "subedition" ? "TopShotSubedition" : "TopShotEdition";
        known.set(String(offerId), { buyer, offerId: String(offerId), amount, level, setId: bucket === "nft" ? "" : setId, playId: bucket === "nft" ? "" : playId, subId: bucket === "subedition" ? subId : "", nftId: bucket === "nft" ? key : "", purchased: 0, collection: "TopShot", blob: "", createdAt });
      }
    }
  }
  for (const [collection, amount, buyer, offerId, createdAt, level, blob] of foldedBook.other) {
    known.set(String(offerId), { buyer, offerId: String(offerId), amount, level, setId: "", playId: "", subId: "", nftId: "", purchased: 0, collection, blob, createdAt });
  }
  for (const [collection, amount, buyer, offerId, level, setId, playId, subId, nftId, blob, createdAt] of foldedBook.purchasedInBooks) {
    known.set(String(offerId), { buyer, offerId: String(offerId), amount, level, setId, playId, subId, nftId, purchased: 1, collection, blob, createdAt });
  }
  const createdAt = (id) => (known.get(id) || {}).createdAt || state.created[id] || 0;

  const verified = emptyBook();
  const idx = indexBook(verified);
  const buyers = state.buyers;
  let done = 0, failed = 0, detailCalls = 0, liveOffers = 0;
  const liveIds = new Set();
  await runPool(buyers, ENUM_CONCURRENCY, async (buyer) => {
    try {
      const ids = (await fcl.query({ cadence: IDS_CADENCE, args: (arg, t) => [arg(buyer, t.Address)] })).map(String);
      const fresh = ids.filter((id) => !known.has(id));
      for (let i = 0; i < fresh.length; i += DETAIL_CHUNK) {
        const chunk = fresh.slice(i, i + DETAIL_CHUNK);
        const rows = await fcl.query({ cadence: DETAILS_CADENCE, args: (arg, t) => [arg(buyer, t.Address), arg(chunk, t.Array(t.UInt64))] });
        detailCalls++;
        for (const [offerId, amount, level, setId, playId, subId, nftId, purchased, nftType, blob] of rows) {
          known.set(String(offerId), { buyer, offerId: String(offerId), amount: Number(amount), level, setId, playId, subId, nftId, purchased: Number(purchased), collection: collectionOf(nftType) || "TopShot", blob, createdAt: createdAt(String(offerId)) });
        }
      }
      for (const id of ids) {
        const o = known.get(id);
        if (!o) continue; // the chain listed it but would not borrow it
        liveIds.add(id);
        liveOffers++;
        addOffer(verified, { ...o, buyer, createdAt: createdAt(id) }, idx);
      }
    } catch {
      failed++;
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${buyers.length} buyers`);
  });
  // Creation times only matter for offers still standing
  for (const id of Object.keys(state.created)) if (!liveIds.has(id)) delete state.created[id];
  for (const id of liveIds) if (!state.created[id] && createdAt(id)) state.created[id] = createdAt(id);

  // Drift: what the fold had that the chain does not, and the reverse
  const foldedIds = new Set(known.keys());
  let missing = 0, extra = 0;
  for (const id of liveIds) if (!foldedIds.has(id)) missing++;
  const foldedLive = indexBook(foldedBook);
  for (const id of foldedLive.keys()) if (!liveIds.has(id)) extra++;
  console.log(`verify done: ${liveOffers} live offers in ${buyers.length} buyers' books (${failed} unreadable, ${detailCalls} detail calls); drift vs fold: ${missing} unseen by the fold, ${extra} gone from the chain`);
  return verified;
}

// ---- upload ------------------------------------------------------------------

const wrangler = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [WRANGLER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out.slice(-300)))));
});

async function putObject(key, obj, cacheControl) {
  const file = mirrorPath(key);
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, obj);
  if (!UPLOAD) return;
  await withRetries(
    () => wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", "application/json", "--cache-control", cacheControl, "--remote"]),
    `put ${key}`,
    { attempts: 3, backoffMs: 2000 }
  );
  console.log(`  uploaded ${key}`);
}

// ---- main ---------------------------------------------------------------------

async function main() {
  if (UPLOAD && !existsSync(WRANGLER)) { console.error("wrangler not installed (or pass --no-upload)"); process.exit(1); }
  const tip = await withRetries(() => getSealedHeight(), "sealed height", RETRY);

  let base = await loadBase();
  if (!base) {
    const from = Math.max(0, tip - BACKFILL_DAYS * BLOCKS_PER_DAY);
    console.log(`no base anywhere: bootstrapping from an event backfill of ${BACKFILL_DAYS} days (heights ${from}..${tip})`);
    const state = emptyState();
    state.height = from - 1;
    state.firstHeight = from;
    base = { state, book: emptyBook(), from: "bootstrap" };
  }
  const { state, book } = base;
  if (!state.firstHeight) state.firstHeight = state.height + 1;

  // 1. Fold the events since the base, exactly as the cron does
  const from = state.height + 1;
  const touchedShards = {};
  if (from <= tip) {
    console.log(`fold: heights ${from}..${tip} (~${((tip - from) / BLOCKS_PER_DAY).toFixed(2)} days)`);
    const r = await foldEvents(book, state, from, tip, {
      concurrency: FOLD_CONCURRENCY,
      onProgress: (d, n) => { if (d % 250 === 0) console.log(`  ${d}/${n} windows`); }
    });
    state.accepted = mergeAccepted(state.accepted, r.accepted, ACCEPTED_STATE_CAP);
    Object.assign(touchedShards, shardRows(r.accepted));
    console.log(`fold done: +${r.added} -${r.removed} offers, ${r.accepted.length} accepted, ${state.buyers.length} buyers known`);
  } else {
    console.log("fold: nothing newer than the base");
  }

  // 2. Verify against the chain and rebuild the book from the truth
  let finalBook = book;
  if (VERIFY) {
    console.log(`verify: reading ${state.buyers.length} buyers' live offer collections...`);
    finalBook = await verify(book, state);
    state.rebasedAt = Date.now();
    state.rebasedHeight = tip;
  }
  state.height = tip;
  state.format = BOOK_FORMAT;

  // 3. Bake: bucket objects, the bundled fallback, the shards
  const timeMs = await blockTimeMs(tip);
  const time = timeMs ? new Date(timeMs).toISOString() : null;
  const objects = bakeObjects(finalBook, state, { height: tip, time });
  const fromTimeMs = state.firstHeight ? await blockTimeMs(state.firstHeight) : 0;
  const bundled = {
    ...objects[BOOK_KEY],
    scannedFromTime: fromTimeMs ? new Date(fromTimeMs).toISOString() : null,
    scannedToTime: time,
    other: finalBook.other,
    purchasedInBooks: finalBook.purchasedInBooks,
    accepted: state.accepted.slice(0, ACCEPTED_FEED_CAP),
    acceptedStats: acceptedStats(state.accepted)
  };
  writeJsonAtomic(OUT_PATH, bundled);
  const counts = bookCounts(finalBook);
  console.log(`wrote ${OUT_PATH}: ${counts.totalOffers} active Top Shot offers from ${counts.topshotBuyers} buyers, ${counts.totalOtherOffers} on other collections, ${bundled.accepted.length} accepted in the feed`);

  console.log(UPLOAD ? `re-basing ${BUCKET}/${"offers"}/...` : "writing local mirrors only");
  await putObject(BOOK_KEY, objects[BOOK_KEY], "public, max-age=120");
  await putObject(OTHER_KEY, objects[OTHER_KEY], "public, max-age=120");
  await putObject(STATS_KEY, objects[STATS_KEY], "public, max-age=120");
  for (const [month, rows] of Object.entries(touchedShards)) {
    let existing = null;
    if (!LOCAL) { try { existing = await fetchJson(`${BASE_URL}/${shardKey(month)}`); } catch { /* keep going with the mirror */ } }
    if (!existing) existing = readMirror(shardKey(month)) || { month, rows: [] };
    existing.rows = mergeAccepted(existing.rows, rows);
    existing.updatedAt = Date.now();
    await putObject(shardKey(month), existing, "public, max-age=3600");
  }
  // State last: the cron resumes from this height only once the book it
  // matches is published
  await putObject(STATE_KEY, state, "no-store");
  console.log(`done: base at height ${tip}${time ? ` (${time})` : ""}; the cron folds forward from here`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
