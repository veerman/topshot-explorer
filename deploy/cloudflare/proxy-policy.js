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
