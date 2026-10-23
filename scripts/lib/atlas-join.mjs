// Atlas edition -> Flow play id, the one join every atlas-* script uses.
// Atlas's edition template is the Flow play, so a harvest carries the id
// itself (playId, from editionTemplateId; 200 of 200 checked against the
// GUID join on 2026-10-23). Snapshots harvested before that only have the
// play GUID read from the asset path, joined through data/dapper/plays.json
// playUUID; mints from autumn 2026 name their assets by NBA game id and
// event instead, so they carry no GUID and only playId can join them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";

/** Returns (atlasEdition) => Flow play id (a number), or null when nothing joins */
export function atlasPlayJoin() {
  const dapperPlays = JSON.parse(readFileSync(path.join(ROOT, "data", "dapper", "plays.json"), "utf8"));
  const byGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) byGuid.set(e.playUUID, Number(id)); });
  return (e) => Number(e.playId) || byGuid.get(e.guid) || null;
}
