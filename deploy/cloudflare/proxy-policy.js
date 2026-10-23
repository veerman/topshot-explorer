// What the /flow/* proxy will forward. The site is not a general Flow
// gateway: only the reads the app makes pass through, transactions never
// do (the app sends none), and a body has a ceiling so the proxy, which
// reads it into memory to hash it, cannot be fed a giant one.

export const PROXY_BODY_MAX = 256 * 1024;

const ALLOWED = [
  ["POST", /^\/v1\/scripts$/],
  ["GET", /^\/v1\/blocks(\/[0-9a-fA-F]+)?$/],
  ["GET", /^\/v1\/events$/],
  ["GET", /^\/v1\/accounts\/(0x)?[0-9a-fA-F]{16}(\/keys\/\d+)?$/],
  ["GET", /^\/v1\/transactions\/[0-9a-fA-F]+$/],
  ["GET", /^\/v1\/transaction_results\/[0-9a-fA-F]+$/],
  ["GET", /^\/v1\/network\/parameters$/],
  ["GET", /^\/v1\/node_version_info$/]
];

/** True when this method and upstream path are one of the app's reads */
export const proxyAllowed = (method, path) => {
  const m = method === "HEAD" ? "GET" : method;
  return ALLOWED.some(([allowedMethod, re]) => allowedMethod === m && re.test(path));
};

// How long a cached script result is kept. Play metadata changes rarely
// (an admin can edit it since the contract update of 2026-09-22), so the
// app's play-batch script, recognizable by its PlayInfo struct, keeps a
// day: a warm edge hit for nearly every visitor, and an on-chain edit
// reaches the browsers' rolling play refresh within days. Everything else
// (set details, mint counts, counters, collections) keeps changing and
// stays at five minutes.
export const SCRIPT_TTL_SECONDS = 300;
export const PLAY_SCRIPT_TTL_SECONDS = 86400;
const PLAY_SCRIPT_MARKER = "struct PlayInfo";

// The script result, as JSON-Cadence, from the access node's answer (a
// JSON string holding base64)
const cadenceOf = (bytes) => JSON.parse(atob(JSON.parse(new TextDecoder().decode(bytes))));

/**
 * The TTL for a script answer from the request and response bodies. A play
 * asked for before it is minted answers `metadata: nil`; that answer
 * changes at the mint, so it never gets the long tier (it used to be kept
 * a week, and a play opened early stayed "could not be fetched").
 */
export const scriptTtl = (requestBytes, responseBytes) => {
  try {
    const body = JSON.parse(new TextDecoder().decode(requestBytes));
    if (!atob(body.script || "").includes(PLAY_SCRIPT_MARKER)) return SCRIPT_TTL_SECONDS;
    const plays = cadenceOf(responseBytes).value || [];
    const missing = plays.some((s) => ((s.value && s.value.fields) || []).some((f) => f.name === "metadata" && (!f.value || f.value.value === null)));
    return missing ? SCRIPT_TTL_SECONDS : PLAY_SCRIPT_TTL_SECONDS;
  } catch {
    return SCRIPT_TTL_SECONDS;
  }
};
