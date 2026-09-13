#!/usr/bin/env node
/*
 * Fetches career and season honors from basketball-reference.com and
 * bakes them into data/awards/:
 *
 *   hall_of_fame.json  every Naismith Hall of Fame inductee in the
 *                      Player category (NBA and WNBA greats alike;
 *                      coaches, referees, contributors and teams are
 *                      excluded). Feeds the derived "Hall of Fame"
 *                      badge (overrides.service getCalculatedPlayTags).
 *   mvp.json           league MVP per season: NBA (the mvp_NBA table;
 *                      ABA rows skipped) and WNBA.
 *   roy.json           Rookie of the Year per season, NBA and WNBA
 *                      (a tied vote appears as two rows of one season).
 *
 * MVP and ROY are historical lookups baked for future derivations;
 * nothing reads them at runtime yet.
 *
 * Idempotent: output is sorted and timestamp-free, a file is only
 * rewritten when its content actually changed, and a page that fetches
 * or parses below its sanity floor aborts the whole run without
 * touching any existing file. Five requests, 2.5s apart, retried.
 *
 * Usage: npm run awards   (plain node, no JSON hook needed)
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/paths.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";
import { withRetries } from "./lib/retry.mjs";
import { normPlayerName } from "../src/services/name-norm.js";

const BASE = "https://www.basketball-reference.com";
const OUT_DIR = path.join(ROOT, "data", "awards");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TopShotExplorer-awards-fetch";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(urlPath) {
  return withRetries(async () => {
    const res = await fetch(`${BASE}${urlPath}`, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${urlPath}`);
    return res.text();
  }, `fetch ${urlPath}`, { attempts: 3, backoffMs: 2500 });
}

// ---- targeted HTML helpers (the BR award tables are static and regular) ----

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, " ")
  .replace(/&quot;/g, "\"")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const stripTags = (s) => s.replace(/<[^>]*>/g, "");

/** Rows of the table with this id; BR wraps some tables in HTML comments. */
function tableRows(html, tableId) {
  const clean = html.replace(/<!--/g, "").replace(/-->/g, "");
  const table = clean.match(new RegExp(`<table[^>]*id="${tableId}"[\\s\\S]*?</table>`));
  if (!table) return [];
  return table[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
}

/** Text of the row's data-stat cell, tags stripped and entities decoded. */
function cellText(row, stat) {
  const m = row.match(new RegExp(`data-stat="${stat}"[^>]*>([\\s\\S]*?)</t[dh]>`));
  if (!m) return null;
  return decodeEntities(stripTags(m[1])).replace(/\s+/g, " ").trim();
}

/** name_full holds "Name&nbsp;&nbsp;&nbsp;<span>profile links</span>";
 *  the name is everything before the padding. */
function hofName(row) {
  const m = row.match(/data-stat="name_full"[^>]*>([\s\S]*?)<\/td>/);
  if (!m) return null;
  return decodeEntities(stripTags(m[1].split("&nbsp;")[0])).replace(/\s+/g, " ").trim();
}

function parseHof(html) {
  const players = [];
  for (const row of tableRows(html, "hof")) {
    if (cellText(row, "category") !== "Player") continue;
    const year = Number(cellText(row, "year_id"));
    const name = hofName(row);
    if (!name || !Number.isFinite(year)) continue;
    players.push({ name, year });
  }
  players.sort((a, b) => a.year - b.year || a.name.localeCompare(b.name));
  return players;
}

/** BR decorates winners' names with a Hall of Fame asterisk and, on tied
 *  votes, a "(Tie)" note; neither is part of the name. */
const cleanPlayer = (s) => s.replace(/\(tie\)/gi, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();

/** One { season, player } per row; seasonStat is "season" (NBA pages,
 *  "2023-24") or "year_id" (WNBA pages, "2024"). Header rows carry the
 *  column titles as text and are dropped by the digit test. */
function parseSeasonAward(html, tableId, seasonStat) {
  const rows = [];
  for (const row of tableRows(html, tableId)) {
    const season = cellText(row, seasonStat);
    const player = cellText(row, "player");
    if (!season || !player || !/^\d/.test(season)) continue;
    rows.push({ season, player: cleanPlayer(player) });
  }
  rows.sort((a, b) => a.season.localeCompare(b.season) || a.player.localeCompare(b.player));
  return rows;
}

// ---- output ----

function writeIfChanged(file, value, label) {
  const target = path.join(OUT_DIR, file);
  const next = JSON.stringify(value, null, 2);
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (prev === next) {
    console.log(`${label}: unchanged`);
    return;
  }
  writeJsonAtomic(target, value, { space: 2 });
  console.log(`${label}: wrote data/awards/${file}`);
}

/** Normalized FullNames of every player in the baked seed, for the
 *  overlap report; null when no seed is around (report just skips). */
function seedPlayerNames() {
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "seed", "topshot-seed.json"), "utf8"));
    const names = new Set();
    for (const p of Object.values(seed.playsRaw || {})) {
      if (p && p.FullName) names.add(normPlayerName(p.FullName));
    }
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}

async function main() {
  const pages = {};
  const order = [
    ["hof", "/awards/hof.html"],
    ["mvp", "/awards/mvp.html"],
    ["roy", "/awards/roy.html"],
    ["wnbaMvp", "/wnba/awards/mvp.html"],
    ["wnbaRoy", "/wnba/awards/roy.html"]
  ];
  for (let i = 0; i < order.length; i++) {
    const [key, urlPath] = order[i];
    if (i > 0) await sleep(2500);
    pages[key] = await fetchPage(urlPath);
    console.log(`fetched ${urlPath} (${pages[key].length.toLocaleString()} bytes)`);
  }

  const hof = parseHof(pages.hof);
  const mvpNBA = parseSeasonAward(pages.mvp, "mvp_NBA", "season");
  const royNBA = parseSeasonAward(pages.roy, "roy_NBA", "season");
  const mvpWNBA = parseSeasonAward(pages.wnbaMvp, "mvp", "year_id");
  const royWNBA = parseSeasonAward(pages.wnbaRoy, "rookieoftheyear", "year_id");

  // Sanity floors: a page layout change must fail loudly, never bake a
  // silently shrunken list over a good one
  const floors = [
    ["Hall of Fame players", hof.length, 150],
    ["NBA MVP seasons", mvpNBA.length, 60],
    ["NBA ROY seasons", royNBA.length, 60],
    ["WNBA MVP seasons", mvpWNBA.length, 25],
    ["WNBA ROY seasons", royWNBA.length, 25]
  ];
  const broken = floors.filter(([, n, floor]) => n < floor);
  if (broken.length > 0) {
    for (const [what, n, floor] of broken) {
      console.error(`PARSE FAILURE: ${what} = ${n} (expected at least ${floor}); page layout changed?`);
    }
    console.error("Nothing written.");
    process.exit(1);
  }
  for (const [what, n] of floors) console.log(`  ${what}: ${n}`);

  writeIfChanged("hall_of_fame.json", {
    source: `${BASE}/awards/hof.html`,
    note: "Naismith Hall of Fame inductees, Player category only. Feeds the derived Hall of Fame badge; matching is by normalized full name (src/services/name-norm.js).",
    players: hof
  }, "hall_of_fame");
  writeIfChanged("mvp.json", {
    source: { NBA: `${BASE}/awards/mvp.html`, WNBA: `${BASE}/wnba/awards/mvp.html` },
    note: "League MVP per season (ABA excluded). Historical lookup; not yet used in tag derivation.",
    NBA: mvpNBA,
    WNBA: mvpWNBA
  }, "mvp");
  writeIfChanged("roy.json", {
    source: { NBA: `${BASE}/awards/roy.html`, WNBA: `${BASE}/wnba/awards/roy.html` },
    note: "Rookie of the Year per season (ABA excluded; ties are two rows). Historical lookup; not yet used in tag derivation.",
    NBA: royNBA,
    WNBA: royWNBA
  }, "roy");

  // How much of each list maps onto players who already have moments;
  // the rest is future-proofing
  const seedNames = seedPlayerNames();
  if (seedNames) {
    const overlap = (names) => {
      const set = new Set(names.map(normPlayerName));
      let hit = 0;
      set.forEach((n) => { if (seedNames.has(n)) hit++; });
      return `${hit} of ${set.size} names already have moments`;
    };
    console.log("Seed overlap:");
    console.log(`  Hall of Fame: ${overlap(hof.map((r) => r.name))}`);
    console.log(`  NBA MVP: ${overlap(mvpNBA.map((r) => r.player))}`);
    console.log(`  NBA ROY: ${overlap(royNBA.map((r) => r.player))}`);
    console.log(`  WNBA MVP: ${overlap(mvpWNBA.map((r) => r.player))}`);
    console.log(`  WNBA ROY: ${overlap(royWNBA.map((r) => r.player))}`);
  } else {
    console.log("No seed snapshot found; skipping the overlap report.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
