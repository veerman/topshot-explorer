// Username -> Flow address, read from the public profile page on
// nbatopshot.com. Shared by the Worker (GET /lookup/user/<name>, cached at
// the edge) and the Vite dev server (same route, uncached), so both hosts
// answer the navbar box identically.
//
// Why the page and not Atlas: Dapper's API allows only nbatopshot.com as a
// browser origin and challenges every non-browser client (a Worker
// included), while the server-rendered profile page is public, allowed by
// robots.txt, and carries the address in its og:image tag
// (https://nbatopshot.com/og/user/0x...). An unknown username gets the
// site's generic og image instead, which is the miss signal. Nothing but
// the username and the address is kept: no login ids, no images.

export const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const PAGE_UA = "TopShotExplorer/2 (+https://v2.topshotexplorer.com; username lookup)";

export const profilePageUrl = (name) => `https://nbatopshot.com/collection/${encodeURIComponent(name)}`;

/** { username, address } from the profile page HTML, or null when the page
 *  is not a user's (generic og image, no address). */
export function parseProfilePage(html) {
  const image = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || "";
  const address = (image.match(/\/og\/user\/(0x[0-9a-f]{16})/i) || [])[1];
  if (!address) return null;
  const title = (html.match(/property="og:title"\s+content="@([^"|]+?)\s*\|/) || [])[1];
  return { address: address.toLowerCase(), username: title || null };
}

/**
 * Resolve one username. Returns { status, body }: 200 with
 * { username, address, fetchedAt }, 404 with { error }, 400 for a name the
 * site could not have, 502 when the page did not answer.
 */
export async function lookupUser(rawName, fetchImpl = fetch) {
  const name = String(rawName || "").trim().replace(/^@/, "");
  if (!USERNAME_RE.test(name)) return { status: 400, body: { error: "not a Top Shot username" } };
  const first = await fetchProfile(name, fetchImpl);
  if (first.status !== 404) return first;
  // The page is case sensitive. A name typed with capitals that misses
  // gets one more try in lowercase; a lowercase miss is
  // final, since there is no casing left to guess.
  const lower = name.toLowerCase();
  if (lower !== name) {
    const second = await fetchProfile(lower, fetchImpl);
    if (second.status !== 404) return second;
  }
  return first;
}

async function fetchProfile(name, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(profilePageUrl(name), { headers: { "user-agent": PAGE_UA, accept: "text/html" }, redirect: "follow" });
  } catch (err) {
    return { status: 502, body: { error: `profile page unreachable: ${err.message || err}` } };
  }
  if (res.status !== 200) return { status: 502, body: { error: `profile page answered ${res.status}` } };
  const parsed = parseProfilePage(await res.text());
  if (!parsed) return { status: 404, body: { error: `no Top Shot user named ${name}` } };
  return { status: 200, body: { username: parsed.username || name, address: parsed.address, fetchedAt: new Date().toISOString() } };
}
