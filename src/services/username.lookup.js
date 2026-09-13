// The navbar box takes a Top Shot username as well as an address. A
// username goes to GET /lookup/user/<name>, part of the optional edge
// layer (deploy/cloudflare/lookup.js; the dev server answers it too). A
// host without that layer serves the SPA page for the path instead, which
// the JSON check below turns into an "unavailable" error rather than a
// false miss.

/** A Flow address as people type it: 16 hex digits, 0x optional */
export const isAddressLike = (input) => /^(0x)?[0-9a-f]{16}$/i.test(String(input || "").trim());

export class LookupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "missing" | "invalid" | "unavailable" | "error"
  }
}

/** Resolve a username to { username, address, fetchedAt }; throws LookupError */
export async function lookupUsername(rawName) {
  const name = String(rawName || "").trim().replace(/^@/, "");
  if (!name) throw new LookupError("invalid", "Enter a username or an address");
  let res;
  try {
    res = await fetch(`/lookup/user/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
  } catch {
    throw new LookupError("unavailable", "Username lookup is not reachable right now");
  }
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  if (!isJson) throw new LookupError("unavailable", "Username lookup is not available on this host; enter the 0x address");
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body.address) return body;
  if (res.status === 404) throw new LookupError("missing", `No Top Shot user named @${name}`);
  if (res.status === 400) throw new LookupError("invalid", `@${name} is not a Top Shot username`);
  throw new LookupError("error", body.error || `Lookup failed (${res.status})`);
}
