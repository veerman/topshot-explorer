import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore, memo } from "react";
import { useUsernames, addressTitle } from "../services/usernames.service";
import { AddressName } from "../components/AddressName";
import { SignInNote } from "../components/SignInNote";
import { Link } from "react-router-dom";
import {
  getSealedHeight, getEvents, decodeEventPayload, formatAmount,
  getTxTopShotMoves, getTxSigners, externalNftUrl, TOPSHOT_NFT_TYPE, PACK_NFT_TYPE,
  EVENT_GROUPS, EVENT_INDEX, DEFAULT_EVENT_TYPES, MAX_EVENT_SPAN,
  shortName, collectionOf, isTopShotType, chipKeyOf, absorbedMomentId,
  momentRefOf, partiesRefOf, badgeFor, TRANSFER_TYPE, DEPOSIT_TYPE, WITHDRAW_TYPE
} from "../services/flowEvents.service";
import { getAllPlaysDB, getAllSetsDB } from "../services/db.service";
import { getMomentByOwner, getMomentsByOwner } from "../services/fcl.service";
import { formatAge } from "../utils/display.utils";
import { EditionCells } from "../components/MomentIdentity";
import { buildIdentityContext, EDITION_HEADINGS } from "../services/identity.service";
import { MultiSelect } from "../components/MultiSelect";

// Live marketplace stream: polls the Flow REST events endpoint for the
// selected event types every POLL_S seconds and accumulates the results
// in memory for the life of the page. Nothing here touches IndexedDB;
// this is a window onto the chain, not part of the local database.

const POLL_S = 10;
const MAX_STORE = 3000; // live events kept in memory before the oldest drop off
const MAX_ROWS = 250;   // rows rendered at once; "Older events" adds another page

const ENABLED_KEY = "mkt_event_types_v1";
// Retired 2026-09-07 (the "Top Shot only" checkbox); still read once so
// an old "show everything" choice migrates into the Collection facet
const TOPSHOT_ONLY_KEY = "mkt_topshot_only";
const COLLS_KEY = "mkt_colls_v1";

// Resolved identities and pack contents survive reloads: a moment's play,
// set and serial never change, so refetching them for the same rows after
// every reload was the main source of request bursts. Only successful
// resolutions persist; misses retry next session.
const MOMENT_CACHE_KEY = "mkt_moment_idcache_v1";
const PACK_CACHE_KEY = "mkt_pack_cache_v1";
const PARTY_CACHE_KEY = "mkt_party_cache_v1";
const MOMENT_CACHE_MAX = 3000;
const PACK_CACHE_MAX = 300;
const PARTY_CACHE_MAX = 500;

function loadStoredMap(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Map(arr) : null;
  } catch {
    return null;
  }
}

function storeMap(key, map, max) {
  try {
    localStorage.setItem(key, JSON.stringify([...map.entries()].slice(-max)));
  } catch { /* quota or private mode: reloads just refetch */ }
}

function loadEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (raw) {
      // Unknown entries (an older catalogue) are dropped; an empty saved
      // list is respected as "the user turned everything off". A saved
      // event type whose stream has since split into facet chips
      // ("<type>#outcome" keys) expands to all of that type's chips
      const keys = [];
      for (const t of JSON.parse(raw)) {
        if (EVENT_INDEX[t]) keys.push(t);
        else for (const e of Object.values(EVENT_INDEX)) if (e.type === t) keys.push(e.key);
      }
      return new Set(keys);
    }
  } catch { /* private mode etc. */ }
  return new Set(DEFAULT_EVENT_TYPES);
}

// The Collection facet scopes the feed (default: Top Shot alone; empty
// selection = every collection). Persisted like the checkbox it replaced;
// a saved unchecked checkbox migrates to "everything".
function loadCollFilter() {
  try {
    const raw = localStorage.getItem(COLLS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((v) => typeof v === "string");
    }
    if (localStorage.getItem(TOPSHOT_ONLY_KEY) === "0") return [];
  } catch { /* private mode */ }
  return ["TopShot"];
}

const withPrefix = (a) => (String(a).startsWith("0x") ? String(a) : `0x${a}`);

// Vaultopolis TSHOT: moments swap in and out of the TSHOT contract
// account's vault, so any transfer touching this address is a TSHOT swap
// leg (bulk dumps of 20+ moments at once are typically these). Detection
// is address-only: no extra requests.
const TSHOT_VAULT = "0x05b67ba314000b2d";
const TSHOT_SWAP_URL = "https://vaultopolis.com/swap";
const isTshotAddr = (a) => a !== null && a !== undefined && withPrefix(a) === TSHOT_VAULT;

// The event taxonomy (shortName, chipKeyOf, momentRefOf, badgeFor, the
// transfer pseudo-type, ...) lives in flowEvents.service next to the
// catalogue it interprets.

// A move's row folds into the primary event of the same transaction
const MOVE_TYPES = new Set([WITHDRAW_TYPE, DEPOSIT_TYPE]);

// Which collection a record concerns, for the Collection facet (same
// values as the Offers page facet: contract names). Storefront and offer
// events name the NFT's type; every other stream is a TopShot-family
// contract, so the stream itself decides (PackNFT stays its own
// collection, matching how pack offers read on the Offers page; merged
// Transfer rows are always TopShot moves).
const collectionOfRec = (r) => {
  if (r.data && r.data.nftType) return collectionOf(r.data.nftType);
  if (r.type === TRANSFER_TYPE) return "TopShot";
  const c = collectionOf(r.type);
  return c.startsWith("TopShot") || c === "Market" ? "TopShot" : c;
};

/** Run queued lookup jobs, at most 3 in flight; refills itself as jobs end. */
function pumpLookups(q) {
  while (q.running < 3 && q.waiting.length > 0) {
    const job = q.waiting.shift();
    q.running += 1;
    job().finally(() => {
      q.running -= 1;
      pumpLookups(q);
    });
  }
}

// One shared ticker every age cell subscribes to. The page used to keep
// `now` in state, so each 5s tick re-rendered and re-summarized all 250
// rows just to bump the "12s" labels; with the memoized rows below, a
// tick now touches only the age cells.
const nowStore = { value: Date.now(), listeners: new Set() };
const subscribeNow = (fn) => {
  nowStore.listeners.add(fn);
  return () => nowStore.listeners.delete(fn);
};
const getNow = () => nowStore.value;
function tickNow() {
  nowStore.value = Date.now();
  nowStore.listeners.forEach((fn) => fn());
}

function AgeCell({ ts, height }) {
  const now = useSyncExternalStore(subscribeNow, getNow);
  return (
    <td className="mkt-age" title={`Block ${height.toLocaleString()} · ${ts}`}>
      {formatAge(now - new Date(ts).getTime())}
    </td>
  );
}

const dash = <span className="mkt-dim">-</span>;

/**
 * One event row (plus its expanded payload row, and one child row per
 * moment pulled from a pack). The columns are the Offers page's, so a
 * sale, an offer or a listing reads the same on both pages:
 *
 *   Age | Event | [Collection] | Edition | NFT | Set | Player | Subedition | Play | Price | Accounts
 *
 * (components/MomentIdentity owns the four edition columns.) The event
 * pill opens the transaction; a column of its own cost more width than
 * it was worth. Memoized so a poll or an enrichment landing re-renders
 * only rows whose inputs actually changed: event records keep their
 * identity in the store across polls, and the age tick bypasses this
 * entirely via AgeCell's own subscription.
 */
const EventRow = memo(function EventRow({ rec, isOpen, onToggle, dbMaps, momentInfo, packInfo, partyInfo, showColl }) {
  const stop = (e) => e.stopPropagation();
  const d = rec.data || {};
  const n = shortName(rec.type);
  // Names for the parties, once the username directory has loaded
  useUsernames();

  const acctLink = (a, label) =>
    a ? (
      <Link to={`/account/${withPrefix(a)}`} className="mkt-addr font-mono" onClick={stop} title={label ? `${label}: ${addressTitle(withPrefix(a))}` : addressTitle(withPrefix(a))}>
        <AddressName address={withPrefix(a)} />
      </Link>
    ) : null;

  const dim = (text) => <span className="mkt-dim">{text}</span>;
  const mono = (text) => <span className="font-mono">{text}</span>;
  const money = (text) => <span className="mkt-money">{text}</span>;

  /** New-tab link to a vendor site, or null when there is no url. */
  const extLink = (url, text, cls = "", title) =>
    url ? (
      <a href={url} target="_blank" rel="noopener noreferrer" className={`mkt-ext ${cls}`.trim()} onClick={stop} title={title}>
        {text}
      </a>
    ) : null;

  const momentUrl = (momentID) => externalNftUrl(TOPSHOT_NFT_TYPE, momentID);

  const infoOf = (momentID) => {
    const info = momentInfo.get(Number(momentID));
    return info && info.status === "done" ? info : null;
  };
  const resolvedOwnerOf = (momentID) => infoOf(momentID)?.owner ?? null;

  /** Who the moment left during its transaction (the absorbed Withdraw's from). */
  const movedFromOf = (momentID) => {
    const info = momentInfo.get(Number(momentID));
    return (info && info.movedFrom) || null;
  };

  /** The Edition column: the edition id, linked, in the shared monospace form */
  const editionId = (setID, playID, subID) => {
    const key = `${Number(setID)}_${Number(playID)}${subID > 0 ? `_${Number(subID)}` : ""}`;
    return <Link to={`/editions/${key}`} className="font-mono" onClick={stop}>{key}</Link>;
  };

  // What the row is about, column by column: { id, edition, serial }.
  // Every event concerns one of a Top Shot moment (by id), a Top Shot
  // edition (set, play, parallel), a pack, another collection's NFT, or
  // nothing identifiable.
  /** A moment by id: resolved rows carry the edition and the serial (the
   *  serial opens the moment's own nbatopshot.com page); unresolved ones
   *  only the NFT id, still linked, until the lookup lands */
  const momentIdentity = (momentID) => {
    const info = infoOf(momentID);
    if (!info) return { serial: extLink(momentUrl(momentID), `NFT #${momentID}`, "mkt-dim") };
    return {
      id: editionId(info.setID, info.playID, info.subID),
      edition: { setID: info.setID, playID: info.playID, subID: info.subID },
      serial: extLink(momentUrl(momentID), `#${info.serial}`, "font-mono", `NFT #${momentID}`)
    };
  };
  const editionIdentity = (setID, playID, subID, sub) => ({
    id: editionId(setID, playID, subID),
    edition: { setID, playID, subID, sub }
  });
  // Another collection's NFT, or a pack: the id is an NFT id (the NFT
  // column), and the Collection column already names what it is, so
  // nothing repeats the name here
  const otherIdentity = (nftType, id) => (
    id !== undefined && id !== null ? { serial: extLink(externalNftUrl(nftType, id), `NFT #${id}`, "font-mono") ?? mono(`NFT #${id}`) } : {}
  );
  const packIdentity = (id) => ({ serial: extLink(externalNftUrl(PACK_NFT_TYPE, id), `NFT #${id}`, "font-mono") ?? mono(`NFT #${id}`) });

  /** The Accounts column: whose hands the asset (or offer) moved
   *  between, each address with its role, as [role, address] pairs (the
   *  Offers page's Buyer and Seller, plus from/to for plain moves). */
  const partiesOf = () => {
    const list = (...pairs) => pairs.filter(([, a]) => a);
    if (rec.type === TRANSFER_TYPE) return list(["from", d.from], ["to", d.to]);
    if (/\.Moment(Listed|PriceChanged)$/.test(n)) return list(["seller", d.seller]);
    if (/\.MomentWithdrawn$/.test(n)) return list(["seller", d.owner ?? d.seller]);
    if (/\.MomentPurchased$/.test(n)) return list(["seller", d.seller ?? movedFromOf(d.id)], ["buyer", resolvedOwnerOf(d.id)]);
    if (n === "NFTStorefrontV2.ListingAvailable") return list(["seller", d.storefrontAddress]);
    if (n === "NFTStorefrontV2.ListingCompleted" && !isTopShotType(d.nftType)) {
      // Another collection's NFT: the transaction's standard NFT moves
      // (sale) or its authorizer (delist), once that lookup has landed
      const p = partyInfo.get(`${rec.txId}:${d.nftID}`);
      return p ? list(["seller", p.from], ["buyer", p.to]) : [];
    }
    if (n === "NFTStorefrontV2.ListingCompleted") {
      // Sale: the absorbed Withdraw names the seller, the Deposit the
      // buyer. Delist: the resolved holder is the canceller
      return d.purchased
        ? list(["seller", movedFromOf(d.nftID)], ["buyer", resolvedOwnerOf(d.nftID)])
        : list(["seller", resolvedOwnerOf(d.nftID)]);
    }
    if (n === "OffersV2.OfferAvailable") return list(["buyer", d.offerAddress]);
    if (n === "OffersV2.OfferCompleted") {
      return d.purchased
        ? list(["seller", d.acceptingAddress ?? movedFromOf(d.nftId)], ["buyer", d.offerAddress])
        : list(["buyer", d.offerAddress]);
    }
    if (n === "TopShot.Deposit") return list(["to", d.to]);
    if (n === "TopShot.Withdraw") return list(["from", d.from]);
    if (n === "PackNFT.Opened") {
      const contents = packInfo.get(rec.txId);
      return contents ? list(["from", contents.from], ["to", contents.to]) : [];
    }
    return [];
  };

  /** One line per party: the role, dim, then the address */
  const partyLines = (parties) => parties.map(([role, a]) => (
    <span key={role} className="mkt-party">
      <span className="mkt-dim mkt-role">{role}</span>
      {acctLink(a, role)}
    </span>
  ));

  /** The row's identity, price (with a note under it) and the notes that
   *  sit under the event pill; the expanded row has the full payload. */
  const describe = () => {
    const notes = [];
    // A move touching the Vaultopolis vault is a TSHOT swap leg
    const tshotTag =
      isTshotAddr(d.from) || isTshotAddr(d.to) ? (
        <a href={TSHOT_SWAP_URL} target="_blank" rel="noopener noreferrer" className="mkt-tshot" onClick={stop} title="Moments moving through the Vaultopolis TSHOT vault">
          TSHOT
        </a>
      ) : null;

    if (rec.type === TRANSFER_TYPE) return { ...momentIdentity(d.id), notes: [tshotTag] };

    if (/^(Market|TopShotMarketV2|TopShotMarketV3)\.Moment(Listed|PriceChanged|Purchased|Withdrawn)$/.test(n)) {
      const ident = momentIdentity(d.id);
      if (!ident.edition && n.endsWith("Purchased") && d.momentName) notes.push(<span>{d.momentName}</span>);
      const price = d.price ?? d.newPrice;
      return { ...ident, price: price !== undefined && price !== null ? money(formatAmount(price)) : null, notes };
    }

    if (n === "NFTStorefrontV2.ListingAvailable" || n === "NFTStorefrontV2.ListingCompleted") {
      const ident = isTopShotType(d.nftType) ? momentIdentity(d.nftID) : otherIdentity(d.nftType, d.nftID);
      const price = d.salePrice !== undefined && d.salePrice !== null ? money(formatAmount(d.salePrice, d.salePaymentVaultType)) : null;
      const priceNote = d.commissionAmount && Number(d.commissionAmount) > 0
        ? dim(`commission ${formatAmount(d.commissionAmount, d.salePaymentVaultType)}`)
        : null;
      return { ...ident, price, priceNote, notes };
    }

    if (n === "OffersV2.OfferAvailable" || n === "OffersV2.OfferCompleted") {
      const isTopShot = isTopShotType(d.nftType);
      const p = d.offerParamsString || {};
      const nftId = d.nftId ?? p.nftId ?? p.nftID;
      let ident = {};
      if (nftId !== undefined && nftId !== null) {
        ident = isTopShot ? momentIdentity(nftId) : otherIdentity(d.nftType, nftId);
      } else if (p._type === "TopShotEdition" || p._type === "TopShotSubedition") {
        // Edition-level offer: a play in a set (optionally a parallel);
        // the params name it exactly, no chain lookup needed. Without a
        // parallel it accepts Any, as on the Offers page
        const subID = Number(p.subeditionId || 0);
        ident = editionIdentity(Number(p.setId), Number(p.playId), subID,
          subID > 0 ? undefined : <span className="mkt-dim" title="An edition-level offer accepts any subedition of the play">Any</span>);
      } else if (!isTopShot && d.nftType) {
        ident = otherIdentity(d.nftType);
      }
      const price = d.offerAmount !== undefined ? money(formatAmount(d.offerAmount, d.paymentVaultType)) : null;
      return { ...ident, price, notes };
    }

    if (n === "TopShot.MomentMinted") {
      return {
        ...editionIdentity(Number(d.setID), Number(d.playID), Number(d.subeditionID) || 0),
        serial: extLink(momentUrl(d.momentID), `#${d.serialNumber}`, "font-mono", `NFT #${d.momentID}`) ?? mono(`#${d.serialNumber}`),
        notes
      };
    }
    if (n === "TopShot.Deposit" || n === "TopShot.Withdraw") return { ...momentIdentity(d.id), notes: [tshotTag] };
    // Burns and locks carry no address in the payload, so the id is all
    // there is until a cached identity matches
    if (n === "TopShot.MomentDestroyed" || n === "TopShotLocking.MomentUnlocked") return { ...momentIdentity(d.id), notes };
    if (n === "TopShotLocking.MomentLocked") {
      const days = Math.round(Number(d.duration) / 86400);
      return { ...momentIdentity(d.id), notes: [dim(`${isFinite(days) ? days : "?"} days`)] };
    }
    if (n === "PackNFT.Opened") {
      // The pack's contents are the TopShot deposits in the same
      // transaction; each pull is a child row below
      const contents = packInfo.get(rec.txId);
      const note = !contents ? "reading contents..."
        : contents.ids.length === 0 ? "no moments deposited in this transaction"
        : `${contents.ids.length} moment${contents.ids.length === 1 ? "" : "s"} pulled`;
      return { ...packIdentity(d.id), notes: [dim(note)] };
    }
    if (n.startsWith("PackNFT.")) {
      return { ...packIdentity(d.id), notes: d.distId !== undefined ? [dim(`distribution ${d.distId}`)] : [] };
    }

    // Fallback: the first few decoded fields as key: value
    for (const [k, v] of Object.entries(d).slice(0, 4)) {
      notes.push(<span>{dim(`${k}: `)}{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>);
    }
    if (notes.length === 0) notes.push(dim("no payload"));
    return { notes };
  };

  /** One child row per pull, lowest serial first; unresolved ids sink to
   *  the bottom until their lookup lands */
  const packPulls = () => {
    if (n !== "PackNFT.Opened") return [];
    const contents = packInfo.get(rec.txId);
    if (!contents || contents.ids.length === 0) return [];
    return contents.ids
      .map((id) => ({ id, info: infoOf(id) }))
      .sort((x, y) => {
        const sx = x.info ? Number(x.info.serial) : Infinity;
        const sy = y.info ? Number(y.info.serial) : Infinity;
        return sx - sy || x.id - y.id;
      })
      .map((pull) => momentIdentity(pull.id));
  };

  /** Edition | NFT | Set | Player | Subedition | Play for one identity
   *  (the NFT cell reads "#serial" once resolved, "NFT #id" before) */
  const identityCells = (w) => (
    <>
      <td className="mkt-edition">{w.id ?? dash}</td>
      <td className="mkt-serial">{w.serial ?? dash}</td>
      {w.edition ? (
        <EditionCells
          facts={dbMaps ? dbMaps.factsOf(w.edition.setID, w.edition.playID) : null}
          setID={w.edition.setID}
          playID={w.edition.playID}
          subID={w.edition.subID}
          sub={w.edition.sub}
          onClick={stop}
        />
      ) : <EditionCells />}
    </>
  );

  const b = badgeFor(rec);
  const parties = partiesOf();
  const what = describe();
  const cols = 10 + (showColl ? 1 : 0);
  return (
    <>
      <tr className={`mkt-row${isOpen ? " open" : ""}`} onClick={() => onToggle(rec.key)}>
        <AgeCell ts={rec.ts} height={rec.height} />
        <td className="mkt-event">
          <a
            href={`https://flow.reruncode.com/#/tx/${rec.txId}`}
            target="_blank"
            rel="noreferrer"
            className={`mkt-badge kind-${b.kind}`}
            onClick={stop}
            title={`View transaction ${rec.txId} on flow.reruncode.com`}
          >
            {b.label}
          </a>
          {(what.notes || []).filter(Boolean).map((node, i) => (
            <span key={i} className="mkt-note">{node}</span>
          ))}
          {/* On narrow screens the Accounts column hides and the
              parties ride along under the event */}
          {parties.length > 0 && <span className="mkt-mobile-addr mkt-note">{partyLines(parties)}</span>}
        </td>
        {showColl && <td>{collectionOfRec(rec)}</td>}
        {identityCells(what)}
        <td className="mkt-price">
          {what.price ?? dash}
          {what.priceNote && <span className="mkt-note">{what.priceNote}</span>}
        </td>
        <td className="mkt-col-addr">{parties.length > 0 ? partyLines(parties) : dash}</td>
      </tr>
      {packPulls().map((w, i) => (
        <tr key={`${rec.key}:pull:${i}`} className="mkt-child-row" onClick={() => onToggle(rec.key)}>
          <td />
          <td />
          {showColl && <td />}
          {identityCells(w)}
          <td />
          <td className="mkt-col-addr" />
        </tr>
      ))}
      {isOpen ? (
        <tr className="mkt-expand-row">
          <td colSpan={cols}>
            <pre className="mkt-payload">{JSON.stringify({ type: rec.type === TRANSFER_TYPE ? `${WITHDRAW_TYPE} + ${DEPOSIT_TYPE} (one transfer)` : rec.type, block: rec.height, transaction: rec.txId, ...rec.data }, null, 2)}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
});

export function Live() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [paused, setPaused] = useState(false);
  const [textFilter, setTextFilter] = useState("");
  const [collFilter, setCollFilterState] = useState(loadCollFilter);
  const setCollFilter = (vals) => {
    setCollFilterState(vals);
    try {
      localStorage.setItem(COLLS_KEY, JSON.stringify(vals));
    } catch { /* private mode */ }
  };
  const [expanded, setExpanded] = useState(() => new Set());
  // Render snapshot of the event store; the Map itself lives in a ref so
  // ingest can dedupe across polls without triggering renders per event
  const [events, setEvents] = useState([]);
  const [tip, setTip] = useState(0);
  const [error, setError] = useState("");

  const storeRef = useRef(new Map());
  const lastByTypeRef = useRef({});
  const enabledRef = useRef(enabled);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Enrichment: play/set names come from IndexedDB, moment identities from
  // chain lookups. Render reads the STATE copies; the refs are the caches
  // the callbacks dedupe against (never read during render, lint rule).
  const [dbMaps, setDbMaps] = useState(null);
  const [momentInfo, setMomentInfo] = useState(() => new Map());
  const momentCacheRef = useRef(new Map());
  const pendingMomentsRef = useRef(new Set());
  const lookupQueueRef = useRef({ running: 0, waiting: [] });

  // Publishing the cache copies the whole Map (up to 3,000 entries), so a
  // burst of resolutions batches into one publish instead of one per hit
  const publishTimerRef = useRef(null);
  const publishMomentInfo = useCallback(() => {
    if (publishTimerRef.current !== null) return;
    publishTimerRef.current = setTimeout(() => {
      publishTimerRef.current = null;
      setMomentInfo(new Map(momentCacheRef.current));
    }, 50);
  }, []);
  useEffect(() => () => {
    if (publishTimerRef.current !== null) clearTimeout(publishTimerRef.current);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([getAllPlaysDB(), getAllSetsDB()])
      .then(([plays, sets]) => {
        if (!alive) return;
        // The shared identity facts (components/MomentIdentity): names
        // and badges per edition, the same as the Offers page reads
        setDbMaps(buildIdentityContext(plays, sets));
      })
      .catch(() => { /* enrichment is optional; the stream works without it */ });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Resolve one moment's identity (play, set, serial, parallel, holder),
   * at most once per moment ID for the life of the page. Tries the tx's
   * Deposit event first when the moment moved, then each candidate owner.
   */
  const requestMoment = useCallback((ref) => {
    const { momentID, owners = [], txFallback = false, authFallback = false, txId } = ref;
    if (!Number.isFinite(momentID)) return;
    if (momentCacheRef.current.has(momentID) || pendingMomentsRef.current.has(momentID)) return;
    if (owners.filter(Boolean).length === 0 && !txFallback && !authFallback) return;
    pendingMomentsRef.current.add(momentID);
    lookupQueueRef.current.waiting.push(async () => {
      let candidates = owners.filter(Boolean).map(withPrefix);
      let movedFrom = null;
      if (txFallback && txId) {
        const moves = await getTxTopShotMoves(txId).catch(() => null);
        if (moves) {
          // The Withdraw side names who the moment left (the seller);
          // the Deposit side names where it landed (the buyer)
          movedFrom = moves.from;
          const landed = moves.deposits.find((x) => x.id === momentID);
          if (landed) candidates = [withPrefix(landed.to), ...candidates];
        }
      }
      if (authFallback && txId) {
        const signers = await getTxSigners(txId).catch(() => []);
        candidates = [...candidates, ...signers.map(withPrefix)];
      }
      let result = { status: "none" };
      for (const owner of [...new Set(candidates)]) {
        try {
          const row = await getMomentByOwner(owner, momentID);
          if (row) {
            result = { status: "done", setID: row[1], playID: row[2], serial: row[3], subID: row[4], owner };
            break;
          }
        } catch { /* this account does not expose it; try the next */ }
      }
      if (movedFrom) result.movedFrom = movedFrom;
      pendingMomentsRef.current.delete(momentID);
      momentCacheRef.current.set(momentID, result);
      publishMomentInfo();
    });
    pumpLookups(lookupQueueRef.current);
  }, [publishMomentInfo]);

  /**
   * Resolve many moments that share one candidate owner in a SINGLE
   * script call (one queue slot, one request): a batch transaction can
   * drop 50 same-owner transfers on screen at once. A moment the owner
   * does not expose falls back to the individual path with the ref's
   * remaining candidates, or is cached as unresolved.
   */
  const requestMomentBatch = useCallback((owner, refs) => {
    const seen = new Set();
    const fresh = refs.filter((ref) => {
      if (!Number.isFinite(ref.momentID) || seen.has(ref.momentID)) return false;
      if (momentCacheRef.current.has(ref.momentID) || pendingMomentsRef.current.has(ref.momentID)) return false;
      seen.add(ref.momentID);
      return true;
    });
    if (fresh.length === 0) return;
    for (const ref of fresh) pendingMomentsRef.current.add(ref.momentID);
    lookupQueueRef.current.waiting.push(async () => {
      const found = new Map();
      try {
        const hits = await getMomentsByOwner(owner, fresh.map((r) => r.momentID));
        for (const row of hits) found.set(row[0], row);
      } catch { /* the owner exposes nothing; every ref falls back below */ }
      let touched = false;
      for (const ref of fresh) {
        pendingMomentsRef.current.delete(ref.momentID);
        const row = found.get(ref.momentID);
        if (row) {
          momentCacheRef.current.set(ref.momentID, {
            status: "done", setID: row[1], playID: row[2], serial: row[3], subID: row[4], owner
          });
          touched = true;
        } else {
          const rest = (ref.owners || []).filter((a) => a && withPrefix(a) !== owner);
          if (rest.length > 0 || ref.txFallback || ref.authFallback) {
            requestMoment({ ...ref, owners: rest });
          } else {
            momentCacheRef.current.set(ref.momentID, { status: "none" });
            touched = true;
          }
        }
      }
      if (touched) publishMomentInfo();
    });
    pumpLookups(lookupQueueRef.current);
  }, [requestMoment, publishMomentInfo]);

  // Pack contents: what a pack-opening transaction deposited. Keyed by
  // transaction id; each pulled moment also gets an identity lookup.
  const [packInfo, setPackInfo] = useState(() => new Map());
  const packCacheRef = useRef(new Map());
  const pendingPacksRef = useRef(new Set());

  const requestPackContents = useCallback((txId) => {
    if (!txId || packCacheRef.current.has(txId) || pendingPacksRef.current.has(txId)) return;
    pendingPacksRef.current.add(txId);
    lookupQueueRef.current.waiting.push(async () => {
      let result = { ids: [], to: null, from: null };
      try {
        const { deposits, from } = await getTxTopShotMoves(txId);
        result = { ids: deposits.map((x) => x.id), to: deposits[0] ? deposits[0].to : null, from };
        for (const dep of deposits) requestMoment({ momentID: dep.id, owners: [dep.to] });
      } catch { /* row keeps the bare pack id */ }
      pendingPacksRef.current.delete(txId);
      packCacheRef.current.set(txId, result);
      setPackInfo(new Map(packCacheRef.current));
    });
    pumpLookups(lookupQueueRef.current);
  }, [requestMoment]);

  // Parties of another collection's storefront sale or delist, keyed by
  // "txId:nftID": ONE REST request per row (the same per-transaction
  // fetch Top Shot sales use, shared through its cache), no script calls.
  const [partyInfo, setPartyInfo] = useState(() => new Map());
  const partyCacheRef = useRef(new Map());
  const pendingPartiesRef = useRef(new Set());

  const requestParties = useCallback((ref) => {
    const key = `${ref.txId}:${ref.nftID}`;
    if (!ref.txId || partyCacheRef.current.has(key) || pendingPartiesRef.current.has(key)) return;
    pendingPartiesRef.current.add(key);
    lookupQueueRef.current.waiting.push(async () => {
      let result = { from: null, to: null };
      try {
        if (ref.purchased) {
          const { nfts } = await getTxTopShotMoves(ref.txId);
          const hit = nfts.find((m) => m.type === ref.nftType && m.id === ref.nftID);
          if (hit) result = { from: hit.from, to: hit.to };
        } else {
          // The storefront owner had to authorize the delist; Dapper's
          // custodial transactions list the owner as the authorizer and
          // Dapper itself only as payer
          const signers = await getTxSigners(ref.txId);
          if (signers[0]) result = { from: signers[0], to: null };
        }
      } catch { /* row keeps an empty Accounts cell */ }
      pendingPartiesRef.current.delete(key);
      partyCacheRef.current.set(key, result);
      setPartyInfo(new Map(partyCacheRef.current));
    });
    pumpLookups(lookupQueueRef.current);
  }, []);

  // Hydrate the lookup caches from the previous session before any rows
  // arrive, then write them back (debounced) as new resolutions land
  useEffect(() => {
    const m = loadStoredMap(MOMENT_CACHE_KEY);
    if (m && m.size > 0) {
      for (const [id, info] of m) if (!momentCacheRef.current.has(id)) momentCacheRef.current.set(id, info);
      setMomentInfo(new Map(momentCacheRef.current));
    }
    const p = loadStoredMap(PACK_CACHE_KEY);
    if (p && p.size > 0) {
      for (const [txId, contents] of p) if (!packCacheRef.current.has(txId)) packCacheRef.current.set(txId, contents);
      setPackInfo(new Map(packCacheRef.current));
    }
    const q = loadStoredMap(PARTY_CACHE_KEY);
    if (q && q.size > 0) {
      for (const [key, parties] of q) if (!partyCacheRef.current.has(key)) partyCacheRef.current.set(key, parties);
      setPartyInfo(new Map(partyCacheRef.current));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      storeMap(MOMENT_CACHE_KEY, new Map([...momentInfo].filter(([, v]) => v.status === "done")), MOMENT_CACHE_MAX);
    }, 1500);
    return () => clearTimeout(t);
  }, [momentInfo]);

  useEffect(() => {
    const t = setTimeout(() => {
      storeMap(PACK_CACHE_KEY, new Map([...packInfo].filter(([, v]) => v.ids && v.ids.length > 0)), PACK_CACHE_MAX);
    }, 1500);
    return () => clearTimeout(t);
  }, [packInfo]);

  useEffect(() => {
    const t = setTimeout(() => {
      storeMap(PARTY_CACHE_KEY, new Map([...partyInfo].filter(([, v]) => v.from || v.to)), PARTY_CACHE_MAX);
    }, 1500);
    return () => clearTimeout(t);
  }, [partyInfo]);

  // Lowest block height fetched per stream (the live window's floor, or
  // further back once "Older events" has walked earlier windows), and
  // the floor of the live window itself: the cap on stored events only
  // ever drops LIVE rows, never a page the reader asked for
  const firstByTypeRef = useRef({});
  const liveFloorRef = useRef(Infinity);

  const ingest = useCallback((blocks, type, older = false) => {
    const store = storeRef.current;
    for (const b of blocks || []) {
      for (const e of b.events || []) {
        const key = `${e.transaction_id}:${e.event_index}`;
        if (store.has(key)) continue;
        const data = decodeEventPayload(e.payload);
        store.set(key, {
          key,
          type,
          height: Number(b.block_height),
          ts: b.block_timestamp,
          txId: e.transaction_id,
          data,
          search: `${type} ${JSON.stringify(data)}`.toLowerCase()
        });
      }
    }
    if (!older && store.size > MAX_STORE) {
      const live = [...store.values()].filter((r) => r.height >= liveFloorRef.current).sort((a, b) => a.height - b.height);
      for (const r of live.slice(0, store.size - MAX_STORE)) store.delete(r.key);
    }
  }, []);

  const doPoll = useCallback(async () => {
    if (pausedRef.current || document.visibilityState === "hidden") return;
    // Chip keys -> distinct event types: facet chips share one stream, so
    // Sold + Delisted enabled still costs ONE ListingCompleted request
    const types = [...new Set([...enabledRef.current].map((k) => (EVENT_INDEX[k] || {}).type).filter(Boolean))];
    if (types.length === 0) return;
    try {
      const sealed = await getSealedHeight();
      await Promise.allSettled(
        types.map(async (t) => {
          const last = lastByTypeRef.current[t] || 0;
          // A type polled before continues from where it left off; a fresh
          // one backfills the full window the API allows (about 4 minutes)
          const from = Math.max(last > 0 ? last + 1 : 0, sealed - (MAX_EVENT_SPAN - 1), 0);
          if (from > sealed) return;
          const blocks = await getEvents(t, from, sealed);
          lastByTypeRef.current[t] = sealed;
          if (!(t in firstByTypeRef.current)) firstByTypeRef.current[t] = from;
          liveFloorRef.current = Math.min(liveFloorRef.current, from);
          ingest(blocks, t);
        })
      );
      setTip(sealed);
      setError("");
      tickNow();
      setEvents([...storeRef.current.values()]);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    }
  }, [ingest]);

  // The poll loop. Hidden tabs skip ticks (doPoll checks visibility) and a
  // tab coming back polls immediately instead of waiting a full interval.
  useEffect(() => {
    void doPoll();
    const interval = setInterval(() => void doPoll(), POLL_S * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void doPoll();
    };
    document.addEventListener("visibilitychange", onVisible);
    const ageTick = setInterval(tickNow, 5000);
    return () => {
      clearInterval(interval);
      clearInterval(ageTick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [doPoll]);

  // "Older events": first pages through what is already collected, then
  // walks each enabled stream one window (250 blocks, the API's maximum)
  // further back per click: one request per distinct stream, the same
  // cost as a poll tick. The earliest height reached shows on the button.
  const [shownLimit, setShownLimit] = useState(MAX_ROWS);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [oldest, setOldest] = useState(0);
  const rowsRef = useRef([]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    if (rowsRef.current.length > shownLimit) {
      setShownLimit((n) => n + MAX_ROWS);
      return;
    }
    const types = [...new Set([...enabledRef.current].map((k) => (EVENT_INDEX[k] || {}).type).filter(Boolean))]
      .filter((t) => (firstByTypeRef.current[t] || 0) > 0);
    if (types.length === 0) return;
    setLoadingOlder(true);
    try {
      await Promise.allSettled(
        types.map(async (t) => {
          const end = firstByTypeRef.current[t] - 1;
          const from = Math.max(end - (MAX_EVENT_SPAN - 1), 0);
          const blocks = await getEvents(t, from, end);
          firstByTypeRef.current[t] = from;
          ingest(blocks, t, true);
        })
      );
      setOldest(Math.min(...types.map((t) => firstByTypeRef.current[t])));
      setEvents([...storeRef.current.values()]);
      setShownLimit((n) => n + MAX_ROWS);
      setError("");
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [ingest, loadingOlder, shownLimit]);

  // Shared tail of both toggle paths: write the ref, persist, publish,
  // and poll immediately when streams just turned on
  const applyEnabled = (next, pollNow) => {
    enabledRef.current = next;
    try {
      localStorage.setItem(ENABLED_KEY, JSON.stringify([...next]));
    } catch { /* private mode */ }
    setEnabled(next);
    if (pollNow) setTimeout(() => void doPoll(), 0);
  };

  const toggleType = (t) => {
    const next = new Set(enabled);
    const turningOn = !next.has(t);
    if (turningOn) next.add(t);
    else next.delete(t);
    applyEnabled(next, turningOn);
  };

  // Group heading click: any chip on -> all off; none on -> all on
  const toggleGroup = (group) => {
    const next = new Set(enabled);
    const anyOn = group.events.some((e) => next.has(e.key));
    for (const e of group.events) {
      if (anyOn) next.delete(e.key);
      else next.add(e.key);
    }
    applyEnabled(next, !anyOn);
  };

  // Stable identity: EventRow's memo depends on this never changing
  const toggleExpand = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const { rows, collOptions } = useMemo(() => {
    const q = textFilter.trim().toLowerCase();
    // Collections present under the enabled streams, so the facet's
    // options list is stable while its values toggle
    const colls = new Set();
    const matchColl = (rec) => collFilter.length === 0 || collFilter.includes(collectionOfRec(rec));
    // A transaction's mechanical Deposit/Withdraw events fold into the
    // primary event that explains them (a sale, an accepted offer, a
    // mint, a pack opening), when that primary row is itself visible.
    // The moves share the primary row's transaction, so its tx link
    // still reaches everything that was folded away.
    const absorbKeys = new Set();
    for (const r of events) {
      if (!enabled.has(chipKeyOf(r)) || MOVE_TYPES.has(r.type)) continue;
      const mid = absorbedMomentId(r);
      if (mid === "*") absorbKeys.add(`${r.txId}:*`);
      else if (mid !== null && mid !== undefined) absorbKeys.add(`${r.txId}:${mid}`);
    }
    const out = [];
    const pushIfMatch = (rec) => {
      if (!q || rec.search.includes(q)) out.push(rec);
    };
    // Surviving Withdraw/Deposit events pair up by tx + moment id: a
    // matched pair renders as ONE Transfer row (same transaction, so the
    // one tx link covers both underlying events); an unmatched side
    // stays a plain Deposit or Withdraw row
    const movesByKey = new Map();
    for (const r of events) {
      if (!enabled.has(chipKeyOf(r))) continue;
      if (MOVE_TYPES.has(r.type)) {
        if (absorbKeys.has(`${r.txId}:*`) || absorbKeys.has(`${r.txId}:${r.data && r.data.id}`)) continue;
        const k = `${r.txId}:${r.data && r.data.id}`;
        const slot = movesByKey.get(k) || {};
        // A double-hop (vault -> holding collection -> user, as in TSHOT
        // swaps) emits two withdraws per moment, one with from: null;
        // keep the side that names an account
        if (r.type === WITHDRAW_TYPE) {
          if (!slot.w || (slot.w.data && slot.w.data.from == null && r.data && r.data.from != null)) slot.w = r;
        } else if (!slot.d || (slot.d.data && slot.d.data.to == null && r.data && r.data.to != null)) {
          slot.d = r;
        }
        movesByKey.set(k, slot);
        continue;
      }
      colls.add(collectionOfRec(r));
      if (!matchColl(r)) continue;
      pushIfMatch(r);
    }
    // Moves (and the Transfer rows they merge into) are always TopShot
    if (movesByKey.size > 0) colls.add("TopShot");
    if (collFilter.length === 0 || collFilter.includes("TopShot")) {
      for (const slot of movesByKey.values()) {
        const { w, d } = slot;
        if (w && d) {
          pushIfMatch({
            key: `${w.key}+${d.key}`,
            type: TRANSFER_TYPE,
            height: Math.max(w.height, d.height),
            ts: d.ts || w.ts,
            txId: d.txId,
            data: { id: d.data && d.data.id, from: (w.data && w.data.from) || null, to: (d.data && d.data.to) || null },
            search: `${w.search} ${d.search} transfer`
          });
        } else {
          pushIfMatch(w || d);
        }
      }
    }
    out.sort((a, b) => b.height - a.height || (a.txId === b.txId ? 0 : a.txId < b.txId ? 1 : -1));
    return { rows: out, collOptions: [...colls].sort() };
  }, [events, enabled, textFilter, collFilter]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Resolve identities for the rows on screen. Cached forever per moment
  // ID, at most 3 lookups in flight. Rows whose only lead is a candidate
  // owner are GROUPED by that owner and resolved in one script call per
  // 50; rows needing tx or signer fallbacks stay on the individual path.
  useEffect(() => {
    const byOwner = new Map();
    for (const r of rows.slice(0, shownLimit)) {
      if (shortName(r.type) === "PackNFT.Opened") requestPackContents(r.txId);
      const parties = partiesRefOf(r);
      if (parties) {
        requestParties(parties);
        continue;
      }
      const ref = momentRefOf(r);
      if (!ref) continue;
      const first = (ref.owners || []).find(Boolean);
      if (first && !ref.txFallback && !ref.authFallback) {
        const key = withPrefix(first);
        if (!byOwner.has(key)) byOwner.set(key, []);
        byOwner.get(key).push({ ...ref, txId: r.txId });
      } else {
        requestMoment({ ...ref, txId: r.txId });
      }
    }
    for (const [owner, refs] of byOwner) {
      for (let i = 0; i < refs.length; i += 50) requestMomentBatch(owner, refs.slice(i, i + 50));
    }
  }, [rows, shownLimit, requestMoment, requestMomentBatch, requestPackContents, requestParties]);

  const shown = rows.slice(0, shownLimit);
  const nothingEnabled = enabled.size === 0;
  // A Collection column only when the scope is wider than Top Shot alone
  // (the Offers page's showAll)
  const showColl = !(collFilter.length === 1 && collFilter[0] === "TopShot");

  return (
    <div className="mkt-page-container">
      <div className="glass-panel info-banner">
        <h2>Live</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Every listing, delisting, price change, sale, offer and mint as it lands.
          Pick the streams below; click a row for the full on-chain event.
        </p>
        <SignInNote />
      </div>

      <div className="glass-panel mt-20 mkt-controls">
        <div className="mkt-status-bar">
          <span className={`mkt-live-dot${paused ? " is-paused" : ""}`}></span>
          <span className="mkt-status-text">{paused ? "Paused" : "Live"}</span>
          {tip > 0 && <span className="text-muted mkt-status-item font-mono">block {tip.toLocaleString()}</span>}
          <span className="text-muted mkt-status-item">{rows.length.toLocaleString()} event{rows.length === 1 ? "" : "s"}</span>
          {error && <span className="mkt-error" title={error}>stream error: {error}</span>}
          <button type="button" className="btn-primary mkt-pause-btn" onClick={() => setPaused(!paused)}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>

        <div className="mkt-filter-bar">
          <input
            type="text"
            className="form-control mkt-search"
            placeholder="Filter: address, moment id, price, set..."
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
          {/* The feed's scope: defaults to Top Shot alone; clear the
              selection to watch every Dapper Labs collection the storefront
              and offer contracts carry (AllDay, packs, everything).
              Selected values stay listed even before any matching event
              arrives, so a selection can always be unchecked. */}
          <MultiSelect
            label="Collection"
            values={collFilter}
            options={[...new Set([...collOptions, ...collFilter])].sort().map((c) => [c, c])}
            onChange={setCollFilter}
          />
        </div>

        <div className="mkt-groups">
          {EVENT_GROUPS.map((g) => (
            <div className="mkt-group" key={g.name}>
              <button
                type="button"
                className="mkt-group-name"
                onClick={() => toggleGroup(g)}
                title={`${g.note}. Click to turn the whole group on or off.`}
              >
                {g.name}
              </button>
              <div className="mkt-chips">
                {g.events.map((e) => (
                  <button
                    type="button"
                    key={e.key}
                    className={`mkt-chip kind-${e.kind}${enabled.has(e.key) ? " on" : ""}`}
                    onClick={() => toggleType(e.key)}
                    title={e.hint ? `${e.type}. ${e.hint}` : e.type}
                  >
                    {e.label}
                    {e.sub ? <span className="mkt-chip-sub">({e.sub})</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-panel mt-20 mkt-feed-panel">
        {nothingEnabled ? (
          <p className="text-muted mkt-empty">No streams selected. Turn on some event types above.</p>
        ) : shown.length === 0 ? (
          <p className="text-muted mkt-empty">
            {tip === 0 && !error
              ? "Connecting to Flow..."
              : "Nothing yet in the last few minutes for the selected streams. The feed fills as events seal."}
          </p>
        ) : (
          <div className="table-wrapper">
          {/* table-wrapper is the last-resort scroll container every
              other table has; without it a narrow viewport pushes the
              whole page sideways instead */}
          <table className="mkt-table">
            <thead>
              <tr>
                {/* The Offers page's columns (components/MomentIdentity) */}
                <th className="mkt-age-col">Age</th>
                <th>Event</th>
                {showColl && <th>Collection</th>}
                <th>Edition</th>
                <th title="The NFT: #serial when known, else its id; the link opens it on nbatopshot.com">NFT</th>
                {EDITION_HEADINGS.map((h) => <th key={h}>{h}</th>)}
                <th>Price</th>
                <th className="mkt-col-addr" title="The accounts on the transaction and their roles">Accounts</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <EventRow
                  key={r.key}
                  rec={r}
                  isOpen={expanded.has(r.key)}
                  onToggle={toggleExpand}
                  dbMaps={dbMaps}
                  momentInfo={momentInfo}
                  packInfo={packInfo}
                  partyInfo={partyInfo}
                  showColl={showColl}
                />
              ))}
            </tbody>
          </table>
          </div>
        )}
        {tip > 0 && (
          <p className="text-muted mkt-truncated">
            {rows.length > shown.length
              ? `Showing the newest ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} collected events. `
              : oldest > 0
                ? `Back to block ${oldest.toLocaleString()}. `
                : ""}
            <button type="button" className="btn-primary mkt-older-btn" onClick={() => void loadOlder()} disabled={loadingOlder}
              title={rows.length > shown.length ? "Show the next page of collected events" : "Fetch the previous 250 blocks of every enabled stream"}>
              {loadingOlder ? "Loading older events" : "Older events"}
            </button>
          </p>
        )}
      </div>

      <style>{`
        .mkt-page-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .mkt-controls {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .mkt-status-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .mkt-live-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 8px rgba(16, 185, 129, 0.8);
          animation: mktPulse 1.6s infinite ease-in-out;
          flex-shrink: 0;
        }
        .mkt-live-dot.is-paused {
          background: #f59e0b;
          box-shadow: none;
          animation: none;
        }
        @keyframes mktPulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .mkt-status-text {
          font-weight: 700;
          font-size: 0.9rem;
        }
        .mkt-status-item {
          font-size: 0.82rem;
        }
        .mkt-error {
          color: #f43f5e;
          font-size: 0.82rem;
          max-width: 340px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mkt-pause-btn {
          margin-left: auto;
          padding: 5px 14px;
          font-size: 0.82rem;
        }
        .mkt-filter-bar {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
        }
        .mkt-search {
          flex: 1 1 260px;
          min-width: 0;
          padding: 7px 12px;
          font-size: 0.85rem;
        }
        .mkt-groups {
          display: flex;
          flex-direction: column;
          gap: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          padding-top: 12px;
        }
        .mkt-group {
          display: flex;
          align-items: baseline;
          gap: 12px;
          flex-wrap: wrap;
        }
        .mkt-group-name {
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--text-muted);
          min-width: 150px;
          background: none;
          border: none;
          padding: 0;
          text-align: left;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .mkt-group-name:hover {
          color: #fff;
        }
        .mkt-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .mkt-chip {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: var(--text-muted);
          font-size: 0.76rem;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 9999px;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .mkt-chip::before {
          content: '';
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          margin-right: 6px;
          background: currentColor;
          opacity: 0.4;
        }
        .mkt-chip-sub {
          margin-left: 5px;
          font-weight: 400;
          opacity: 0.6;
        }
        .mkt-chip.on {
          color: #fff;
        }
        .mkt-chip.on::before {
          opacity: 1;
        }
        .mkt-chip.on.kind-listed { background: rgba(59, 130, 246, 0.18); border-color: rgba(59, 130, 246, 0.5); }
        .mkt-chip.on.kind-listed::before { background: #3b82f6; }
        .mkt-chip.on.kind-price { background: rgba(234, 179, 8, 0.15); border-color: rgba(234, 179, 8, 0.5); }
        .mkt-chip.on.kind-price::before { background: #eab308; }
        .mkt-chip.on.kind-purchased { background: rgba(16, 185, 129, 0.16); border-color: rgba(16, 185, 129, 0.5); }
        .mkt-chip.on.kind-purchased::before { background: #10b981; }
        .mkt-chip.on.kind-delisted { background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.5); }
        .mkt-chip.on.kind-delisted::before { background: #f59e0b; }
        .mkt-chip.on.kind-offer { background: rgba(167, 139, 250, 0.16); border-color: rgba(167, 139, 250, 0.5); }
        .mkt-chip.on.kind-offer::before { background: #a78bfa; }
        .mkt-chip.on.kind-minted { background: rgba(20, 184, 166, 0.16); border-color: rgba(20, 184, 166, 0.5); }
        .mkt-chip.on.kind-minted::before { background: #14b8a6; }
        .mkt-chip.on.kind-core { background: rgba(148, 163, 184, 0.14); border-color: rgba(148, 163, 184, 0.45); }
        .mkt-chip.on.kind-core::before { background: #94a3b8; }

        .mkt-feed-panel {
          padding: 10px 14px 14px;
        }
        .mkt-empty {
          padding: 24px 8px;
          text-align: center;
          font-size: 0.9rem;
        }
        .mkt-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: auto;
          font-size: 0.84rem;
        }
        .mkt-table th {
          text-align: left;
          font-size: 0.72rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
          padding: 8px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .mkt-table td {
          padding: 7px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          vertical-align: top;
        }
        .mkt-row {
          cursor: pointer;
        }
        .mkt-row:hover td, .mkt-row.open td {
          background: rgba(139, 92, 246, 0.06);
        }
        .mkt-age {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 0.78rem;
          white-space: nowrap;
          width: 44px;
        }
        .mkt-badge {
          display: inline-block;
          font-size: 0.72rem;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 5px;
          white-space: nowrap;
        }
        .mkt-badge.kind-listed { background: rgba(59, 130, 246, 0.12); color: #60a5fa; }
        .mkt-badge.kind-price { background: rgba(234, 179, 8, 0.1); color: #eab308; }
        .mkt-badge.kind-purchased { background: rgba(16, 185, 129, 0.12); color: #10b981; }
        .mkt-badge.kind-delisted { background: rgba(245, 158, 11, 0.12); color: #f59e0b; }
        .mkt-badge.kind-offer { background: rgba(167, 139, 250, 0.12); color: #a78bfa; }
        .mkt-badge.kind-minted { background: rgba(20, 184, 166, 0.12); color: #2dd4bf; }
        .mkt-badge.kind-core { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
        a.mkt-badge {
          text-decoration: none;
        }
        a.mkt-badge:hover {
          filter: brightness(1.3);
        }
        .mkt-event {
          white-space: nowrap;
        }
        /* Lines under the event pill or the price: a lock's length, a
           pack's pull count, a commission, the TSHOT tag */
        .mkt-note {
          display: block;
          font-size: 0.76rem;
          line-height: 1.4;
          margin-top: 3px;
        }
        .mkt-edition, .mkt-serial, .mkt-price {
          white-space: nowrap;
        }
        .mkt-table td.mkt-child-row-cell,
        .mkt-child-row td {
          padding-top: 3px;
          padding-bottom: 3px;
          font-size: 0.8rem;
          border-bottom-color: rgba(255, 255, 255, 0.025);
        }
        .mkt-child-row {
          cursor: pointer;
        }
        .mkt-dim {
          color: var(--text-muted);
        }
        .mkt-money {
          color: #10b981;
          font-weight: 700;
          font-family: var(--font-mono);
        }
        .mkt-tshot {
          background: rgba(45, 212, 191, 0.12);
          border: 1px solid rgba(45, 212, 191, 0.4);
          border-radius: 9999px;
          padding: 1px 8px;
          font-size: 0.7rem;
          font-weight: 700;
          color: #2dd4bf;
          text-decoration: none;
        }
        .mkt-tshot:hover {
          background: rgba(45, 212, 191, 0.22);
        }
        .mkt-ext {
          color: inherit;
          text-decoration: underline;
          text-decoration-style: dotted;
          text-decoration-color: rgba(148, 163, 184, 0.45);
          text-underline-offset: 3px;
        }
        .mkt-ext:hover {
          text-decoration-style: solid;
          text-decoration-color: currentColor;
        }
        .mkt-addr {
          color: var(--primary-hover);
          text-decoration: none;
          font-size: 0.82rem;
        }
        .mkt-addr:hover {
          text-decoration: underline;
        }
        .mkt-col-addr {
          white-space: nowrap;
          font-size: 0.78rem;
        }
        /* One party per line, roles in a fixed slot so the addresses
           align down the column */
        .mkt-party {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }
        .mkt-role {
          font-size: 0.68rem;
          min-width: 34px;
        }
        .mkt-mobile-addr {
          display: none;
        }
        @media (max-width: 900px) {
          th.mkt-col-addr, td.mkt-col-addr {
            display: none;
          }
          .mkt-mobile-addr {
            display: block;
          }
        }
        .mkt-expand-row td {
          background: rgba(0, 0, 0, 0.25);
          padding: 0;
        }
        .mkt-payload {
          margin: 0;
          padding: 12px 14px;
          font-size: 0.75rem;
          line-height: 1.5;
          font-family: var(--font-mono);
          color: var(--text-main);
          white-space: pre-wrap;
          word-break: break-word;
        }
        .mkt-older-btn { margin-left: 8px; padding: 4px 12px; font-size: 0.85rem; }
        .mkt-truncated {
          font-size: 0.78rem;
          text-align: center;
          margin: 10px 0 0;
        }
        @media (max-width: 640px) {
          .mkt-group-name {
            min-width: 100%;
          }
          .mkt-table th.mkt-age-col, .mkt-table td.mkt-age {
            display: none;
          }
          .mkt-table {
            font-size: 0.8rem;
          }
          .mkt-table td {
            padding: 6px 6px;
          }
        }
      `}</style>
    </div>
  );
}
