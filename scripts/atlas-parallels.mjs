// Derives data/sets_parallels.json (which subedition parallels each set
// carries) from the Atlas answer sheet.
//
// The chain alone cannot answer this: numberMintedPerSubedition lives on the
// SubeditionAdmin resource in Dapper's account storage, which scripts cannot
// borrow, and the only public lookups go from an NFT id to its subedition.
// Atlas lists every (set, play, parallel) as its own edition with a
// `parallel` name, and TopShot.getAllSubeditions() gives the on-chain id for
// each parallel name, so the two together give the mapping.
//
// A set maps to its Flow set through its plays (Atlas play GUID ->
// data/dapper/plays.json playUUID -> Flow play id -> the Flow set of that
// name containing the play), or directly when data/dapper/sets.json pins
// the Atlas set number with atlasSetID.
//
// Usage:
//   npm run atlas:parallels             report the differences
//   npm run atlas:parallels -- --apply  write data/sets_parallels.json
//   --prune     also drop parallels Atlas no longer lists (default: keep)
//   --atlas <file>   answer sheet (default data/atlas/editions.json)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initFCL, getSetsOverview, getSubeditions, SUBEDITION_MINT_COUNTS } from "../src/services/fcl.service.js";
import { flag, opt } from "./lib/args.mjs";
import { writeFileAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const PARALLELS_PATH = path.join(ROOT, "data", "sets_parallels.json");
const apply = flag("--apply");
const prune = flag("--prune");

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const dapperSets = JSON.parse(readFileSync(path.join(ROOT, "data", "dapper", "sets.json"), "utf8"));
  const dapperPlays = JSON.parse(readFileSync(path.join(ROOT, "data", "dapper", "plays.json"), "utf8"));
  const current = JSON.parse(readFileSync(PARALLELS_PATH, "utf8"));
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions`);

  initFCL();
  const [flowSets, subeditions] = await Promise.all([getSetsOverview(), getSubeditions()]);
  const subIdByName = new Map(Object.values(subeditions).map((s) => [norm(s.name), Number(s.id)]));
  console.log(`Flow: ${flowSets.length} sets, ${subIdByName.size} subeditions`);

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
  const flowPlayByGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) flowPlayByGuid.set(e.playUUID, Number(id)); });
  const directSet = new Map();
  Object.entries(dapperSets).forEach(([id, e]) => { if (e && Number.isInteger(e.atlasSetID)) directSet.set(String(e.atlasSetID), Number(id)); });

  // Atlas set -> Flow set by majority vote over the set's editions: first
  // among Flow sets of the same name, then (names differ on chain now and
  // then, "Base Set6") among every Flow set holding the plays, accepted when
  // one set holds nearly all of them and is about the same size
  const votes = new Map(); // atlasSetId -> Map(flowSetId -> count)
  const looseVotes = new Map();
  const atlasSetNames = new Map();
  const atlasSetPlays = new Map(); // atlasSetId -> Set(guid)
  atlas.editions.forEach((e) => {
    atlasSetNames.set(e.setId, e.setName);
    (atlasSetPlays.get(e.setId) || atlasSetPlays.set(e.setId, new Set()).get(e.setId)).add(e.guid);
    const flowPlay = flowPlayByGuid.get(e.guid);
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

  // Parallels per Flow set, plus Atlas's mint size per parallel name
  const proposed = new Map(); // flowSetId -> Set(subId)
  const unknownParallels = new Map();
  const sizes = new Map(); // parallel name -> Map(size -> count)
  atlas.editions.forEach((e) => {
    if (e.parallel === "Standard") return;
    const sub = subIdByName.get(norm(e.parallel));
    if (sub === undefined) { unknownParallels.set(e.parallel, (unknownParallels.get(e.parallel) || 0) + 1); return; }
    const sm = sizes.get(e.parallel) || new Map();
    sm.set(e.maxMintSize, (sm.get(e.maxMintSize) || 0) + 1);
    sizes.set(e.parallel, sm);
    const flowSet = flowSetOf.get(e.setId);
    if (flowSet === undefined) return;
    const set = proposed.get(flowSet) || new Set();
    set.add(sub);
    proposed.set(flowSet, set);
  });

  // Merge with the current file: keep its order, append new ids, prune only on request
  const next = {};
  const allSetIds = new Set([...Object.keys(current).map(Number), ...proposed.keys()]);
  const changes = [];
  [...allSetIds].sort((a, b) => a - b).forEach((setId) => {
    const have = current[String(setId)] || [];
    const want = proposed.get(setId) || new Set();
    const added = [...want].filter((s) => !have.includes(s)).sort((a, b) => a - b);
    const missing = have.filter((s) => !want.has(s));
    let list = prune ? have.filter((s) => want.has(s)) : [...have];
    list = list.concat(added);
    if (list.length > 0) next[String(setId)] = list;
    const setName = (flowSets.find((s) => Number(s.id) === setId) || {}).setName || "?";
    const nameOf = (s) => (subeditions[s] || {}).name || `#${s}`;
    if (added.length) changes.push(`+ set ${setId} ${setName}: ${added.map(nameOf).join(", ")}${have.length === 0 ? " (new set)" : ""}`);
    if (missing.length) changes.push(`${prune ? "-" : "?"} set ${setId} ${setName}: ${missing.map(nameOf).join(", ")} ${prune ? "dropped" : "not in Atlas (kept; --prune drops)"}`);
  });

  console.log(`\nAtlas sets mapped to Flow sets: ${flowSetOf.size} of ${atlasSetNames.size}`);
  if (byOverlap.length) console.log(`  matched by play overlap (names differ):\n    ${byOverlap.join("\n    ")}`);
  if (unmapped.length) console.log(`  unmapped (no play GUID joins): ${unmapped.map(([id, n]) => `${n} (${id})`).join("; ")}`);
  if (ambiguous.length) console.log(`  ambiguous votes:\n    ${ambiguous.join("\n    ")}`);
  if (unknownParallels.size) console.log(`  parallel names with no on-chain subedition: ${JSON.stringify([...unknownParallels])}`);

  console.log("\nAtlas mint size per parallel (vs the hardcoded SUBEDITION_MINT_COUNTS in fcl.service):");
  [...sizes.entries()].sort((a, b) => subIdByName.get(norm(a[0])) - subIdByName.get(norm(b[0]))).forEach(([name, sm]) => {
    const sub = subIdByName.get(norm(name));
    const dist = [...sm.entries()].sort((a, b) => b[1] - a[1]).map(([size, n]) => `${size} x${n}`).join(", ");
    const coded = SUBEDITION_MINT_COUNTS[sub];
    const top = [...sm.entries()].sort((a, b) => b[1] - a[1])[0][0];
    console.log(`  ${String(sub).padStart(2)} ${name.padEnd(16)} ${dist}${coded === undefined || coded !== top ? `   <- fcl.service says ${coded === undefined ? "nothing" : coded}` : ""}`);
  });

  console.log(`\nsets_parallels.json: ${Object.keys(current).length} sets now, ${Object.keys(next).length} after`);
  if (changes.length === 0) {
    console.log("No differences. The file already matches Atlas.");
    return;
  }
  changes.forEach((c) => console.log("  " + c));
  if (!apply) {
    console.log("\nDry run; re-run with --apply to write.");
    return;
  }
  // The file's own style: tab-indented, one set per line, LF, trailing newline
  const body = `{\n${Object.entries(next).map(([id, list]) => `\t"${id}": [${list.join(",")}]`).join(",\n")}\n}\n`;
  writeFileAtomic(PARALLELS_PATH, body);
  console.log(`Wrote ${path.relative(ROOT, PARALLELS_PATH)}.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
