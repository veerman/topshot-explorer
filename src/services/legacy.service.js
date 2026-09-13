// Resolves old nbatopshot.com URLs (and Atlas edition numbers) to pages here.
//
// The old site addressed everything by Dapper UUIDs; Atlas replaced most of
// them with numbers. data/dapper/*.json keeps both beside our Flow ids, and
// this module is the only reader of those files in the app: they load on
// demand (dynamic import, their own chunks) the first time a lookup runs,
// so no other page pays for them.
//
// What resolves: a set UUID (any /user/.../sets/<uuid>/... path), a set +
// play UUID pair (/edition/<set>/<play>, /listings/p2p/<set>+<play>, with an
// optional ?parallel=<subedition id>), an edition UUID, a play UUID on its
// own, and the current site's /edition/<n>. Moment and pack UUIDs were
// assigned in Dapper's database and never published beside a Flow id, so
// those links are recognised and explained, never resolved.
import setsParallels from "../../data/sets_parallels.json";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let mapsPromise = null;
/** The reverse maps (Dapper id -> Flow id), built once per session. */
export function loadDapperIds() {
  if (!mapsPromise) {
    mapsPromise = Promise.all([
      import("../../data/dapper/plays.json"),
      import("../../data/dapper/sets.json"),
      import("../../data/dapper/editions.json")
    ]).then(([p, s, e]) => {
      const playByUUID = new Map(), setByUUID = new Map(), editionByUUID = new Map(), editionByAtlasID = new Map();
      Object.entries(p.default).forEach(([id, v]) => { if (v && v.playUUID) playByUUID.set(v.playUUID.toLowerCase(), Number(id)); });
      Object.entries(s.default).forEach(([id, v]) => { if (v && v.legacySetUUID) setByUUID.set(v.legacySetUUID.toLowerCase(), Number(id)); });
      Object.entries(e.default).forEach(([key, v]) => {
        if (!v || key.startsWith("_")) return;
        if (v.legacyEditionUUID) editionByUUID.set(v.legacyEditionUUID.toLowerCase(), key);
        if (Number.isInteger(v.atlasEditionID)) editionByAtlasID.set(v.atlasEditionID, key);
      });
      return { playByUUID, setByUUID, editionByUUID, editionByAtlasID, counts: { plays: playByUUID.size, sets: setByUUID.size, editions: editionByUUID.size, atlas: editionByAtlasID.size } };
    }).catch((err) => { mapsPromise = null; throw err; });
  }
  return mapsPromise;
}

/** Path and query out of whatever was pasted: a full URL, a bare host+path,
 *  or a path. Returns null when nothing path-like is there. */
export function parseLegacyInput(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  let url;
  try {
    if (/^https?:\/\//i.test(s)) url = new URL(s);
    else if (s.startsWith("/")) url = new URL(s, "https://nbatopshot.com");
    else url = new URL(`https://${s}`);
  } catch { return null; }
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  return { path, params: url.searchParams, host: url.host };
}

// The families the old site (and the current one) used, by path shape.
// Order matters: the first match names the link
const FAMILIES = [
  { kind: "moment", re: /^\/moment\//i, label: "Moment" },
  { kind: "pack", re: /^\/(?:user\/[^/]+\/packs|marketplace\/packs|packs)\b/i, label: "Pack" },
  { kind: "listing", re: /^\/listings\/p2p\//i, label: "Marketplace listing" },
  { kind: "atlasEdition", re: /^\/edition\/\d+$/i, label: "Edition (current site)" },
  { kind: "edition", re: /^\/edition\//i, label: "Edition" },
  { kind: "set", re: /^\/user\/[^/]+\/sets\//i, label: "Set" },
  { kind: "set", re: /^\/sets\//i, label: "Set" }
];

const NEVER_PUBLISHED = {
  moment: "Moment links carry the moment's UUID from Dapper's database. It was never published beside the moment's Flow id, so there is nothing to map it through.",
  pack: "Pack links carry the pack's UUID from Dapper's database. Packs are not on the Flow Blockchain as collectibles, so there is nothing here to map them to."
};

/**
 * Resolve a parsed input against the maps. Returns
 *   { family, label, found: [{ id, kind, flowID }], target, targetLabel, note }
 * where target is a path in this app or null.
 */
export function resolveLegacy(parsed, maps) {
  if (!parsed) return null;
  const { path, params } = parsed;
  const family = FAMILIES.find((f) => f.re.test(path)) || { kind: "unknown", label: "Link" };
  const out = { family: family.kind, label: family.label, found: [], target: null, targetLabel: "", note: "" };

  if (family.kind === "atlasEdition") {
    const n = Number(path.split("/").pop());
    const key = maps.editionByAtlasID.get(n);
    out.found.push({ id: String(n), kind: key ? "atlas edition" : "unknown", flowID: key || null });
    if (key) { out.target = `/editions/${key}`; out.targetLabel = `Edition ${key}`; }
    else out.note = `Edition ${n} is not in the Atlas catalogue we hold (numbers run to ${Math.max(...maps.editionByAtlasID.keys())}).`;
    return out;
  }

  const uuids = [...new Set((path.match(UUID_RE) || []).map((u) => u.toLowerCase()))];
  let setID = null, playID = null, editionKey = null;
  uuids.forEach((u) => {
    if (maps.setByUUID.has(u)) { const id = maps.setByUUID.get(u); out.found.push({ id: u, kind: "set", flowID: id }); if (setID === null) setID = id; }
    else if (maps.playByUUID.has(u)) { const id = maps.playByUUID.get(u); out.found.push({ id: u, kind: "play", flowID: id }); if (playID === null) playID = id; }
    else if (maps.editionByUUID.has(u)) { const key = maps.editionByUUID.get(u); out.found.push({ id: u, kind: "edition", flowID: key }); if (!editionKey) editionKey = key; }
    else out.found.push({ id: u, kind: "unknown", flowID: null });
  });

  if (NEVER_PUBLISHED[family.kind] && !setID && !playID && !editionKey) {
    out.note = NEVER_PUBLISHED[family.kind];
    return out;
  }
  if (uuids.length === 0) {
    out.note = "No Dapper id in that link. The old site's links carried UUIDs; this page needs at least one.";
    return out;
  }

  if (!editionKey && setID !== null && playID !== null) editionKey = `${setID}_${playID}`;
  if (editionKey) {
    const [sid] = editionKey.split("_").map(Number);
    const parallel = Number(params.get("parallel"));
    const carried = setsParallels[String(sid)] || [];
    if (parallel > 0 && carried.includes(parallel)) {
      out.target = `/editions/${editionKey}_${parallel}`;
      out.targetLabel = `Edition ${editionKey}, parallel ${parallel}`;
    } else {
      out.target = `/editions/${editionKey}`;
      out.targetLabel = `Edition ${editionKey}`;
      if (parallel > 0) out.note = `Parallel ${parallel} is not one this set carries; showing the edition instead.`;
    }
    return out;
  }
  if (setID !== null) { out.target = `/sets/${setID}`; out.targetLabel = `Set ${setID}`; return out; }
  if (playID !== null) { out.target = `/plays/${playID}`; out.targetLabel = `Play ${playID}`; return out; }
  out.note = NEVER_PUBLISHED[family.kind] || "None of the ids in that link is a set, play or edition id we hold. Moment and pack ids were never published beside Flow ids.";
  return out;
}
