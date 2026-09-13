// Derived-media URL helpers (docs/MEDIA-PIPELINE.md): the 512px thumbnails and
// set-art squares served from the R2 bucket behind cache.topshotexplorer.com.
//
// The ONE knob is VITE_MEDIA_BASE (the .env.cloudflare build sets it to the
// bucket domain), in the VITE_FLOW_ACCESS_NODE mould: nothing in src/ knows
// Cloudflare exists. Dev falls back to the vite middleware that serves the
// local gitignored assets/ tree at /assets. Unset and not dev, every helper
// returns null and the UI keeps its no-media look: the portability floor
// (gateway originals + in-browser generation) is untouched.
//
// Display rule: there is exactly ONE derived size, 512,
// whatever the on-screen box (40px chips, 96px cells); the browser scales
// it down. New sizes only when a real surface needs them.
const env = typeof import.meta.env !== "undefined" ? import.meta.env : {};
export const MEDIA_BASE = env.VITE_MEDIA_BASE || (env.DEV ? "/assets" : null);

// One 512px jpg per HERO CID (content-addressed, cached immutable)
export const heroThumbUrl = (cid) =>
  MEDIA_BASE && cid ? `${MEDIA_BASE}/derived/thumbs/v1/512/${cid}.jpg` : null;

// 512px version of an extracted set-art square, by manifest filename
export const setArtThumbUrl = (file) =>
  MEDIA_BASE && file ? `${MEDIA_BASE}/derived/setart/512/${file}` : null;

// manifest.json lists the recipe-tree files (teams/badges for the Assets
// page, setArt: setID -> cover filename). One fetch per session; null when
// media is off or the host serves no manifest.
let manifestPromise = null;
export function fetchMediaManifest() {
  if (!MEDIA_BASE) return Promise.resolve(null);
  if (!manifestPromise) {
    manifestPromise = fetch(`${MEDIA_BASE}/manifest.json`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok && (r.headers.get("content-type") || "").includes("json") ? r.json() : null))
      .catch(() => null);
  }
  return manifestPromise;
}
