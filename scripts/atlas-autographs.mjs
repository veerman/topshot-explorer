// Which parallels of an edition carry the printed autograph, from the
// Atlas answer sheet, into data/autographs.json.
//
// The chain flags an autograph on the PLAY (PlayerAutographType), one
// value shared by every edition and parallel of that play. The signature
// is a fact of one edition: in a set with parallels usually only the
// rarest parallel is signed, and 65 signed plays carry no chain flag at
// all. Atlas marks each
// (set, play, parallel) row with `autographedAt`, so this is the one
// place the per-parallel truth can come from until the chain carries it.
// The app derives the Autograph badge from this file
// (src/services/autograph.service.js) and shows the chain flag beside it
// on the Corrections page wherever the two disagree.
//
// Shape of data/autographs.json:
//   { "_note", "asOf": <Atlas fetchedAt>, "editions": { "<setID>_<playID>": [subeditionIDs] } }
// where the list names the signed parallels (0 = Standard; ids from
// SUBEDITION_NAMES), sorted. Editions with nothing signed are absent.
//
// Join: Atlas play GUID -> data/dapper/plays.json playUUID -> Flow play id;
// the Flow set is Atlas's set id (Atlas reuses the Flow ids).
//
// Usage:
//   npm run atlas:harvest                  fresh snapshot (a few minutes)
//   npm run atlas:autographs               write data/autographs.json from it
//   npm run atlas:autographs -- --dry-run  report only
//   --atlas <file>   answer sheet (default data/atlas/editions.json)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SUBEDITION_NAMES } from "../src/services/fcl.service.js";
import { flag, opt } from "./lib/args.mjs";
import { writeFileAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const OUT_PATH = path.join(ROOT, "data", "autographs.json");
const DAPPER_PLAYS_PATH = path.join(ROOT, "data", "dapper", "plays.json");
const dryRun = flag("--dry-run");

const NOTE = "Which parallels of an edition carry the printed autograph, from Atlas (Dapper Labs' catalogue). The chain flags an autograph on the play, one value for every parallel, so it cannot say which parallel is signed; Atlas marks each (set, play, parallel). Key setID_playID; value the signed subedition ids (0 = Standard). Editions with nothing signed are absent. Refresh with `npm run atlas:harvest` then `npm run atlas:autographs`.";

function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const dapperPlays = JSON.parse(readFileSync(DAPPER_PLAYS_PATH, "utf8"));
  const flowIdByGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) flowIdByGuid.set(e.playUUID, id); });
  const subIdByName = new Map(Object.entries(SUBEDITION_NAMES).map(([id, name]) => [String(name).toLowerCase(), Number(id)]));

  const signed = new Map(); // key -> Set(subID)
  const flaggedPlays = new Set(); // plays the chain (and Atlas's copy of it) flags
  const signedPlays = new Set();
  let unjoined = 0, unknownParallel = 0, signedRows = 0, signedMoments = 0;
  atlas.editions.forEach((e) => {
    const playID = flowIdByGuid.get(e.guid);
    if (!playID) { unjoined++; return; }
    if ((e.play || {}).PlayerAutographType === "Printed Autograph") flaggedPlays.add(playID);
    if (!e.autographedAt) return;
    const parallel = String(e.parallel || "Standard").trim();
    const subID = parallel.toLowerCase() === "standard" ? 0 : subIdByName.get(parallel.toLowerCase());
    if (subID === undefined) { unknownParallel++; console.log(`  unknown parallel "${parallel}" on Atlas edition ${e.id}: signed row NOT recorded; add it to SUBEDITION_NAMES`); return; }
    const key = `${Number(e.setId)}_${Number(playID)}`;
    if (!signed.has(key)) signed.set(key, new Set());
    signed.get(key).add(subID);
    signedPlays.add(playID);
    signedRows++;
    signedMoments += Number(e.numMinted) || 0;
  });

  const editions = {};
  [...signed.keys()].sort((a, b) => {
    const [sa, pa] = a.split("_").map(Number); const [sb, pb] = b.split("_").map(Number);
    return sa - sb || pa - pb;
  }).forEach((key) => { editions[key] = [...signed.get(key)].sort((x, y) => x - y); });

  const flaggedNotSigned = [...flaggedPlays].filter((p) => !signedPlays.has(p)).map(Number).sort((a, b) => a - b);
  const signedNotFlagged = [...signedPlays].filter((p) => !flaggedPlays.has(p)).map(Number).sort((a, b) => a - b);
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions, ${unjoined} not joined to a Flow play, ${unknownParallel} unknown parallels`);
  console.log(`${Object.keys(editions).length} editions with a signed parallel (${signedRows} signed rows, ${signedMoments.toLocaleString()} signed moments), ${signedPlays.size} plays`);
  console.log(`Atlas's copy of the play flag vs signed: ${flaggedNotSigned.length} plays flagged with nothing signed [${flaggedNotSigned.join(", ")}]; ${signedNotFlagged.length} plays signed with no flag (the app checks the chain's flag on the Corrections page)`);
  if (dryRun) { console.log("dry run: nothing written"); return; }
  const out = { _note: NOTE, asOf: atlas.fetchedAt, editions };
  writeFileAtomic(OUT_PATH, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();
