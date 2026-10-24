// Atlas set -> Flow set, the set join the atlas-* scripts share (parallels,
// tiers). Atlas numbers its sets its own way, so a set maps through its
// plays (Atlas's play id is the Flow play id, atlas-join.mjs; then the
// Flow set of that name holding the play), or directly when
// data/dapper/sets.json pins the Atlas set number with atlasSetID.
import { readFileSync } from "node:fs";
import path from "node:path";
import { atlasPlayJoin } from "./atlas-join.mjs";
import { ROOT } from "./paths.mjs";

export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Maps every Atlas set in the answer sheet to a Flow set (getSetsOverview
 * rows). Returns { flowSetOf: Map(atlasSetId -> flowSetId), byOverlap,
 * unmapped, ambiguous }; the last three are report lines.
 */
export function mapAtlasSets(atlas, flowSets) {
  const dapperSets = JSON.parse(readFileSync(path.join(ROOT, "data", "dapper", "sets.json"), "utf8"));
  // Flow play id -> the Flow sets (id, name) holding it; names as the app
  // shows them (data/overrides/sets.json renames "Base Set6" to "Base Set")
  const setsOverrides = JSON.parse(readFileSync(path.join(ROOT, "data", "overrides", "sets.json"), "utf8"));
  const displayName = (s) => ((setsOverrides[String(s.id)] || {}).name) || s.setName;
  const setsByPlay = new Map();
  flowSets.forEach((s) => {
    (s.playIDs || []).forEach((p) => {
      const list = setsByPlay.get(Number(p)) || [];
      list.push({ id: Number(s.id), name: norm(displayName(s)) });
      setsByPlay.set(Number(p), list);
    });
  });
  const flowPlayID = atlasPlayJoin();
  const directSet = new Map();
  Object.entries(dapperSets).forEach(([id, e]) => { if (e && Number.isInteger(e.atlasSetID)) directSet.set(String(e.atlasSetID), Number(id)); });

  // Atlas set -> Flow set by majority vote over the set's editions: first
  // among Flow sets of the same name, then (names differ on chain now and
  // then, "Base Set6") among every Flow set holding the plays, accepted when
  // one set holds nearly all of them and is about the same size
  const votes = new Map(); // atlasSetId -> Map(flowSetId -> count)
  const looseVotes = new Map();
  const atlasSetNames = new Map();
  const atlasSetPlays = new Map(); // atlasSetId -> Set(play)
  atlas.editions.forEach((e) => {
    atlasSetNames.set(e.setId, e.setName);
    const flowPlay = flowPlayID(e);
    (atlasSetPlays.get(e.setId) || atlasSetPlays.set(e.setId, new Set()).get(e.setId)).add(flowPlay || e.guid);
    if (!flowPlay || e.parallel !== "Standard") return;
    (setsByPlay.get(flowPlay) || []).forEach((s) => {
      const target = s.name === norm(e.setName) ? votes : looseVotes;
      const m = target.get(e.setId) || new Map();
      m.set(s.id, (m.get(s.id) || 0) + 1);
      target.set(e.setId, m);
    });
  });
  const flowSetOf = new Map();
  const ambiguous = [];
  const byOverlap = [];
  atlasSetNames.forEach((name, atlasSetId) => {
    if (directSet.has(atlasSetId)) { flowSetOf.set(atlasSetId, directSet.get(atlasSetId)); return; }
    const m = votes.get(atlasSetId);
    if (m) {
      const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1 && ranked[1][1] >= ranked[0][1] * 0.5) ambiguous.push(`${name} (Atlas ${atlasSetId}): Flow ${ranked.map(([id, n]) => `${id} x${n}`).join(", ")}`);
      flowSetOf.set(atlasSetId, ranked[0][0]);
      return;
    }
    const loose = looseVotes.get(atlasSetId);
    if (!loose) return;
    const playCount = atlasSetPlays.get(atlasSetId).size;
    const ranked = [...loose.entries()].sort((a, b) => b[1] - a[1]);
    const [flowId, hits] = ranked[0];
    const flowSize = ((flowSets.find((s) => Number(s.id) === flowId) || {}).playIDs || []).length;
    if (hits >= playCount * 0.9 && Math.abs(flowSize - playCount) <= Math.max(2, playCount * 0.1)) {
      flowSetOf.set(atlasSetId, flowId);
      byOverlap.push(`${name} (Atlas ${atlasSetId}) -> Flow ${flowId} "${(flowSets.find((s) => Number(s.id) === flowId) || {}).setName}" (${hits}/${playCount} plays)`);
    }
  });
  const unmapped = [...atlasSetNames.entries()].filter(([id]) => !flowSetOf.has(id));
  return { flowSetOf, byOverlap, unmapped, ambiguous };
}
