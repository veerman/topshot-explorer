// Copies Atlas's numeric edition id onto our editions, the way
// legacyEditionUUID carries the old site's UUID: data/dapper/editions.json
// gains `atlasEditionID` per "setID_playID" (an entry is created for an
// edition that has none yet). The edition's REWARD badges (Challenge
// Reward, Crafting Challenge Reward, Leaderboard Reward: facts about the
// edition, not the play) are copied into data/additions/editions.json
// `tags` the same way; Atlas owns that vocabulary, so stored reward tags
// are replaced by Atlas's and any other stored tag is kept.
//
// Atlas lists every (set, play, parallel) as its own edition. The Standard
// edition's id is what gets stored; parallels have their own Atlas ids and
// are only counted here until a surface needs them.
//
// Join: Atlas play GUID -> data/dapper/plays.json playUUID -> Flow play id; the Flow
// set is the one holding that play with Atlas's set id (Atlas reuses the
// Flow ids), else the single same-named set holding it.
//
// Usage:
//   npm run atlas:editions              report what would change
//   npm run atlas:editions -- --apply   write data/dapper/editions.json and
//                                       data/additions/editions.json
//   --atlas <file>   answer sheet (default data/atlas/editions.json)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initFCL, getSetsOverview } from "../src/services/fcl.service.js";
import { REWARD_TAGS } from "../src/services/overrides.service.js";
import { flag, opt } from "./lib/args.mjs";
import { readJsonPreservingEol, writeJsonAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const EDITIONS_PATH = path.join(ROOT, "data", "additions", "editions.json");
const DAPPER_EDITIONS_PATH = path.join(ROOT, "data", "dapper", "editions.json");
const DAPPER_PLAYS_PATH = path.join(ROOT, "data", "dapper", "plays.json");
const apply = flag("--apply");
const SHOW = 12;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const dapperPlays = JSON.parse(readFileSync(DAPPER_PLAYS_PATH, "utf8"));
  const setsOverrides = JSON.parse(readFileSync(path.join(ROOT, "data", "overrides", "sets.json"), "utf8"));
  const { data: editions, eol, trailing } = readJsonPreservingEol(EDITIONS_PATH);
  const { data: dapper, eol: dEol, trailing: dTrailing } = readJsonPreservingEol(DAPPER_EDITIONS_PATH);
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions`);

  initFCL();
  const flowSets = await getSetsOverview();
  const displayName = (s) => ((setsOverrides[String(s.id)] || {}).name) || s.setName;
  const setsByPlay = new Map(); // Flow play id -> [{ id, name }]
  flowSets.forEach((s) => {
    (s.playIDs || []).forEach((p) => {
      const list = setsByPlay.get(Number(p)) || [];
      list.push({ id: Number(s.id), name: norm(displayName(s)), chainName: norm(s.setName) });
      setsByPlay.set(Number(p), list);
    });
  });
  const flowPlayByGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) flowPlayByGuid.set(e.playUUID, Number(id)); });
  console.log(`Flow: ${flowSets.length} sets; ${flowPlayByGuid.size} plays carry a playUUID link`);

  const next = new Map(); // "setID_playID" -> atlas id
  const rewards = new Map(); // "setID_playID" -> reward tags on the Standard edition
  const unjoined = [];
  const collisions = [];
  let parallels = 0;
  atlas.editions.forEach((e) => {
    if (e.parallel !== "Standard") { parallels++; return; }
    const play = flowPlayByGuid.get(e.guid);
    if (!play) { unjoined.push(`Atlas ${e.id} (${e.setName} / ${e.play?.FullName || "?"}): play GUID ${e.guid} has no playUUID link`); return; }
    const holders = setsByPlay.get(play) || [];
    let set = holders.find((s) => s.id === Number(e.setId));
    if (!set) {
      const byName = holders.filter((s) => s.name === norm(e.setName) || s.chainName === norm(e.setName));
      if (byName.length === 1) set = byName[0];
    }
    if (!set) { unjoined.push(`Atlas ${e.id} (set ${e.setId} ${e.setName} / play ${play}): no Flow set holds the play`); return; }
    const key = `${set.id}_${play}`;
    if (next.has(key) && next.get(key) !== Number(e.id)) { collisions.push(`${key}: Atlas ${next.get(key)} and ${Number(e.id)}`); return; }
    next.set(key, Number(e.id));
    rewards.set(key, REWARD_TAGS.filter((t) => (e.badges || []).includes(t)));
  });
  // Reward tags: what each joined edition's stored tags become
  const nextTags = new Map(); // key -> tags array (empty = delete)
  const tagStats = { add: 0, change: 0, remove: 0, same: 0, perTag: {} };
  REWARD_TAGS.forEach((t) => { tagStats.perTag[t] = 0; });
  next.forEach((id, key) => {
    const stored = (editions[key] && Array.isArray(editions[key].tags)) ? editions[key].tags : [];
    const keep = stored.filter((t) => !REWARD_TAGS.includes(t));
    const want = [...keep, ...(rewards.get(key) || [])];
    (rewards.get(key) || []).forEach((t) => { tagStats.perTag[t]++; });
    nextTags.set(key, want);
    if (JSON.stringify(stored) === JSON.stringify(want)) tagStats.same++;
    else if (stored.length === 0) tagStats.add++;
    else if (want.length === 0) tagStats.remove++;
    else tagStats.change++;
  });

  let added = 0, changed = 0, unchanged = 0;
  const changes = [];
  next.forEach((id, key) => {
    const cur = dapper[key]?.atlasEditionID;
    if (cur === id) unchanged++;
    else if (cur) { changed++; changes.push(`${key}: ${cur} -> ${id}`); }
    else added++;
  });
  const withoutAtlas = Object.keys(dapper).filter((k) => !k.startsWith("_") && !next.has(k));

  console.log(`\nStandard editions joined: ${next.size} (${parallels} parallel rows counted, not stored)`);
  console.log(`  atlasEditionID: ${added} to add, ${changed} to change, ${unchanged} already right`);
  console.log(`  our editions with no Atlas row: ${withoutAtlas.length}${withoutAtlas.length ? ` (${withoutAtlas.slice(0, SHOW).join(", ")}${withoutAtlas.length > SHOW ? ", ..." : ""})` : ""}`);
  console.log(`  reward tags: ${tagStats.add} to add, ${tagStats.change} to change, ${tagStats.remove} to remove, ${tagStats.same} already right (${REWARD_TAGS.map((t) => `${t} ${tagStats.perTag[t]}`).join(", ")})`);
  if (changes.length) console.log(`  changes:\n    ${changes.slice(0, SHOW).join("\n    ")}${changes.length > SHOW ? `\n    ... ${changes.length - SHOW} more` : ""}`);
  if (collisions.length) console.log(`  COLLISIONS (two Atlas Standard rows on one edition, skipped):\n    ${collisions.slice(0, SHOW).join("\n    ")}`);
  if (unjoined.length) console.log(`  unjoined (${unjoined.length}):\n    ${unjoined.slice(0, SHOW).join("\n    ")}${unjoined.length > SHOW ? `\n    ... ${unjoined.length - SHOW} more` : ""}`);

  if (!apply) { console.log("\nDry run; pass --apply to write data/dapper/editions.json and data/additions/editions.json"); return; }

  next.forEach((id, key) => {
    dapper[key] = { ...(dapper[key] || {}), atlasEditionID: id };
    const tags = nextTags.get(key) || [];
    const entry = { ...(editions[key] || {}) };
    if (tags.length > 0) entry.tags = tags; else delete entry.tags;
    // additions holds corrections only: an edition with nothing left to say drops out
    if (Object.keys(entry).length > 0) editions[key] = entry; else delete editions[key];
  });
  // Deterministic order: meta keys first, then by set id, then play id
  const keyOrder = (k) => k.split("_").map(Number);
  const sortedOf = (obj) => {
    const sorted = {};
    Object.keys(obj).filter((k) => k.startsWith("_")).forEach((k) => { sorted[k] = obj[k]; });
    Object.keys(obj)
      .filter((k) => !k.startsWith("_"))
      .sort((a, b) => { const [as, ap] = keyOrder(a), [bs, bp] = keyOrder(b); return as - bs || ap - bp; })
      .forEach((k) => { sorted[k] = obj[k]; });
    return sorted;
  };
  const sortedDapper = sortedOf(dapper), sortedEditions = sortedOf(editions);
  writeJsonAtomic(DAPPER_EDITIONS_PATH, sortedDapper, { space: 2, eol: dEol, trailing: dTrailing });
  writeJsonAtomic(EDITIONS_PATH, sortedEditions, { space: 2, eol, trailing });
  console.log(`\nWrote ${DAPPER_EDITIONS_PATH}: ${Object.keys(sortedDapper).length} editions`);
  console.log(`Wrote ${EDITIONS_PATH}: ${Object.keys(sortedEditions).length} editions with corrections`);
}

main().catch((err) => { console.error(err); process.exit(1); });
