// Checks what a new set needs before the app can show it whole: a tier,
// and a name for its series. Neither is on chain. Tiers live in
// data/additions/sets.json, one per set (or per edition in
// data/additions/editions.json for a set whose editions differ), and a
// set without one shows its moments under Unknown. The contract numbers
// series but names none; data/overrides/series.json names them, and a
// series without a name shows as "Series 9".
//
// Tiers are compared with the Atlas answer sheet (Atlas is the check,
// never the source: what --apply writes becomes our own fact). A series
// name is suggested from the chain: since Series 2023-24 each series is
// named after the season most of its plays come from, so the suggestion
// is made only when the last named series still follows that rule.
//
// Usage:
//   npm run atlas:sets              report
//   npm run atlas:sets -- --apply   also write what is missing: Atlas's
//                                   tier for an untiered set whose editions
//                                   share one, and the suggested name for
//                                   an unnamed series. A disagreement with
//                                   a tier we hold is only reported.
//   --atlas <file>   answer sheet (default data/atlas/editions.json)
import { readFileSync } from "node:fs";
import path from "node:path";
import { initFCL, getSetsOverview } from "../src/services/fcl.service.js";
import { flag, opt } from "./lib/args.mjs";
import { mapAtlasSets } from "./lib/atlas-sets.mjs";
import { atlasPlayJoin } from "./lib/atlas-join.mjs";
import { readJsonPreservingEol, writeJsonAtomic } from "./lib/json-file.mjs";
import { loadRawPlays, loadSeedPlaysRaw } from "./lib/raw-plays.mjs";
import { ROOT } from "./lib/paths.mjs";

const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const SETS_PATH = path.join(ROOT, "data", "additions", "sets.json");
const EDITIONS_PATH = path.join(ROOT, "data", "additions", "editions.json");
const SERIES_PATH = path.join(ROOT, "data", "overrides", "series.json");
const SERIES_ADDITIONS_PATH = path.join(ROOT, "data", "additions", "series.json");
const apply = flag("--apply");

const TIERS = { COMMON: "Common", FANDOM: "Fandom", RARE: "Rare", LEGENDARY: "Legendary", ULTIMATE: "Ultimate" };
// The indent a file already uses, so a write changes only what it adds
const indentOf = (file) => ((readFileSync(file, "utf8").match(/\n( +)"/) || [])[1] || "  ").length;

const majority = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];

async function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions`);
  initFCL();
  const flowSets = await getSetsOverview();
  const flowSetByID = new Map(flowSets.map((s) => [Number(s.id), s]));
  const { flowSetOf, unmapped } = mapAtlasSets(atlas, flowSets);
  const flowPlayID = atlasPlayJoin();

  // ---- tiers ----------------------------------------------------------------
  const setsFile = readJsonPreservingEol(SETS_PATH);
  const sets = setsFile.data;
  const editions = JSON.parse(readFileSync(EDITIONS_PATH, "utf8"));

  // Atlas's tiers per Flow set, per play (every parallel of a play counts)
  const atlasTiers = new Map(); // flowSetID -> Map(playID -> Set(tier))
  const oddTiers = new Map();
  atlas.editions.forEach((e) => {
    const flowSet = flowSetOf.get(e.setId);
    const playID = flowPlayID(e);
    if (flowSet === undefined || !playID) return;
    const tier = TIERS[e.tier];
    if (!tier) { oddTiers.set(e.tier, (oddTiers.get(e.tier) || 0) + 1); return; }
    const plays = atlasTiers.get(flowSet) || atlasTiers.set(flowSet, new Map()).get(flowSet);
    (plays.get(playID) || plays.set(playID, new Set()).get(playID)).add(tier);
  });

  const added = [];
  const mixedUntiered = [];
  const disagreements = [];
  const untieredNoAtlas = [];
  [...flowSetByID.keys()].sort((a, b) => a - b).forEach((setID) => {
    const set = flowSetByID.get(setID);
    const label = `set ${setID} ${set.setName}`;
    const ours = (sets[String(setID)] || {}).tier || null;
    const oursByPlay = new Map(Object.entries(editions)
      .filter(([key, v]) => v && v.tier && key.startsWith(`${setID}_`))
      .map(([key, v]) => [Number(key.split("_")[1]), v.tier]));
    const plays = atlasTiers.get(setID);
    if (!plays) {
      if (!ours && oursByPlay.size === 0 && (set.playIDs || []).length > 0) untieredNoAtlas.push(label);
      return;
    }
    const all = new Set([...plays.values()].flatMap((t) => [...t]));
    if (!ours && oursByPlay.size === 0) {
      if (all.size === 1) {
        const tier = [...all][0];
        added.push(`${label}: ${tier}`);
        if (apply) sets[String(setID)] = { ...(sets[String(setID)] || {}), tier };
      } else {
        mixedUntiered.push(`${label}: ${[...plays].map(([p, t]) => `${p} ${[...t].join("/")}`).join(", ")}`);
      }
      return;
    }
    plays.forEach((tiers, playID) => {
      const mine = oursByPlay.get(playID) || ours;
      if (!mine) disagreements.push(`${label}, play ${playID}: none here, Atlas ${[...tiers].join("/")}`);
      else if (tiers.size > 1 || !tiers.has(mine)) disagreements.push(`${label}, play ${playID}: ${mine} here, Atlas ${[...tiers].join("/")}`);
    });
  });

  console.log(`\nAtlas sets mapped to Flow sets: ${flowSetOf.size}${unmapped.length ? `; unmapped: ${unmapped.map(([id, n]) => `${n} (${id})`).join("; ")}` : ""}`);
  if (oddTiers.size) console.log(`Atlas tier values not recognised: ${JSON.stringify([...oddTiers])}`);
  console.log(`\nTiers: ${added.length} untiered set(s) Atlas tiers${apply ? " (written)" : ""}`);
  added.forEach((l) => console.log(`  + ${l}`));
  if (mixedUntiered.length) {
    console.log(`Untiered sets whose editions differ in Atlas (add per-edition tiers to data/additions/editions.json by hand):`);
    mixedUntiered.forEach((l) => console.log(`  ? ${l}`));
  }
  if (disagreements.length) {
    console.log(`Tiers that differ from Atlas (a judgment; nothing written):`);
    disagreements.forEach((l) => console.log(`  ! ${l}`));
  }
  if (untieredNoAtlas.length) console.log(`Untiered sets Atlas does not list yet: ${untieredNoAtlas.join("; ")}`);

  // ---- series names ---------------------------------------------------------
  const seriesFile = readJsonPreservingEol(SERIES_PATH);
  const seriesNames = seriesFile.data;
  const seriesAdditions = JSON.parse(readFileSync(SERIES_ADDITIONS_PATH, "utf8"));
  const nameOf = (series) => ((seriesAdditions[series] || {}).name) || ((seriesNames[series] || {}).name) || null;
  const allSeries = [...new Set(flowSets.map((s) => String(s.series)))].sort((a, b) => a - b);
  const unnamed = allSeries.filter((s) => !nameOf(s));
  const namedSeries = [];
  if (unnamed.length > 0) {
    const raw = await loadRawPlays({ previousRaw: loadSeedPlaysRaw() });
    const seasonOf = (series) => {
      const counts = new Map();
      flowSets.filter((s) => String(s.series) === series).forEach((s) => (s.playIDs || []).forEach((p) => {
        const season = (raw[String(p)] || {}).NbaSeason;
        if (season) counts.set(season, (counts.get(season) || 0) + 1);
      }));
      return majority(counts)[0];
    };
    unnamed.forEach((series) => {
      const lastNamed = allSeries.filter((s) => Number(s) < Number(series) && nameOf(s)).pop();
      const season = seasonOf(series);
      const ruleHolds = lastNamed && nameOf(lastNamed) === `Series ${seasonOf(lastNamed)}`;
      if (!season || !ruleHolds) {
        console.log(`\nSeries ${series} has no name, and none can be suggested (${!season ? "its plays carry no season" : `the last named series, ${lastNamed}, is not named after its season`}): name it in data/overrides/series.json`);
        return;
      }
      const name = `Series ${season}`;
      namedSeries.push(`series ${series}: ${name} (its plays' season; ${nameOf(lastNamed)} follows the same rule)`);
      if (apply) seriesNames[series] = { name };
    });
  }
  console.log(`\nSeries: ${unnamed.length === 0 ? "every series has a name" : `${namedSeries.length} unnamed series named${apply ? " (written)" : ""}`}`);
  namedSeries.forEach((l) => console.log(`  + ${l}`));

  if (!apply) {
    if (added.length || namedSeries.length) console.log("\nDry run; re-run with --apply to write.");
    return;
  }
  if (added.length) {
    writeJsonAtomic(SETS_PATH, sets, { space: indentOf(SETS_PATH), eol: setsFile.eol, trailing: setsFile.trailing });
    console.log(`Wrote ${path.relative(ROOT, SETS_PATH)}.`);
  }
  if (namedSeries.length) {
    writeJsonAtomic(SERIES_PATH, seriesNames, { space: indentOf(SERIES_PATH), eol: seriesFile.eol, trailing: seriesFile.trailing });
    console.log(`Wrote ${path.relative(ROOT, SERIES_PATH)}.`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
