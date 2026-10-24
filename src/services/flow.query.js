/*
 * Cadence script reads without FCL. Every caller gets exactly what
 * fcl.query returned: the same POST /v1/scripts?block_height=final, script
 * and arguments base64 in the same JSON body with no content type (so a
 * cross-origin call stays a simple request with no preflight), the same
 * retries, and FCL's decoder (integers and fixed-point numbers as
 * strings, optionals as null, structs as plain objects). The bodies are
 * byte for byte FCL's, so the caching proxy's keys and its play-batch tier
 * are unchanged. FCL itself then loads only for a wallet (wallet.service).
 */

let accessNode = "https://rest-mainnet.onflow.org";
export const setAccessNode = (url) => { accessNode = String(url).replace(/\/+$/, ""); };
export const getAccessNode = () => accessNode;

// The argument types the app's scripts use, encoded as @onflow/types does
const scalar = (type) => ({ asArgument: (v) => ({ type, value: typeof v === "number" ? v.toString() : v }) });
export const t = {
  UInt32: scalar("UInt32"),
  UInt64: scalar("UInt64"),
  Int: scalar("Int"),
  String: scalar("String"),
  Address: scalar("Address"),
  Array: (child) => ({ asArgument: (v) => ({ type: "Array", value: v.map((x) => child.asArgument(x)) }) }),
  Optional: (child) => ({ asArgument: (v) => ({ type: "Optional", value: v == null ? null : child.asArgument(v) }) })
};
const arg = (value, type) => type.asArgument(value);

// UTF-8 base64 both ways, as FCL's Buffer does (play names carry accents)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// FCL's default decoders (@onflow/sdk), synchronously
const IMPLICIT = new Set([
  "UInt", "Int", "UInt8", "Int8", "UInt16", "Int16", "UInt32", "Int32", "UInt64", "Int64",
  "UInt128", "Int128", "UInt256", "Int256", "Word8", "Word16", "Word32", "Word64", "Word128", "Word256",
  "UFix64", "Fix64", "UFix128", "Fix128", "String", "Character", "Bool", "Address", "Reference", "Path", "Capability"
]);
const COMPOSITE = new Set(["Event", "Resource", "Struct", "Enum"]);
export function decodeCadence(v) {
  if (IMPLICIT.has(v.type)) return v.value;
  if (v.type === "Void") return null;
  if (v.type === "Optional") return v.value ? decodeCadence(v.value) : null;
  if (v.type === "Array") return v.value.map(decodeCadence);
  if (v.type === "Dictionary") {
    const out = {};
    v.value.forEach((kv) => { out[decodeCadence(kv.key)] = decodeCadence(kv.value); });
    return out;
  }
  if (COMPOSITE.has(v.type)) {
    const out = {};
    v.value.fields.forEach((f) => { out[f.name] = decodeCadence(f.value); });
    return out;
  }
  if (v.type === "Type") return v.value.staticType;
  if (v.type === "InclusiveRange") {
    const out = {};
    ["start", "end", "step"].forEach((k) => { if (k in v.value) out[k] = decodeCadence(v.value[k]); });
    return out;
  }
  throw new Error(`Undefined Decoder Error: ${v.type}`);
}

// FCL's retry policy: up to five more tries a second apart on these
// statuses or a timed-out request
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_LIMIT = 5;
const TIMEOUT_MS = 30000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fcl.query's shape: { cadence, args: (arg, t) => [...] }, resolving to the decoded result */
export async function query({ cadence, args }) {
  const body = JSON.stringify({
    script: toBase64(cadence),
    arguments: (args ? args(arg, t) : []).map((a) => toBase64(JSON.stringify(a)))
  });
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${accessNode}/v1/scripts?block_height=final`, { method: "POST", body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError" && attempt < RETRY_LIMIT) { await wait(1000); continue; }
      throw err;
    }
    clearTimeout(timer);
    if (res.ok) return decodeCadence(JSON.parse(fromBase64(await res.json())));
    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_LIMIT) { await wait(1000); continue; }
    const text = await res.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text).message || text; } catch { /* not JSON */ }
    throw new Error(`Flow script failed (HTTP ${res.status}): ${message}`);
  }
}
