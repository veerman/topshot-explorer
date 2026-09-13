// Optional edge layer: a caching proxy in front of Flow's public REST API.
// The app itself never depends on this file; the default build talks to
// rest-mainnet.onflow.org directly. A public deployment builds with
// VITE_FLOW_ACCESS_NODE=/flow (npm run build:cloudflare) so every visitor's
// script executions land here and share one cached result per body per TTL
// instead of each browser hammering the public access node.
//
// The contract is host-agnostic (see README): serve dist/ with an SPA
// fallback, reverse-proxy /flow/* to rest-mainnet.onflow.org, and cache
// successful POST /v1/scripts responses keyed by a hash of the body. nginx
// proxy_cache or any CDN can implement the same thing. GET /lookup/user/<name>
// (a Top Shot username to its Flow address, read from the public profile
// page) is the one other route; see lookup.js.

import { getSealedHeight, MAX_EVENT_SPAN } from "../../src/services/flowEvents.service.js";
import { lookupUser } from "./lookup.js";
import {
  makeChallenge, verifySignIn, makeSession, readSession, cookieValue, sessionCookie, clearedCookie,
  sessionMayLookup, DENIED_FLAG, SESSION_COOKIE
} from "./auth.js";
import { signWall, wallEntryFor, wallPending } from "./wall.js";
import { fetchAccountGraph, wallKindOf, WALL_NOT_ELIGIBLE } from "./graph.js";
import { proxyAllowed, PROXY_BODY_MAX } from "./proxy-policy.js";
import {
  bookFromObjects, foldEvents, bakeObjects, mergeAccepted, shardRows, blockTimeMs,
  BOOK_KEY, OTHER_KEY, STATS_KEY, STATE_KEY, shardKey, ACCEPTED_STATE_CAP
} from "../../src/services/offers.core.js";

const FLOW_UPSTREAM = "https://rest-mainnet.onflow.org";
const CACHE_TTL_SECONDS = 300;
// Play metadata is immutable once minted, so the app's play-batch script
// (recognizable by its PlayInfo struct) caches for a week: nearly every
// visitor's biggest sync cost is then a warm edge hit. Everything else
// (set details, mint counts, counters, collections) keeps changing and
// stays at the short TTL.
const IMMUTABLE_TTL_SECONDS = 604800;
const IMMUTABLE_SCRIPT_MARKER = "struct PlayInfo";
// Only deterministic pure reads are cached: Cadence script executions
// against the latest block. FCL sends these as ?block_height=final (the
// bare and sealed forms mean the same thing); a numeric pinned height is
// not the read every visitor repeats, so it passes through uncached.
const CACHEABLE_PATH = "/v1/scripts";
const CACHEABLE_SEARCH = new Set(["", "?block_height=final", "?block_height=sealed"]);

// The script rides base64-encoded in the JSON body; decode it to pick the
// TTL tier. Any parse hiccup just means the short default.
const ttlForBody = (bytes) => {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (atob(body.script || "").includes(IMMUTABLE_SCRIPT_MARKER)) return IMMUTABLE_TTL_SECONDS;
  } catch { /* default tier */ }
  return CACHE_TTL_SECONDS;
};

// ---- per-client limits ----------------------------------------------------
// Two rate-limit bindings (wrangler.jsonc): PROXY_LIMIT for uncached Flow
// reads, generous enough for a cold first sync; ABUSE_LIMIT for the routes
// that turn one cheap request into upstream work (sign-in verification,
// a username fetch from nbatopshot.com, a wall signature). Edge cache hits
// never count. Without a binding the check passes.
const clientKey = (request) => request.headers.get("cf-connecting-ip") || "anonymous";
const overLimit = async (limiter, key) => {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
};
const tooMany = (what) =>
  new Response(JSON.stringify({ error: `too many ${what}; try again in a minute` }), {
    status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" }
  });

const proxyFlow = async (request, url, env, ctx) => {
  const upstreamPath = url.pathname.slice("/flow".length);
  const upstreamUrl = FLOW_UPSTREAM + upstreamPath + url.search;
  // Only the app's own reads pass (proxy-policy.js); nothing else is
  // forwarded, and a declared body over the ceiling is refused unread
  if (!proxyAllowed(request.method, upstreamPath)) return new Response("not proxied", { status: 403 });
  if (Number(request.headers.get("content-length")) > PROXY_BODY_MAX) return new Response("body too large", { status: 413 });
  const forward = (body) =>
    fetch(upstreamUrl, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body
    });

  if (request.method !== "POST" || upstreamPath !== CACHEABLE_PATH || !CACHEABLE_SEARCH.has(url.search)) {
    if (await overLimit(env.PROXY_LIMIT, clientKey(request))) return tooMany("requests");
    return forward(request.method === "GET" || request.method === "HEAD" ? undefined : request.body);
  }

  // Key the cache on the exact request body (script text plus arguments),
  // with the block-height variant kept distinct in the key
  const requestBytes = await request.arrayBuffer();
  if (requestBytes.byteLength > PROXY_BODY_MAX) return new Response("body too large", { status: 413 });
  const digest = await crypto.subtle.digest("SHA-256", requestBytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__flow-cache/${hex}${url.search}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-flow-cache", "HIT");
    return res;
  }
  if (await overLimit(env.PROXY_LIMIT, clientKey(request))) return tooMany("requests");

  const upstream = await forward(requestBytes);
  const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
  const headers = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "x-flow-cache": "MISS"
  };

  // Unlike v1's gRPC-web transport, REST errors arrive as real HTTP error
  // statuses, so "status 200" is the whole cacheability check.
  if (upstream.status === 200) {
    const stored = new Response(bodyBytes, {
      status: 200,
      headers: { ...headers, "cache-control": `public, max-age=${ttlForBody(requestBytes)}` }
    });
    ctx.waitUntil(cache.put(cacheKey, stored));
  }

  return new Response(bodyBytes, { status: upstream.status, headers });
};

// ---- username lookup -----------------------------------------------------
// One profile-page fetch per name per day, shared by every visitor; a miss
// (no such user) is remembered for an hour so retyping does not refetch.
const LOOKUP_HIT_TTL = 86400;
const LOOKUP_MISS_TTL = 3600;

// ---- address lookup ------------------------------------------------------
// GET /lookup/address/<0xaddr>: who an address is, from the lookup table in
// D1 (binding LOOKUP_DB; loaded from a census that is not part of the
// repository): username, wallet
// kind, and the account-linking parents and children with their names.
// One address per request, answers cached a day at the edge, and a rate
// limit per client (binding LOOKUP_LIMIT), so pages get what they show and
// nobody gets the table. Every name the username route resolves is written
// here too, so the table learns.
const LOOKUP_HIT_TTL_ADDR = 86400;
const LOOKUP_MISS_TTL_ADDR = 600; // short: a miss the census names should show within minutes of a push
const normAddr = (a) => { const x = String(a || "").trim().toLowerCase().replace(/^0x/, ""); return /^[0-9a-f]{16}$/.test(x) ? x : null; };

const learnUsername = async (env, body) => {
  const db = env && env.LOOKUP_DB;
  const address = body && normAddr(body.address);
  if (!db || !address || !body.username) return;
  try {
    await db.prepare(`INSERT INTO lookup (address, username, checked_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(address) DO UPDATE SET username = excluded.username, checked_at = excluded.checked_at`)
      .bind(address, body.username, body.fetchedAt || new Date().toISOString()).run();
  } catch (err) {
    console.log(`lookup: could not record ${body.username}: ${err.message || err}`);
  }
};

const parseList = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(normAddr).filter(Boolean) : []; } catch { return []; } };

// An address the table does not know is worth knowing next time: the
// misses table is what the census refresh pulls, names, and clears
const recordMiss = async (env, address) => {
  try {
    const t = new Date().toISOString();
    await env.LOOKUP_DB.prepare(`INSERT INTO misses (address, first_seen, last_seen, hits) VALUES (?1, ?2, ?2, 1)
      ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen, hits = misses.hits + 1`).bind(address, t).run();
  } catch (err) {
    console.log(`lookup: could not record miss ${address}: ${err.message || err}`);
  }
};

// ---- wallet sign-in --------------------------------------------------------
// See auth.js. The session secret is a Worker secret (wrangler secret put
// SESSION_SECRET); without it the routes answer 503 and the app shows
// addresses only. The deny list is a D1 table `denied(address)`: a denied
// address signs in like anyone else and gets a flagged session that the
// gated routes treat as anonymous (nothing tells them so).
const FLOW_REST = "https://rest-mainnet.onflow.org";

const isDenied = async (env, address) => {
  if (!env.LOOKUP_DB) return false;
  try {
    const row = await env.LOOKUP_DB.prepare("SELECT 1 AS x FROM denied WHERE address = ?1").bind(address.replace(/^0x/, "")).first();
    return Boolean(row);
  } catch {
    return false; // no table on this host
  }
};

const sessionOf = async (request, env) => {
  if (!env.SESSION_SECRET) return null;
  return readSession(env.SESSION_SECRET, cookieValue(request.headers.get("cookie"), SESSION_COOKIE));
};

const authRoutes = async (url, request, env) => {
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  if (!env.SESSION_SECRET) return json(503, { error: "sign-in is not set up on this host" });
  const secure = url.protocol === "https:";
  const path = url.pathname;
  if (path === "/auth/challenge" && request.method === "GET") {
    const ch = await makeChallenge(env.SESSION_SECRET, url.searchParams.get("address"), url.host);
    return ch ? json(200, ch) : json(400, { error: "not a Flow address" });
  }
  if (path === "/auth/verify" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "expected JSON" }); }
    // Each attempt runs a script on the access node, so attempts are
    // limited per client; a real wallet needs one or two
    if (await overLimit(env.ABUSE_LIMIT, `verify:${clientKey(request)}`)) return tooMany("sign-in attempts");
    const result = await verifySignIn(env.SESSION_SECRET, FLOW_REST, url.host, body);
    if (!result.ok) return json(401, { error: result.error });
    const flags = (await isDenied(env, result.address)) ? DENIED_FLAG : "";
    const token = await makeSession(env.SESSION_SECRET, result.address, flags);
    return json(200, { address: result.address }, { "set-cookie": sessionCookie(token, secure) });
  }
  if (path === "/auth/signout" && request.method === "POST") {
    return json(200, { ok: true }, { "set-cookie": clearedCookie(secure) });
  }
  if (path === "/auth/me" && request.method === "GET") {
    const session = await sessionOf(request, env);
    return session ? json(200, { address: session.address }) : json(401, { error: "not signed in" });
  }
  return json(404, { error: "no such route" });
};

// ---- Early Adopters wall (see wall.js) ---------------------------------
const sealedHeight = async () => {
  try {
    const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`);
    const j = await res.json();
    return Number(j[0] && j[0].header && j[0].header.height) || null;
  } catch {
    return null;
  }
};

const wallRoutes = async (url, request, env, ctx) => {
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  if (!env.LOOKUP_DB) return json(404, { error: "no wall on this host" });
  const path = url.pathname;
  if (path === "/wall/pending" && request.method === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    // Ten seconds at the edge: launch-day readers all ask the same
    // question. One list is cached whatever `after` says, and filtered
    // here, so the parameter cannot be varied to reach the database.
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/__wall-cache/pending`);
    const cached = await cache.match(cacheKey);
    let full;
    if (cached) {
      full = await cached.json();
    } else {
      full = await wallPending(env.LOOKUP_DB, 0, 2000);
      const stored = new Response(JSON.stringify(full), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=10" } });
      ctx.waitUntil(cache.put(cacheKey, stored));
    }
    const body = { total: full.total, entries: (full.entries || []).filter((e) => e.seq > after) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=10" } });
  }
  const session = await sessionOf(request, env);
  if (!session) return json(401, { error: "sign in with your wallet first" });
  if (path === "/wall/me" && request.method === "GET") {
    const entry = await wallEntryFor(env.LOOKUP_DB, session.address);
    return entry ? json(200, entry) : json(404, { error: "not signed yet" });
  }
  if (path === "/wall/sign" && request.method === "POST") {
    // A signature reads the account graph from the chain and writes a
    // row; a few per minute per wallet is plenty
    if (await overLimit(env.ABUSE_LIMIT, `wall:${session.address}`)) return tooMany("signatures");
    let body;
    try { body = (await request.json()) || {}; } catch { body = {}; }
    // Who is signing, from the chain: a Dapper wallet, or a wallet
    // that is a parent of one; anything else is turned away in words
    const graph = await fetchAccountGraph(FLOW_REST, session.address);
    const kind = wallKindOf(graph);
    if (!kind) return json(403, { error: WALL_NOT_ELIGIBLE });
    const nameOf = async (addr) => {
      const row = await env.LOOKUP_DB.prepare("SELECT username FROM lookup WHERE address = ?1").bind(addr.replace(/^0x/, "")).first();
      return (row && row.username) || null;
    };
    const dapperChildren = graph.children.filter((c) => c.dapper).map((c) => c.address);
    let username = await nameOf(session.address);
    if (!username && kind === "parent") {
      for (const c of dapperChildren) { username = await nameOf(c); if (username) break; }
    }
    const facts = { kind, username, dapper: graph.dapper, parents: graph.parents.map((p) => p.address), children: dapperChildren };
    return json(200, await signWall(env.LOOKUP_DB, session.address, body.showName !== false, facts, await sealedHeight()));
  }
  return json(404, { error: "no such route" });
};

const lookupAddress = async (url, request, env, ctx) => {
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
  const address = normAddr(url.pathname.slice("/lookup/address/".length));
  if (!address) return json(400, { error: "not a Flow address" });
  if (!env.LOOKUP_DB) return json(404, { error: "no lookup table on this host" });
  // Names are for people who signed in with a wallet (a flagged session
  // reads as anonymous here). Checked before the cache so a cached answer
  // never leaks past the gate.
  if (!sessionMayLookup(await sessionOf(request, env))) return json(401, { error: "sign in with your wallet to see usernames" });

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__lookup-cache/address/${address}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-lookup-cache", "HIT");
    return res;
  }
  if (await overLimit(env.LOOKUP_LIMIT, clientKey(request))) return tooMany("lookups");

  const row = await env.LOOKUP_DB.prepare("SELECT username, dapper, parents, children, checked_at FROM lookup WHERE address = ?1").bind(address).first();
  let status = 404;
  let body = { address: `0x${address}` };
  if (!row) ctx.waitUntil(recordMiss(env, address));
  if (row) {
    const parents = parseList(row.parents);
    const children = parseList(row.children);
    const related = [...new Set([...parents, ...children])];
    const names = new Map();
    if (related.length > 0) {
      const marks = related.map((_, i) => `?${i + 1}`).join(",");
      const r = await env.LOOKUP_DB.prepare(`SELECT address, username FROM lookup WHERE address IN (${marks})`).bind(...related).all();
      (r.results || []).forEach((x) => names.set(x.address, x.username || null));
    }
    const withName = (a) => ({ address: `0x${a}`, username: names.get(a) || null });
    status = 200;
    body = {
      address: `0x${address}`,
      username: row.username || null,
      dapper: row.dapper === null ? null : Boolean(row.dapper),
      parents: parents.map(withName),
      children: children.map(withName),
      checkedAt: row.checked_at || null
    };
  }
  const ttl = status === 200 ? LOOKUP_HIT_TTL_ADDR : LOOKUP_MISS_TTL_ADDR;
  const stored = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
  ctx.waitUntil(cache.put(cacheKey, stored.clone()));
  const res = new Response(stored.body, stored);
  res.headers.set("x-lookup-cache", "MISS");
  return res;
};

const lookupUsername = async (url, request, env, ctx) => {
  const name = decodeURIComponent(url.pathname.slice("/lookup/user/".length)).trim().replace(/^@/, "");
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

  // Keyed by the name AS TYPED: the profile page is case sensitive
  // (Libruary resolves, libruary does not), so a lowercased key would let
  // one casing's miss shadow another's hit for an hour
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__lookup-cache/user/${encodeURIComponent(name)}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-lookup-cache", "HIT");
    return res;
  }

  // A miss at the edge is a fetch of the profile page on nbatopshot.com,
  // so misses are limited per client: an enumeration run stops here
  // instead of getting this host's addresses blocked over there
  if (await overLimit(env.ABUSE_LIMIT, `user:${clientKey(request)}`)) return tooMany("lookups");
  const { status, body } = await lookupUser(name);
  if (status === 200) ctx.waitUntil(learnUsername(env, body));
  if (status === 200 || status === 404) {
    const ttl = status === 200 ? LOOKUP_HIT_TTL : LOOKUP_MISS_TTL;
    const stored = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(cacheKey, stored.clone()));
    const res = new Response(stored.body, stored);
    res.headers.set("x-lookup-cache", "MISS");
    return res;
  }
  return json(status, body, { "x-lookup-cache": "MISS" });
};

// ---- offers fold (cron) -------------------------------------------------
// Every half hour: read the published offers book and the fold state from
// the cache bucket, apply the offer events since the state's height, and
// republish (src/services/offers.core.js explains the design). Bounded per
// run so a long gap (the cron was off) is caught up in slices: 400
// windows is ~20 hours of blocks and ~800 event requests, inside the
// invocation's request budget. The base itself comes from `npm run
// offers` on a developer's machine, which also verifies the book against
// every buyer's live collection; nothing here enumerates buyers.
const FOLD_MAX_WINDOWS = 400;
const FOLD_CONCURRENCY = 6;

const readJson = async (bucket, key) => {
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
};
const putJson = (bucket, key, value, cacheControl) =>
  bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json", cacheControl } });

async function foldOffers(env) {
  const bucket = env.CACHE_BUCKET;
  if (!bucket) { console.log("offers fold: no CACHE_BUCKET binding"); return; }
  const [state, bookObj, otherObj] = await Promise.all([readJson(bucket, STATE_KEY), readJson(bucket, BOOK_KEY), readJson(bucket, OTHER_KEY)]);
  if (!state || !bookObj) { console.log("offers fold: no base in the bucket yet (run npm run offers once)"); return; }
  const book = bookFromObjects(bookObj, otherObj);
  const tip = await getSealedHeight();
  const from = Number(state.height) + 1;
  if (from > tip) { console.log(`offers fold: nothing new past ${state.height}`); return; }
  const to = Math.min(tip, from + FOLD_MAX_WINDOWS * MAX_EVENT_SPAN - 1);
  const r = await foldEvents(book, state, from, to, { concurrency: FOLD_CONCURRENCY });
  state.height = to;
  state.accepted = mergeAccepted(state.accepted, r.accepted, ACCEPTED_STATE_CAP);
  const timeMs = await blockTimeMs(to);
  const objects = bakeObjects(book, state, { height: to, time: timeMs ? new Date(timeMs).toISOString() : null });
  const writes = [
    putJson(bucket, BOOK_KEY, objects[BOOK_KEY], "public, max-age=120"),
    putJson(bucket, OTHER_KEY, objects[OTHER_KEY], "public, max-age=120"),
    putJson(bucket, STATS_KEY, objects[STATS_KEY], "public, max-age=120")
  ];
  // The archive: one object per month, appended, never trimmed
  for (const [month, rows] of Object.entries(shardRows(r.accepted))) {
    const shard = (await readJson(bucket, shardKey(month))) || { month, rows: [] };
    shard.rows = mergeAccepted(shard.rows, rows);
    shard.updatedAt = Date.now();
    writes.push(putJson(bucket, shardKey(month), shard, "public, max-age=3600"));
  }
  await Promise.all(writes);
  // State last: its height only advances once the matching book is out
  await putJson(bucket, STATE_KEY, state, "no-store");
  console.log(`offers fold: ${from}..${to} (${r.windows} windows) +${r.added} -${r.removed} offers, ${r.accepted.length} accepted${to < tip ? `; ${tip - to} heights still behind` : ""}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(foldOffers(env).catch((err) => console.error("offers fold failed:", err)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/flow/")) {
      try {
        return await proxyFlow(request, url, env, ctx);
      } catch (err) {
        console.error("flow proxy error:", err);
        return new Response("flow proxy error", { status: 502 });
      }
    }
    if (url.pathname.startsWith("/auth/")) {
      try {
        return await authRoutes(url, request, env);
      } catch (err) {
        console.error("auth error:", err);
        const why = String((err && err.message) || err).slice(0, 300);
        return new Response(JSON.stringify({ error: `sign-in failed: ${why}` }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname.startsWith("/wall/")) {
      try {
        return await wallRoutes(url, request, env, ctx);
      } catch (err) {
        console.error("wall error:", err);
        return new Response(JSON.stringify({ error: "the wall did not answer" }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname.startsWith("/lookup/user/") && request.method === "GET") {
      try {
        return await lookupUsername(url, request, env, ctx);
      } catch (err) {
        console.error("username lookup error:", err);
        return new Response(JSON.stringify({ error: "lookup failed" }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname.startsWith("/lookup/address/") && request.method === "GET") {
      try {
        return await lookupAddress(url, request, env, ctx);
      } catch (err) {
        console.error("address lookup error:", err);
        return new Response(JSON.stringify({ error: "lookup failed" }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    // Only /flow/*, /lookup/*, /auth/* and /wall/* are routed here via run_worker_first;
    // anything else that arrives falls through to the asset layer
    return env.ASSETS.fetch(request);
  }
};
