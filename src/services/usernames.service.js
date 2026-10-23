import { useEffect, useState } from "react";
import { usernameOf } from "./account.context";

/**
 * Who an address is, for the pages that show other people's addresses
 * (Offers, Live, the leader boards, the account header): the Top Shot
 * username, and the account linking around it (a wallet that is the
 * parent of a named Dapper wallet, or a Dapper wallet with a parent).
 *
 * Answers come one address at a time from GET /lookup/address/<addr>, the
 * edge route beside the username lookup (deploy/cloudflare/worker.js; the
 * dev server answers it from the local census). Only the addresses a page
 * shows are asked for, answers are cached for the session, and a host
 * without the route degrades to addresses. The browser's own resolved
 * names (account.context) layer on top. Nothing here ever truncates an
 * address or a name.
 */
const cache = new Map();      // address -> { username, dapper, parents: [{address, username}], children: [...] } | null
const inflight = new Map();   // address -> Promise
let available = true;         // false once the host answers with no JSON
let version = 0;
const listeners = new Set();
const bump = () => { version += 1; listeners.forEach((fn) => fn(version)); };
// The host answered 401: names are for signed-in readers here. Nothing is
// cached for gated answers, so a sign-in can ask again (resetLookups).
let gated = false;
export const isGated = () => gated;
// Whether names may be asked for at all, as the one /auth/me check says
// (wallet.service sets it): null until that answers, and lookups wait for
// it. Asking first sent one doomed 401 per address on screen, a hundred
// or more on Live and Offers, for every signed-out reader.
let open = null;
// At most this many lookups at once; the rest wait their turn. After a
// 429 (the route allows 60 misses a minute per client), a server error or
// a network failure, the address waits too, and nothing is asked before
// retryAt: those answers used to be cached as "no name" for the session.
const MAX_IN_FLIGHT = 6;
const queued = new Set();
let active = 0;
let retryAt = 0;
let retryTimer = null;
const RETRY = Symbol("retry");

export function resetLookups() {
  cache.clear();
  inflight.clear();
  queued.clear();
  gated = open === false;
  available = true;
  retryAt = 0;
  bump();
}

/**
 * The session check's answer: names may be asked for (signed in) or not.
 * Closed on a host that signs readers in, it is gated (the pages offer the
 * sign-in line); on a host without sign-in there are simply no names.
 */
export function setLookupGate(isOpen, hostSignsIn = true) {
  open = Boolean(isOpen);
  if (!hostSignsIn) available = false;
  gated = !open && hostSignsIn;
  if (!open) queued.clear();
  bump();
  pump();
}

function pump() {
  if (open !== true || !available || gated) return;
  const wait = retryAt - Date.now();
  if (wait > 0) {
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; pump(); }, wait);
    return;
  }
  for (const a of queued) {
    if (active >= MAX_IN_FLIGHT) break;
    queued.delete(a);
    start(a);
  }
}

function start(a) {
  active += 1;
  const p = fetch(`/lookup/address/${a}`, { headers: { accept: "application/json" } })
    .then(async (res) => {
      if (!(res.headers.get("content-type") || "").includes("application/json")) { available = false; return null; }
      if (res.status === 401) { gated = true; return undefined; }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        retryAt = Math.max(retryAt, Date.now() + (Number(res.headers.get("retry-after")) || 30) * 1000);
        return RETRY;
      }
      if (!res.ok) return null;
      return await res.json();
    })
    .catch(() => {
      retryAt = Math.max(retryAt, Date.now() + 30000);
      return RETRY;
    })
    .then((rec) => {
      active -= 1;
      inflight.delete(a);
      // undefined = gated: remembered as nothing, so a later sign-in retries
      if (rec === RETRY) queued.add(a);
      else if (rec !== undefined) cache.set(a, rec);
      bump();
      pump();
      return rec === undefined || rec === RETRY ? null : rec;
    });
  inflight.set(a, p);
}

const norm = (address) => {
  const a = String(address || "").trim().toLowerCase();
  return a ? (a.startsWith("0x") ? a : `0x${a}`) : "";
};

/**
 * Ask for one address's record (memoised). Resolves to the record, or to
 * null while it waits its turn: the answer lands in the cache and every
 * subscribed page re-renders (bump).
 */
export function lookupAddress(address) {
  const a = norm(address);
  if (!a) return Promise.resolve(null);
  if (cache.has(a)) return Promise.resolve(cache.get(a));
  if (inflight.has(a)) return inflight.get(a);
  if (!available || gated || open === false) return Promise.resolve(null);
  queued.add(a);
  pump();
  return inflight.get(a) || Promise.resolve(null);
}

/** The record if already known; asks for it otherwise (null meanwhile) */
export function recordOf(address) {
  const a = norm(address);
  if (!a) return null;
  if (!cache.has(a)) { lookupAddress(a); return null; }
  return cache.get(a);
}

/** The username for an address, from the route or this browser; null when unknown */
export function nameOf(address) {
  const a = norm(address);
  if (!a) return null;
  const rec = recordOf(a);
  return (rec && rec.username) || usernameOf(a) || null;
}

/**
 * How to introduce an address: its own username, or the name it is linked
 * to. { text, detail } where text is "@name" or "@name · parent" and
 * detail explains the link for a hover; null when nothing is known.
 */
export function introOf(address) {
  const a = norm(address);
  if (!a) return null;
  const rec = recordOf(a);
  const own = (rec && rec.username) || usernameOf(a);
  if (own) {
    const parents = (rec && rec.parents) || [];
    const detail = parents.length > 0
      ? `@${own}; a Dapper wallet linked to ${parents.map((p) => `${p.address}${p.username ? ` (@${p.username})` : ""}`).join(", ")}`
      : `@${own}`;
    return { text: `@${own}`, detail };
  }
  const namedChildren = ((rec && rec.children) || []).filter((c) => c.username);
  if (namedChildren.length > 0) {
    const first = namedChildren[0];
    return {
      text: `@${first.username} · parent`,
      detail: `The wallet that ${namedChildren.map((c) => `@${c.username} (${c.address})`).join(" and ")} ${namedChildren.length === 1 ? "is" : "are"} linked to`
    };
  }
  return null;
}

/** Hover text for a link showing an address: the address, and who it is when known */
export const addressTitle = (address, suffix) => {
  const intro = introOf(address);
  const who = intro ? `${intro.detail}; ${address}` : address;
  return suffix ? `${who}; ${suffix}` : who;
};

/** Subscribe a component to lookups; it re-renders as answers arrive */
export function useUsernames() {
  const [, setV] = useState(version);
  useEffect(() => {
    listeners.add(setV);
    return () => listeners.delete(setV);
  }, []);
  return nameOf;
}
