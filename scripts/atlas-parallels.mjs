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
// A set maps to its Flow set through its plays, or directly when
// data/dapper/sets.json pins the Atlas set number (scripts/lib/atlas-sets.mjs).
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
import { mapAtlasSets, norm } from "./lib/atlas-sets.mjs";
import { writeFileAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const PARALLELS_PATH = path.join(ROOT, "data", "sets_parallels.json");
const apply = flag("--apply");
const prune = flag("--prune");

async function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const current = JSON.parse(readFileSync(PARALLELS_PATH, "utf8"));
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions`);

  initFCL();
  const [flowSets, subeditions] = await Promise.all([getSetsOverview(), getSubeditions()]);
  const subIdByName = new Map(Object.values(subeditions).map((s) => [norm(s.name), Number(s.id)]));
  console.log(`Flow: ${flowSets.length} sets, ${subIdByName.size} subeditions`);

  const { flowSetOf, byOverlap, unmapped, ambiguous } = mapAtlasSets(atlas, flowSets);
  const atlasSetNames = new Set(atlas.editions.map((e) => e.setId));

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
