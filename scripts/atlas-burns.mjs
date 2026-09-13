// Moments destroyed per edition, from the Atlas answer sheet, into
// data/burns.json.
//
// The chain never decrements an edition's count: a destroyed moment emits
// MomentDestroyed and the set's numberMintedPerPlay stays where it was.
// Atlas (Dapper Labs' catalogue) carries numBurned per (set, play,
// parallel), so this is the one place a remaining supply can come from.
// The app subtracts the burned count from the on-chain mint count wherever
// it would otherwise show what was minted (src/services/supply.service.js;
// Settings can switch back to the original mint counts).
//
// Shape of data/burns.json:
//   { "_note", "asOf": <Atlas fetchedAt>, "editions": { "<setID>_<playID>": burned } }
// where `burned` is a number when every destroyed moment was Standard, or
// { "<subeditionID>": n } per subedition when a parallel carries burns
// (0 is Standard; ids from SUBEDITION_NAMES). The edition's count is the
// sum, never stored twice. Editions with nothing burned are absent.
//
// Join: Atlas play GUID -> data/dapper/plays.json playUUID -> Flow play id;
// the Flow set is Atlas's set id (Atlas reuses the Flow ids).
//
// Usage:
//   npm run atlas:harvest                fresh snapshot (a few minutes)
//   npm run atlas:burns                  write data/burns.json from it
//   npm run atlas:burns -- --dry-run     report only
//   --atlas <file>   answer sheet (default data/atlas/editions.json)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SUBEDITION_NAMES } from "../src/services/fcl.service.js";
import { flag, opt } from "./lib/args.mjs";
import { writeFileAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const OUT_PATH = path.join(ROOT, "data", "burns.json");
const DAPPER_PLAYS_PATH = path.join(ROOT, "data", "dapper", "plays.json");
const dryRun = flag("--dry-run");

const NOTE = "Moments destroyed per edition, from Atlas (Dapper Labs' catalogue): the chain never decrements an edition's count, so this is the only source of a remaining supply. Key setID_playID; value the burned count when every destroyed moment was Standard, else { subeditionID: n } per subedition (0 = Standard), the edition count being their sum. Editions with nothing burned are absent. Refresh with `npm run atlas:harvest` then `npm run atlas:burns`.";

function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const dapperPlays = JSON.parse(readFileSync(DAPPER_PLAYS_PATH, "utf8"));
  const flowIdByGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) flowIdByGuid.set(e.playUUID, id); });
  const subIdByName = new Map(Object.entries(SUBEDITION_NAMES).map(([id, name]) => [String(name).toLowerCase(), Number(id)]));

  const perEdition = new Map(); // key -> Map(subID -> n)
  let unjoined = 0, unknownParallel = 0, atlasEditions = 0, burnedTotal = 0;
  atlas.editions.forEach((e) => {
    atlasEditions++;
    const playID = flowIdByGuid.get(e.guid);
    if (!playID) { unjoined++; return; }
    const burned = Number(e.numBurned) || 0;
    if (burned === 0) return;
    const parallel = String(e.parallel || "Standard").trim();
    const subID = parallel.toLowerCase() === "standard" ? 0 : subIdByName.get(parallel.toLowerCase());
    // A parallel the table does not know has no id to file its burns
    // under: add it to SUBEDITION_NAMES (and sets_parallels) rather than
    // carry a count nobody can attribute
    if (subID === undefined) { unknownParallel++; console.log(`  unknown parallel "${parallel}" on Atlas edition ${e.id}: ${burned} burned NOT counted; add it to SUBEDITION_NAMES`); return; }
    const key = `${Number(e.setId)}_${Number(playID)}`;
    const sub = perEdition.get(key) || new Map();
    sub.set(subID, (sub.get(subID) || 0) + burned);
    perEdition.set(key, sub);
    burnedTotal += burned;
  });

  const editions = {};
  let withParallelBurns = 0;
  [...perEdition.keys()].sort((a, b) => {
    const [sa, pa] = a.split("_").map(Number); const [sb, pb] = b.split("_").map(Number);
    return sa - sb || pa - pb;
  }).forEach((key) => {
    const sub = perEdition.get(key);
    if (sub.size === 1 && sub.has(0)) { editions[key] = sub.get(0); return; }
    withParallelBurns++;
    const subObj = {};
    [...sub.keys()].sort((x, y) => x - y).forEach((id) => { subObj[String(id)] = sub.get(id); });
    editions[key] = subObj;
  });

  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlasEditions} editions, ${unjoined} not joined to a Flow play, ${unknownParallel} unknown parallels`);
  console.log(`${Object.keys(editions).length} editions with burns (${withParallelBurns} with burns on a parallel), ${burnedTotal.toLocaleString()} moments destroyed in all`);
  if (dryRun) { console.log("dry run: nothing written"); return; }
  const out = { _note: NOTE, asOf: atlas.fetchedAt, editions };
  writeFileAtomic(OUT_PATH, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();
