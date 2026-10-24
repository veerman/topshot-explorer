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
  sessionMayLookup, normAddress, DENIED_FLAG, SESSION_COOKIE
} from "./auth.js";
import { signWall, wallEntryFor, wallPending, WALL_CLOSED, WALL_CLOSED_MESSAGE } from "./wall.js";
import { fetchAccountGraph, wallKindOf, WALL_NOT_ELIGIBLE } from "./graph.js";
import { proxyAllowed, PROXY_BODY_MAX, scriptTtl } from "./proxy-policy.js";
import {
  bookFromObjects, foldEvents, bakeObjects, mergeAccepted, shardRows, blockTimeMs,
  BOOK_KEY, OTHER_KEY, STATS_KEY, STATE_KEY, shardKey, ACCEPTED_STATE_CAP
} from "../../src/services/offers.core.js";

const FLOW_UPSTREAM = "https://rest-mainnet.onflow.org";
// TTL tiers: scriptTtl in proxy-policy.js (a day for play metadata, five
// minutes for everything else).
// Only deterministic pure reads are cached: Cadence script executions
// against the latest block. FCL sends these as ?block_height=final (the
// bare and sealed forms mean the same thing); a numeric pinned height is
// not the read every visitor repeats, so it passes through uncached.
const CACHEABLE_PATH = "/v1/scripts";
const CACHEABLE_SEARCH = new Set(["", "?block_height=final", "?block_height=sealed"]);

// ---- per-client limits ----------------------------------------------------
// Two rate-limit bindings (wrangler.jsonc): PROXY_LIMIT for uncached Flow
// reads, generous enough for a cold first sync; ABUSE_LIMIT for the routes
// that turn one cheap request into upstream work (sign-in verification,
// a username fetch from nbatopshot.com, a wall signature). Edge cache hits
// never count. Without a binding the check passes.
// An IPv6 client is keyed by its /64, the block one subscriber is given,
// so a rented range cannot spread its requests over fresh addresses
const ipKey = (ip) => {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).join(":")}::/64`;
};
const clientKey = (request) => ipKey(request.headers.get("cf-connecting-ip") || "anonymous");
const overLimit = async (limiter, key) => {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
};
// Every JSON answer; uncached unless `extra` says otherwise
const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const tooMany = (what) => json(429, { error: `too many ${what}; try again in a minute` }, { "retry-after": "60" });

// The access node sends its content type twice, which reads back joined
// ("application/json, application/json; charset=UTF-8"); keep the first
const contentTypeOf = (res) => (res.headers.get("content-type") || "application/json").split(",")[0].trim();

const proxyFlow = async (url, request, env, ctx) => {
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

  // The app runs scripts only against the latest block (the cacheable
  // forms); any other script query is not one of its reads
  if (request.method === "POST" && upstreamPath === CACHEABLE_PATH && !CACHEABLE_SEARCH.has(url.search)) return new Response("not proxied", { status: 403 });
  if (request.method !== "POST" || upstreamPath !== CACHEABLE_PATH) {
    if (await overLimit(env.PROXY_LIMIT, clientKey(request))) return tooMany("requests");
    const upstream = await forward(request.method === "GET" || request.method === "HEAD" ? undefined : request.body);
    // Only what the app reads: the status, the body and its type. The
    // upstream answer passed through whole carried the access node's
    // Access-Control-Allow-Origin: *, so any website could have its
    // visitors' browsers read the chain through this Worker, at the site's
    // cost; the app is same-origin and needs no CORS header.
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": contentTypeOf(upstream) } });
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
    "content-type": contentTypeOf(upstream),
    "x-flow-cache": "MISS"
  };

  // Unlike v1's gRPC-web transport, REST errors arrive as real HTTP error
  // statuses, so "status 200" is the whole cacheability check.
  if (upstream.status === 200) {
    const stored = new Response(bodyBytes, {
      status: 200,
      headers: { ...headers, "cache-control": `public, max-age=${scriptTtl(requestBytes, bodyBytes)}` }
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
// The lookup table keys addresses as bare hex, without the 0x
const normAddr = (a) => { const x = normAddress(a); return x && x.slice(2); };

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

const isDenied = async (env, address) => {
  if (!env.LOOKUP_DB) return false;
  try {
    const row = await env.LOOKUP_DB.prepare("SELECT 1 AS x FROM denied WHERE address = ?1").bind(address.replace(/^0x/, "")).first();
    return Boolean(row);
  } catch {
    return false; // no table on this host
  }
};

// The deny list is read at sign-in (the flag rides in the cookie) and
// again on each name lookup, remembered per isolate for a few minutes: a
// session lasts 30 days, and with the flag alone one minted before the
// address was denied kept reading names that long.
const DENY_MEMO_MS = 5 * 60 * 1000;
const denyMemo = new Map();
const isDeniedNow = async (env, address) => {
  const hit = denyMemo.get(address);
  if (hit && Date.now() - hit.at < DENY_MEMO_MS) return hit.denied;
  const denied = await isDenied(env, address);
  if (denyMemo.size > 5000) denyMemo.clear();
  denyMemo.set(address, { denied, at: Date.now() });
  return denied;
};

const sessionOf = async (request, env) => {
  if (!env.SESSION_SECRET) return null;
  return readSession(env.SESSION_SECRET, cookieValue(request.headers.get("cookie"), SESSION_COOKIE));
};

const authRoutes = async (url, request, env) => {
  if (!env.SESSION_SECRET) return json(503, { error: "sign-in is not set up on this host" });
  const secure = url.protocol === "https:";
  const path = url.pathname;
  if (path === "/auth/challenge" && request.method === "GET") {
    const ch = await makeChallenge(env.SESSION_SECRET, url.searchParams.get("address"));
    return ch ? json(200, ch) : json(400, { error: "not a Flow address" });
  }
  if (path === "/auth/verify" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "expected JSON" }); }
    // Each attempt runs a script on the access node, so attempts are
    // limited per client; a real wallet needs one or two
    if (await overLimit(env.ABUSE_LIMIT, `verify:${clientKey(request)}`)) return tooMany("sign-in attempts");
    const result = await verifySignIn(env.SESSION_SECRET, FLOW_UPSTREAM, body);
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
const sealedHeight = () => getSealedHeight().catch(() => null);

const wallRoutes = async (url, request, env, ctx) => {
  // Closed, the shipped file is the whole wall and the page asks for
  // nothing here: every route answers so before a session or D1 read
  if (WALL_CLOSED) return json(410, { error: WALL_CLOSED_MESSAGE });
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
      ctx.waitUntil(cache.put(cacheKey, json(200, full, { "cache-control": "public, max-age=10" })));
    }
    return json(200, { total: full.total, entries: (full.entries || []).filter((e) => e.seq > after) }, { "cache-control": "public, max-age=10" });
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
    const graph = await fetchAccountGraph(FLOW_UPSTREAM, session.address);
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
  const address = normAddr(url.pathname.slice("/lookup/address/".length));
  if (!address) return json(400, { error: "not a Flow address" });
  if (!env.LOOKUP_DB) return json(404, { error: "no lookup table on this host" });
  // Names are for people who signed in with a wallet (a flagged session
  // reads as anonymous here). Checked before the cache so a cached answer
  // never leaks past the gate.
  const session = await sessionOf(request, env);
  if (!sessionMayLookup(session) || await isDeniedNow(env, session.address)) return json(401, { error: "sign in with your wallet to see usernames" });

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__lookup-cache/address/${address}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-lookup-cache", "HIT");
    return res;
  }
  // Counted per client and per signed-in wallet: a limit per IP alone let
  // one wallet behind many addresses read the table at many times the rate
  if (await overLimit(env.LOOKUP_LIMIT, clientKey(request)) || await overLimit(env.LOOKUP_LIMIT, `wallet:${session.address}`)) return tooMany("lookups");

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
  ctx.waitUntil(cache.put(cacheKey, json(status, body, { "cache-control": `public, max-age=${ttl}` })));
  return json(status, body, { "cache-control": `public, max-age=${ttl}`, "x-lookup-cache": "MISS" });
};

const lookupUsername = async (url, request, env, ctx) => {
  const name = decodeURIComponent(url.pathname.slice("/lookup/user/".length)).trim().replace(/^@/, "");

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
    ctx.waitUntil(cache.put(cacheKey, json(status, body, { "cache-control": `public, max-age=${ttl}` })));
    return json(status, body, { "cache-control": `public, max-age=${ttl}`, "x-lookup-cache": "MISS" });
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
  // As far as the fold really read, which a lagging access node can cut
  // short of `to`; the rest is read by the next run
  state.height = r.height;
  state.accepted = mergeAccepted(state.accepted, r.accepted, ACCEPTED_STATE_CAP);
  const timeMs = await blockTimeMs(r.height);
  const objects = bakeObjects(book, state, { height: r.height, time: timeMs ? new Date(timeMs).toISOString() : null });
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
  console.log(`offers fold: ${from}..${r.height} (${r.windows} windows) +${r.added} -${r.removed} offers, ${r.accepted.length} accepted${r.height < tip ? `; ${tip - r.height} heights still behind` : ""}`);
}

// The routed prefixes (run_worker_first in wrangler.jsonc). A route
// that throws answers 502 in its own words; anything else falls through
// to the asset layer.
const ROUTES = [
  { prefix: "/flow/", name: "flow proxy", run: proxyFlow, failed: () => new Response("flow proxy error", { status: 502 }) },
  { prefix: "/auth/", name: "auth", run: authRoutes, failed: (err) => json(502, { error: `sign-in failed: ${String((err && err.message) || err).slice(0, 300)}` }) },
  { prefix: "/wall/", name: "wall", run: wallRoutes, failed: () => json(502, { error: "the wall did not answer" }) },
  { prefix: "/lookup/user/", method: "GET", name: "username lookup", run: lookupUsername, failed: () => json(502, { error: "lookup failed" }) },
  { prefix: "/lookup/address/", method: "GET", name: "address lookup", run: lookupAddress, failed: () => json(502, { error: "lookup failed" }) }
];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(foldOffers(env).catch((err) => console.error("offers fold failed:", err)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix) && (!r.method || r.method === request.method));
    if (!route) return env.ASSETS.fetch(request);
    try {
      return await route.run(url, request, env, ctx);
    } catch (err) {
      console.error(`${route.name} error:`, err);
      return route.failed(err);
    }
  }
};
