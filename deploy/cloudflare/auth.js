// Wallet sign-in: a wallet signs a short message, the chain confirms
// the signature belongs to the address, and the host answers with a
// signed cookie that later requests carry. No account is created, nothing
// is stored server-side, and the proof is the same one anyone can re-run
// against the chain. Shared by the Cloudflare Worker (worker.js) and the
// Vite dev server (vite.config.js); Web Crypto only, so it runs in both.
//
// The flow, three requests:
//   GET  /auth/challenge?address=0x..  -> the message to sign (a nonce the
//        host can recompute, so it keeps no state)
//   POST /auth/verify { address, issuedAt, nonce, signatures }  -> the host
//        checks the nonce, then asks FCLCrypto.verifyUserSignatures on
//        chain, then sets the session cookie
//   GET  /auth/me  -> who the cookie says, or 401
// Sessions are HMAC-signed JSON, 30 days, and carry only the address plus
// a flags field; a denied address gets a session like any other, flagged.

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const utf8 = (bytes) => new TextDecoder().decode(bytes);

export const SESSION_COOKIE = "ts_session";
export const SESSION_TTL_S = 30 * 24 * 3600;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const FCL_CRYPTO_ADDRESS = "0xb4b82a1c9d21d284"; // mainnet FCLCrypto

export const normAddress = (a) => {
  const x = String(a || "").trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{16}$/.test(x) ? `0x${x}` : null;
};

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
};

// ---- challenge -----------------------------------------------------------

/** The nonce for an address at an issue time: recomputable, so stateless */
export async function nonceFor(secret, address, issuedAt) {
  return (await hmac(secret, `challenge:${address}:${issuedAt}`)).slice(0, 32);
}

/**
 * The exact text a wallet signs; the wallet shows it, so it is four
 * short labelled lines. The site line
 * names the real domain whatever host is serving it; the host is not
 * part of the message, the nonce (which the host derives) is what ties
 * a signature to one issue for one address.
 */
export function signInMessage({ address, issuedAt, nonce }) {
  return [
    `user: ${address}`,
    "site: topshotexplorer.com",
    `date: ${issuedAt}`,
    `code: ${nonce}`,
  ].join("\n");
}

export const toHex = (s) => Array.from(enc.encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

export async function makeChallenge(secret, rawAddress, host, now = new Date()) {
  const address = normAddress(rawAddress);
  if (!address) return null;
  const issuedAt = now.toISOString();
  const nonce = await nonceFor(secret, address, issuedAt);
  const message = signInMessage({ address, issuedAt, nonce, host });
  return { address, issuedAt, nonce, message, messageHex: toHex(message) };
}

// ---- on-chain verification -------------------------------------------------

const VERIFY_SCRIPT = `
import FCLCrypto from ${FCL_CRYPTO_ADDRESS}

access(all) fun main(address: Address, message: String, keyIndices: [Int], signatures: [String]): Bool {
  return FCLCrypto.verifyUserSignatures(address: address, message: message, keyIndices: keyIndices, signatures: signatures)
}`;

const cadence = (type, value) => ({ type, value });
const encodeArg = (v) => b64(JSON.stringify(v));

/**
 * Ask the chain whether these composite signatures, from FCL's
 * signUserMessage, are the address's own for the hex message. Signatures
 * are [{ addr, keyId, signature }]; any from another address are ignored.
 */
export async function verifyUserSignatures(restBase, address, messageHex, signatures, fetchImpl = fetch) {
  const own = (signatures || []).filter((s) => s && normAddress(s.addr) === address && /^[0-9a-f]+$/i.test(String(s.signature || "")));
  if (own.length === 0) return false;
  const body = {
    script: b64(VERIFY_SCRIPT),
    arguments: [
      encodeArg(cadence("Address", address)),
      encodeArg(cadence("String", messageHex)),
      encodeArg(cadence("Array", own.map((s) => cadence("Int", String(Number(s.keyId))))) ),
      encodeArg(cadence("Array", own.map((s) => cadence("String", String(s.signature)))))
    ]
  };
  const res = await fetchImpl(`${restBase}/v1/scripts?block_height=sealed`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`verify script ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // The result is a JSON string holding base64 JSON-Cadence: {"type":"Bool","value":true}
  const raw = JSON.parse(await res.text());
  const decoded = JSON.parse(utf8(Uint8Array.from(atob(String(raw)), (c) => c.charCodeAt(0))));
  return decoded && decoded.type === "Bool" && decoded.value === true;
}

/** The full verify step: nonce recomputed, issue time fresh, chain agrees */
export async function verifySignIn(secret, restBase, host, body, fetchImpl = fetch, now = Date.now()) {
  const address = normAddress(body && body.address);
  const issuedAt = String((body && body.issuedAt) || "");
  const nonce = String((body && body.nonce) || "");
  if (!address || !issuedAt || !nonce) return { ok: false, error: "incomplete sign-in" };
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued) || now - issued > CHALLENGE_TTL_MS || issued - now > 60 * 1000) return { ok: false, error: "the sign-in request expired; try again" };
  const expected = await nonceFor(secret, address, issuedAt);
  if (!timingSafeEqual(expected, nonce)) return { ok: false, error: "the sign-in request did not match; try again" };
  const messageHex = toHex(signInMessage({ address, issuedAt, nonce, host }));
  const valid = await verifyUserSignatures(restBase, address, messageHex, body.signatures, fetchImpl);
  if (!valid) return { ok: false, error: "the wallet's signature did not verify on chain" };
  return { ok: true, address };
}

// ---- sessions ----------------------------------------------------------------

export async function makeSession(secret, address, flags = "", now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ a: address, f: flags, exp: Math.floor(now / 1000) + SESSION_TTL_S })));
  return `${payload}.${await hmac(secret, payload)}`;
}

/** { address, flags } for a valid, unexpired token; null otherwise */
export async function readSession(secret, token, now = Date.now()) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqual(await hmac(secret, payload), mac)) return null;
  try {
    const data = JSON.parse(utf8(fromB64url(payload)));
    if (!data || typeof data.a !== "string" || !Number.isFinite(data.exp) || data.exp * 1000 < now) return null;
    return { address: data.a, flags: String(data.f || "") };
  } catch {
    return null;
  }
}

export const cookieValue = (cookieHeader, name) => {
  const m = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
};

export const sessionCookie = (token, secure, maxAge = SESSION_TTL_S) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

export const clearedCookie = (secure) => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

/** Flag "d": the address is on the deny list; the session works, lookups do not */
export const DENIED_FLAG = "d";
export const sessionMayLookup = (session) => Boolean(session && !session.flags.includes(DENIED_FLAG));
