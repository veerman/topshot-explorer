// Live Flow event access for the Marketplace stream. Plain REST, no FCL:
// the events endpoint is a simple GET and decoding the JSON-Cadence
// payloads ourselves keeps this importable anywhere.
//
// Same access-node knob as fcl.service: a deployment can point reads at a
// same-origin proxy (deploy/cloudflare passes GET /flow/* straight
// through), the default build talks to Flow directly.

export const restBase = () =>
  (typeof import.meta.env !== "undefined" && import.meta.env.VITE_FLOW_ACCESS_NODE) ||
  "https://rest-mainnet.onflow.org";

// The REST API caps an events range at 250 heights per request.
export const MAX_EVENT_SPAN = 250;

async function getJson(path) {
  const res = await fetch(restBase() + path);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) msg = body.message;
    } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  return res.json();
}

/** Height of the latest sealed block. */
export async function getSealedHeight() {
  const data = await getJson("/v1/blocks?height=sealed");
  const h = data && data[0] && data[0].header && data[0].header.height;
  if (!h) throw new Error("no sealed block returned");
  return parseInt(h, 10);
}

/**
 * All events of one type in a height range (inclusive, max 250 heights).
 * Returns the raw REST shape: a list of blocks, each carrying its events
 * with base64 JSON-Cadence payloads.
 */
export async function getEvents(type, startHeight, endHeight) {
  return getJson(
    `/v1/events?type=${encodeURIComponent(type)}&start_height=${startHeight}&end_height=${endHeight}`
  );
}

// ---------- JSON-Cadence decoding ----------

const SMALL_INTS = new Set([
  "Int", "Int8", "Int16", "Int32", "Int64",
  "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
  "Word8", "Word16", "Word32", "Word64"
]);

/**
 * A JSON-Cadence value tree to plain JS. Integers become Numbers when they
 * fit safely and stay strings otherwise; UFix64 stays a string so no
 * precision is invented; Type values collapse to their type ID.
 */
export function decodeCadence(node) {
  if (node === null || node === undefined) return null;
  const { type, value } = node;
  switch (type) {
    case "Optional":
      return value === null ? null : decodeCadence(value);
    case "Bool":
      return value === true || value === "true";
    case "String":
    case "Character":
    case "Address":
    case "Path":
      return value;
    case "UFix64":
    case "Fix64":
      return value;
    case "Array":
      return (value || []).map(decodeCadence);
    case "Dictionary": {
      const out = {};
      for (const entry of value || []) {
        out[String(decodeCadence(entry.key))] = decodeCadence(entry.value);
      }
      return out;
    }
    case "Event":
    case "Struct":
    case "Resource":
    case "Enum": {
      const out = {};
      for (const f of (value && value.fields) || []) {
        out[f.name] = decodeCadence(f.value);
      }
      return out;
    }
    case "Type": {
      const st = value && value.staticType;
      if (typeof st === "string") return st;
      return (st && st.typeID) || null;
    }
    default:
      if (SMALL_INTS.has(type) || type === "Int128" || type === "Int256" || type === "UInt128" || type === "UInt256") {
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : value;
      }
      return value;
  }
}

/** Decode one REST event's base64 payload to a flat {field: value} object. */
export function decodeEventPayload(payloadB64) {
  try {
    const parsed = JSON.parse(atob(payloadB64));
    const decoded = decodeCadence(parsed);
    return decoded && typeof decoded === "object" ? decoded : {};
  } catch {
    return {};
  }
}

/**
 * Every TopShot moment moved during a transaction: deposits as [{id, to}]
 * plus the account the withdrawals came from. Also every NFT of ANY
 * collection that moved, from the standard NonFungibleToken.Withdrawn and
 * Deposited events, as `nfts` [{type, id, from, to}], so a storefront
 * sale of another collection's NFT names its seller and buyer from the
 * same single request. A pack-opening transaction
 * deposits each pulled moment into the opener's collection (the deposits
 * ARE the pack's contents) and withdraws them from Dapper's escrow (the
 * `from`).
 *
 * Cached per transaction: a batch tx can put 50+ moments on screen and
 * every one of them asks about the SAME transaction, so the in-flight
 * promise is shared (a failure evicts itself and the next call retries).
 */
const txMovesCache = new Map();
const TX_MOVES_CACHE_MAX = 500;

export function getTxTopShotMoves(txId) {
  let p = txMovesCache.get(txId);
  if (!p) {
    p = fetchTxTopShotMoves(txId);
    p.catch(() => txMovesCache.delete(txId));
    if (txMovesCache.size >= TX_MOVES_CACHE_MAX) {
      txMovesCache.delete(txMovesCache.keys().next().value);
    }
    txMovesCache.set(txId, p);
  }
  return p;
}

const NFT_WITHDRAWN = "A.1d7e57aa55817448.NonFungibleToken.Withdrawn";
const NFT_DEPOSITED = "A.1d7e57aa55817448.NonFungibleToken.Deposited";

async function fetchTxTopShotMoves(txId) {
  const data = await getJson(`/v1/transaction_results/${txId}`);
  const deposits = [];
  let from = null;
  // Generic moves keyed by "type:id"; a withdraw and a deposit of the
  // same NFT fold into one {from, to}
  const nftsByKey = new Map();
  const nftMove = (d) => {
    if (!d.type || d.id === undefined || d.id === null) return null;
    const key = `${d.type}:${d.id}`;
    let m = nftsByKey.get(key);
    if (!m) {
      m = { type: d.type, id: Number(d.id), from: null, to: null };
      nftsByKey.set(key, m);
    }
    return m;
  };
  for (const e of (data && data.events) || []) {
    if (e.type === "A.0b2a3299cc857e29.TopShot.Deposit") {
      const d = decodeEventPayload(e.payload);
      if (d.id !== undefined && d.to) deposits.push({ id: Number(d.id), to: d.to });
    } else if (e.type === "A.0b2a3299cc857e29.TopShot.Withdraw") {
      const d = decodeEventPayload(e.payload);
      if (!from && d.from) from = d.from;
    } else if (e.type === NFT_WITHDRAWN) {
      const d = decodeEventPayload(e.payload);
      const m = nftMove(d);
      if (m && d.from && !m.from) m.from = d.from;
    } else if (e.type === NFT_DEPOSITED) {
      const d = decodeEventPayload(e.payload);
      const m = nftMove(d);
      if (m && d.to) m.to = d.to;
    }
  }
  return { deposits, from, nfts: [...nftsByKey.values()] };
}

/**
 * Who signed a transaction: authorizers first (the acting account; on
 * Dapper custodial transactions the payer is Dapper), then the payer.
 * A delisting names no address in its event, but the storefront owner
 * had to authorize the transaction, so the signers reveal them.
 */
export async function getTxSigners(txId) {
  const data = await getJson(`/v1/transactions/${txId}`);
  const out = [];
  for (const a of (data && data.authorizers) || []) out.push(a);
  if (data && data.payer) out.push(data.payer);
  return out;
}

// ---------- event catalogue ----------

export const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT";
export const PACK_NFT_TYPE = "A.0b2a3299cc857e29.PackNFT.NFT";

// ---------- external collection sites ----------
// Pure link-outs by NFT type, never fetched: the app must keep working
// if these vendors disappear (core constraint), so a dead domain only
// costs the visitor a 404 in a new tab.
const EXTERNAL_NFT_SITES = {
  [TOPSHOT_NFT_TYPE]: (id) => `https://nbatopshot.com/moment/${id}?tab=details`,
  "A.edf9df96c92f4595.Pinnacle.NFT": (id) => `https://disneypinnacle.com/pin/${id}`,
  "A.e4cf4bdc1751c65d.AllDay.NFT": (id) => `https://nflallday.com/moments/${id}`,
  "A.87ca73a41bb50ad5.Golazos.NFT": (id) => `https://laligagolazos.com/moments/${id}`,
  // MFL: player and club NFT ids double as their page ids; packs have no
  // per-id page on app.playmfl.com (probed 2026-09-03: /packs/<id> is a 404)
  "A.8ebcbfd516b1da27.MFLPlayer.NFT": (id) => `https://app.playmfl.com/players/${id}`,
  "A.8ebcbfd516b1da27.MFLClub.NFT": (id) => `https://app.playmfl.com/clubs/${id}`,
  // The pack NFT id IS the page id: the contract's ExternalURL
  // (nbatopshot.com/packnfts/<id>) now works (re-probed 2026-09-08 after
  // Dapper shipped the fix: the real id 302-redirects to the pack detail
  // page /pack/<packDetail>, a garbage id 404s, so it is a genuine
  // per-pack lookup, not a universal 200). Earlier this route 404'd for
  // everything, and packs fell back to the marketplace browse.
  [PACK_NFT_TYPE]: (id) => `https://nbatopshot.com/packnfts/${id}`
};

// dapper.market mirrors the same moment pages and works as a fallback if a
// vendor site retires; swap a template above to one of these to switch:
//   NBA    https://dapper.market/nba/moment/<id>
//   NFL    https://dapper.market/nfl/moment/<id>
//   LaLiga https://dapper.market/laliga/moment/<id>

/** Vendor page for one NFT, or null when the collection has no known site. */
export const externalNftUrl = (nftType, id) =>
  id === undefined || id === null ? null : EXTERNAL_NFT_SITES[nftType] ? EXTERNAL_NFT_SITES[nftType](id) : null;

// Same catalogue keyed by bare contract name ("AllDay", "MFLPlayer"), for
// data that only kept the name (the offers snapshot). PackNFT is excluded:
// several vendors deploy a contract literally named PackNFT, so the bare
// name cannot say WHOSE pack it is; only the typed lookup links packs.
const EXTERNAL_NFT_SITES_BY_NAME = Object.fromEntries(
  Object.entries(EXTERNAL_NFT_SITES)
    .filter(([type]) => type.split(".")[2] !== "PackNFT")
    .map(([type, fn]) => [type.split(".")[2], fn])
);

/** Vendor page by contract name, or null when unknown. */
export const externalNftUrlByName = (name, id) =>
  id === undefined || id === null || id === "" ? null : EXTERNAL_NFT_SITES_BY_NAME[name] ? EXTERNAL_NFT_SITES_BY_NAME[name](id) : null;

// Edition pages (not per-NFT): AllDay offers target an editionId, and the
// site resolves it at /listing/moment/<editionId>
// (backup: https://dapper.market/nfl/edition/<editionId>)
const EXTERNAL_EDITION_SITES_BY_NAME = {
  AllDay: (id) => `https://nflallday.com/listing/moment/${id}`
};

/** Vendor edition page by contract name, or null when unknown. */
export const externalEditionUrlByName = (name, id) =>
  id === undefined || id === null || id === "" ? null : EXTERNAL_EDITION_SITES_BY_NAME[name] ? EXTERNAL_EDITION_SITES_BY_NAME[name](id) : null;

// Every chip, grouped the way the toggles present them. kind picks the
// badge colour; defaultOn is the out-of-the-box selection (the marketplace
// generations that still see traffic).
// A chip's `key` is its identity (saved prefs, on/off state); it defaults
// to the event type, but ONE stream can back SEVERAL chips ("<type>#facet"
// keys): enabling any of them fetches the stream, the chips only decide
// which outcomes are shown. extra.sub: dimmed bracket text on the chip.
// extra.hint: appended to the chip tooltip.
const ev = (type, label, kind, defaultOn = false, extra = {}) => ({ type, label, kind, defaultOn, key: type, ...extra });

// Groups and chips are ordered by observed frequency, busiest first, from a
// 10 minute mainnet capture on 2026-09-03 (counts noted per chip below).
// Exception: Locking is pinned last regardless of rate.
export const EVENT_GROUPS = [
  {
    name: "Moments",
    note: "The TopShot contract itself: mints, transfers, burns",
    events: [
      ev("A.0b2a3299cc857e29.TopShot.Withdraw", "Withdraw", "core", true, {
        hint: "A Withdraw and Deposit of the same moment in one transaction show as a single Transfer row"
      }), // 60 per 10 min
      ev("A.0b2a3299cc857e29.TopShot.Deposit", "Deposit", "core", true, {
        hint: "A Withdraw and Deposit of the same moment in one transaction show as a single Transfer row"
      }), // 57
      ev("A.0b2a3299cc857e29.TopShot.MomentMinted", "Minted", "minted"), // 0 (mints come in rare bursts)
      ev("A.0b2a3299cc857e29.TopShot.MomentDestroyed", "Destroyed", "delisted") // 0
    ]
  },
  {
    name: "Storefront",
    note: "NFTStorefrontV2 at 0x4eb8a10cb9f87357, the generic listing contract newer sales ride on",
    events: [
      ev("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable", "Listing", "listed", true), // 53 per 10 min
      // ListingCompleted covers both outcomes; the payload's `purchased`
      // flag splits it into two chips over the one stream
      ev("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", "Sold", "purchased", true, {
        key: "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted#sold",
        hint: "Sold and Delisted share the ListingCompleted stream: either chip fetches it, the toggles only hide outcomes"
      }), // 45 for the stream (both outcomes)
      ev("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", "Delisted", "delisted", true, {
        key: "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted#delisted",
        hint: "Sold and Delisted share the ListingCompleted stream: either chip fetches it, the toggles only hide outcomes"
      })
    ]
  },
  // Top Shot Market (P2P) group retired 2026-09-03 alongside the older
  // legacy markets. TopShotMarketV3 at 0xc1e4f4f4c4257510 is in wind-down:
  // listings, sales and price changes all migrated to NFTStorefrontV2
  // (Listed / PriceChanged / Purchased measured 0 per 10 min), and its only
  // remaining traffic was MomentWithdrawn cleanup noise (47 per 10 min) as
  // Dapper scripts sweep stale no-expiry listings off its books.
  {
    name: "Offers",
    note: "OffersV2 at 0xb8ea91944fd51c43, Dapper's offer system",
    events: [
      ev("A.b8ea91944fd51c43.OffersV2.OfferAvailable", "Offer Made", "offer", true), // 13 per 10 min
      // OfferCompleted splits the same way ListingCompleted does
      ev("A.b8ea91944fd51c43.OffersV2.OfferCompleted", "Offer Accepted", "purchased", true, {
        key: "A.b8ea91944fd51c43.OffersV2.OfferCompleted#accepted",
        hint: "Offer Accepted and Offer Cancelled share the OfferCompleted stream: either chip fetches it, the toggles only hide outcomes"
      }), // 11 for the stream (both outcomes)
      ev("A.b8ea91944fd51c43.OffersV2.OfferCompleted", "Offer Cancelled", "delisted", true, {
        key: "A.b8ea91944fd51c43.OffersV2.OfferCompleted#cancelled",
        hint: "Offer Accepted and Offer Cancelled share the OfferCompleted stream: either chip fetches it, the toggles only hide outcomes"
      })
    ]
  },
  {
    name: "Packs",
    note: "PackNFT: pack mints, open requests and reveals",
    events: [
      // OpenRequest retired 2026-09-03: Opened tells the same story and
      // carries the pulls. Legacy markets (Market v1, TopShotMarketV2)
      // retired the same day: V2 is provably dead (zero usage) and v1's
      // own events are extinct even though Dapper scripts still import it
      ev("A.0b2a3299cc857e29.PackNFT.Opened", "Pack Opened", "purchased"), // 7 per 10 min
      ev("A.0b2a3299cc857e29.PackNFT.Minted", "Pack Minted", "minted") // 0 (mints come in drops)
    ]
  },
  {
    // Pinned to the bottom of the list on purpose (candidate for removal)
    // even though Locked outpaces offers and packs
    name: "Locking",
    note: "TopShotLocking: moments locked for rewards programs",
    events: [
      ev("A.0b2a3299cc857e29.TopShotLocking.MomentLocked", "Locked", "core"), // 14 per 10 min
      ev("A.0b2a3299cc857e29.TopShotLocking.MomentUnlocked", "Unlocked", "core") // 0
    ]
  }
];

/** Flat {chip key: def} index over the catalogue. */
export const EVENT_INDEX = (() => {
  const out = {};
  for (const g of EVENT_GROUPS) for (const e of g.events) out[e.key] = e;
  return out;
})();

/** The default-on chip KEYS (not necessarily distinct event types). */
export const DEFAULT_EVENT_TYPES = Object.values(EVENT_INDEX)
  .filter((e) => e.defaultOn)
  .map((e) => e.key);

// ---------- stream taxonomy ----------
// Pure functions over decoded event records ({ type, data }), moved here
// from the Live page: this is where every consumer of the catalogue above
// would look for them (the offers scanner shares the decode path too).

/** "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable" -> "NFTStorefrontV2.ListingAvailable" */
export const shortName = (type) => type.split(".").slice(2).join(".");

/** "A.0b2a3299cc857e29.TopShot.NFT" -> "TopShot" */
export const collectionOf = (nftType) => {
  const parts = String(nftType || "").split(".");
  return parts.length >= 3 ? parts[2] : String(nftType || "");
};

export const isTopShotType = (t) => String(t || "").startsWith("A.0b2a3299cc857e29.TopShot");

// A Withdraw and Deposit of the same moment in the same transaction is one
// transfer; the Live feed merges the surviving pairs into this pseudo-type
export const TRANSFER_TYPE = "transfer";
export const DEPOSIT_TYPE = "A.0b2a3299cc857e29.TopShot.Deposit";
export const WITHDRAW_TYPE = "A.0b2a3299cc857e29.TopShot.Withdraw";

/**
 * Which chip governs a record's visibility. For streams split into facet
 * chips the payload's outcome flag picks the chip; everything else is
 * governed by its event type directly.
 */
export function chipKeyOf(rec) {
  const n = shortName(rec.type);
  const purchased = rec.data && rec.data.purchased;
  if (n === "NFTStorefrontV2.ListingCompleted") return `${rec.type}#${purchased ? "sold" : "delisted"}`;
  if (n === "OffersV2.OfferCompleted") return `${rec.type}#${purchased ? "accepted" : "cancelled"}`;
  return rec.type;
}

/**
 * Which moment a primary event absorbs the mechanical Deposit/Withdraw
 * rows for, within its own transaction. A sale emits Sold + Withdraw +
 * Deposit; the Sold row tells the whole story, so the moves fold into it.
 * "*" absorbs every move in the transaction (pack openings).
 */
export function absorbedMomentId(rec) {
  const d = rec.data || {};
  const n = shortName(rec.type);
  if (n === "PackNFT.Opened") return "*";
  if (/^(?:Market|TopShotMarketV2|TopShotMarketV3)\.Moment/.test(n)) return d.id;
  if (n.startsWith("NFTStorefrontV2.")) return d.nftID;
  if (n.startsWith("OffersV2.")) return d.nftId;
  if (n === "TopShot.MomentMinted") return d.momentID;
  return null;
}

/**
 * A storefront sale or delist of ANOTHER collection's NFT names no
 * address in its payload, the same as a Top Shot one, but there is no
 * collection script to confirm a holder against. The transaction still
 * tells: a sale moved the NFT (NonFungibleToken.Withdrawn from the
 * seller, Deposited to the buyer), a delist was authorized by the
 * storefront's owner. Returns { txId, nftType, nftID, purchased } for
 * such a row, else null; Top Shot rows go through momentRefOf.
 */
export function partiesRefOf(rec) {
  const d = rec.data || {};
  if (shortName(rec.type) !== "NFTStorefrontV2.ListingCompleted") return null;
  if (!d.nftType || isTopShotType(d.nftType)) return null;
  if (d.nftID === undefined || d.nftID === null) return null;
  return { txId: rec.txId, nftType: d.nftType, nftID: Number(d.nftID), purchased: !!d.purchased };
}

/**
 * Which moment an event is about and who might currently hold it, for the
 * chain identity lookup. `owners` are candidate accounts whose public
 * collection may expose the moment; `txFallback` means the moment moved
 * during the transaction, so its Deposit event names the real holder.
 * Null when the event carries no resolvable moment (edition-level offers,
 * delist-only completions with no address, legacy sale collections).
 */
export function momentRefOf(rec) {
  const d = rec.data || {};
  if (rec.type === TRANSFER_TYPE) {
    return { momentID: Number(d.id), owners: [d.to, d.from], txFallback: false };
  }
  const n = shortName(rec.type);
  const m = n.match(/^(?:Market|TopShotMarketV2|TopShotMarketV3)\.Moment(Listed|PriceChanged|Purchased|Withdrawn)$/);
  if (m) {
    return {
      momentID: Number(d.id),
      owners: [d.seller, d.owner],
      txFallback: m[1] === "Purchased"
    };
  }
  if (n === "NFTStorefrontV2.ListingAvailable" && isTopShotType(d.nftType)) {
    return { momentID: Number(d.nftID), owners: [d.storefrontAddress], txFallback: false };
  }
  if (n === "NFTStorefrontV2.ListingCompleted" && isTopShotType(d.nftType)) {
    // Purchased: the Deposit event names the buyer. Delisted: nothing in
    // the payload, but the storefront owner signed the transaction
    return d.purchased
      ? { momentID: Number(d.nftID), owners: [], txFallback: true }
      : { momentID: Number(d.nftID), owners: [], authFallback: true };
  }
  if (n === "OffersV2.OfferCompleted" && isTopShotType(d.nftType) && d.purchased && d.nftId !== null && d.nftId !== undefined) {
    return { momentID: Number(d.nftId), owners: [d.offerAddress, d.acceptingAddress], txFallback: true };
  }
  if (n === "TopShot.Deposit" && d.to) {
    return { momentID: Number(d.id), owners: [d.to], txFallback: false };
  }
  if (n === "TopShot.Withdraw" && d.from) {
    return { momentID: Number(d.id), owners: [d.from], txFallback: true };
  }
  return null;
}

/** Badge label and colour kind, refined by the payload where one event covers two outcomes. */
export function badgeFor(rec) {
  if (rec.type === TRANSFER_TYPE) return { label: "Transfer", kind: "core" };
  const def = EVENT_INDEX[rec.type] || { label: shortName(rec.type), kind: "core" };
  const d = rec.data || {};
  const n = shortName(rec.type);
  if (n === "NFTStorefrontV2.ListingCompleted") {
    return d.purchased ? { label: "Sold", kind: "purchased" } : { label: "Delisted", kind: "delisted" };
  }
  if (n === "OffersV2.OfferCompleted") {
    return d.purchased ? { label: "Offer Accepted", kind: "purchased" } : { label: "Offer Cancelled", kind: "delisted" };
  }
  return { label: def.label, kind: def.kind };
}

// ---------- payment vaults ----------

// Known payment vault types. "$" means a dollar-pegged Dapper token
// (DUC and FUT both settle as USD in the Dapper wallet).
const VAULT_SYMBOLS = {
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault": "$",
  "A.ead892083b3e2c6c.FlowUtilityToken.Vault": "$",
  "A.1654653399040a61.FlowToken.Vault": "FLOW",
  "A.3c5959b568896393.FUSD.Vault": "FUSD",
  "A.b19436aae4d94622.FiatToken.Vault": "USDC"
};

/**
 * A UFix64 amount plus an optional vault type ID, formatted for a row.
 * TopShotMarketV3 prices carry no vault field: they are always DUC dollars.
 */
export function formatAmount(amount, vaultType) {
  const n = Number(amount);
  if (!isFinite(n)) return String(amount);
  // Whole amounts stay clean ($750), fractional ones keep both cents ($0.50)
  const text = Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = vaultType ? VAULT_SYMBOLS[vaultType] : "$";
  if (symbol === "$") return `$${text}`;
  if (symbol) return `${text} ${symbol}`;
  const tail = vaultType ? String(vaultType).split(".")[2] : "";
  return tail ? `${text} ${tail}` : text;
}
