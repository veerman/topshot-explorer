// Harvests Dapper's Atlas v2 edition catalogue as an answer sheet.
//
// Atlas (api.production.atlas.dapperlabs.com, Connect-RPC JSON) is what the
// current nbatopshot.com site runs on. It is Cloudflare-gated for plain HTTP
// clients, so the calls run from inside a real Chrome page on nbatopshot.com
// (puppeteer-core, no login needed). One edition per (set, play, parallel),
// slimmed to what the other atlas-* scripts consume:
//   id, guid (play GUID from the asset path; joins data/dapper/plays.json playUUID),
//   setId, setName, seriesId, tier, parallel ("Standard" or a parallel
//   name), badges (titles), numMinted, maxMintSize, numBurned, autographedAt
//   (per edition: which parallel is actually signed), and the play fields
//   worth cross-checking (names, teams, date, season, draft, autograph type).
//
// Usage:
//   npm run atlas:harvest                  writes data/atlas/editions.json
//   --out <file>        another output path
//   --chrome <path>     Chrome executable (default: env CHROME_PATH, then the
//                       standard Windows install path)
//   --profile <dir>     Chrome profile dir (default scratch/chrome-profile-atlas;
//                       throwaway, created on first run)
//   --max-pages <n>     stop early (testing)
//   --limit <n>         page size asked for (default 100, Atlas caps it there)
//   --sort <option>     Atlas sortByOption, e.g. DOLLAR_VOLUME_30D (default none:
//                       ids descending, the only order a full sweep can trust)
//   --dir ASC|DESC      with --sort (default DESC)
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { opt, num } from "./lib/args.mjs";
import { writeFileAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, opt("--out", "data/atlas/editions.json"));
const CHROME = opt("--chrome", process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe");
const PROFILE = path.resolve(ROOT, opt("--profile", "scratch/chrome-profile-atlas"));
const MAX_PAGES = num("--max-pages", 0) || Infinity;
const LIMIT = num("--limit", 100);
// --raw-out <file>: also keep the unslimmed rows of the pages fetched (for
// checking which Atlas fields exist before slimming); pair with --max-pages
const RAW_OUT = opt("--raw-out", "");
// Paging is only complete under an order that cannot change mid-sweep.
// Sorted by 30-day dollar volume (the site's default) a row slides across
// a page boundary while the sweep runs and is missed: two September 2026
// sweeps each came back one edition short, a different one each time.
// With no sort given Atlas serves ids descending, which never moves.
const SORT = opt("--sort", "");
const DIR = opt("--dir", "DESC");

const ATLAS_SEARCH = "https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions";
const PLAY_FIELDS = [
  "FullName", "FirstName", "LastName", "TeamAtMoment", "TeamAtMomentNBAID", "DateOfMoment", "NbaSeason",
  "PlayCategory", "PlayType", "JerseyNumber", "DraftYear", "DraftTeam", "DraftRound", "DraftSelection",
  "TotalYearsExperience", "Birthdate", "Birthplace", "HomeTeamName", "HomeTeamScore", "AwayTeamName", "AwayTeamScore",
  "PlayerAutographType", "PlayerAutographSigner"
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(path.dirname(OUT), { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: PROFILE,
    headless: "new",
    args: ["--disable-blink-features=AutomationControlled"]
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    await page.goto("https://nbatopshot.com/search", { waitUntil: "networkidle2", timeout: 90000 });

    // Runs inside the page; slims each edition before it crosses the bridge
    const fetchPage = (offset, limit) => page.evaluate(async (url, offset, limit, fields, sort, dir, keepRaw) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "connect-protocol-version": "1" },
        body: JSON.stringify({ product: "nba", ...(sort ? { sortByOption: sort, sortByDirection: dir } : {}), limit: String(limit), offset: String(offset) })
      });
      if (!res.ok) return { error: res.status, text: (await res.text()).slice(0, 400) };
      const j = await res.json();
      return {
        pagination: j.pagination,
        raw: keepRaw ? j.editions : undefined,
        rows: (j.editions || []).map((e) => {
          const meta = ((e.editionTemplate || {}).metadata) || {};
          const play = {};
          fields.forEach((f) => { if (meta[f] !== undefined && meta[f] !== "") play[f] = meta[f]; });
          return {
            id: e.id,
            guid: (((e.metadata || {}).assetPathPrefix || "").match(/play_([0-9a-f-]{36})/) || [])[1] || null,
            setId: e.setId,
            setName: (e.set || {}).name || "",
            seriesId: e.seriesId,
            tier: e.tier,
            parallel: e.parallel || "Standard",
            badges: (e.badges || []).map((b) => b.title).filter(Boolean).sort(),
            numMinted: Number(e.numMinted) || 0,
            maxMintSize: Number(e.maxMintSize) || 0,
            numBurned: Number(e.numBurned) || 0,
            // Per edition, so a signed parallel shows beside its unsigned
            // siblings; the play-level PlayerAutographType cannot tell them apart
            autographedAt: e.autographedAt || null,
            play
          };
        })
      };
    }, ATLAS_SEARCH, offset, limit, PLAY_FIELDS, SORT, DIR, Boolean(RAW_OUT));

    const first = await fetchPage(0, LIMIT);
    if (first.error) throw new Error(`Atlas answered HTTP ${first.error} on the first page: ${first.text || ""}`);
    const pageSize = first.rows.length;
    const total = Number(first.pagination.totalCount);
    console.log(`Atlas reports ${total} editions; page size ${pageSize}`);

    const editions = new Map();
    const rawRows = [];
    const absorb = (rows, raw) => { rows.forEach((r) => { if (!editions.has(r.id)) editions.set(r.id, r); }); if (raw) rawRows.push(...raw); };
    absorb(first.rows, first.raw);

    let pages = 1;
    for (let offset = pageSize; offset < total && pages < MAX_PAGES; offset += pageSize, pages++) {
      let result = null;
      for (let attempt = 1; attempt <= 4 && !result; attempt++) {
        try {
          const r = await fetchPage(offset, pageSize);
          if (r.error) throw new Error(`HTTP ${r.error}`);
          result = r;
        } catch (err) {
          console.log(`  offset ${offset}, attempt ${attempt} failed: ${String(err.message).slice(0, 80)}`);
          await wait(3000 * attempt);
        }
      }
      if (!result) throw new Error(`gave up at offset ${offset} (${editions.size} editions so far); nothing written`);
      absorb(result.rows, result.raw);
      if (pages % 10 === 0) process.stdout.write(`\r  ${editions.size} editions...`);
      await wait(300);
    }
    process.stdout.write("\n");
    if (RAW_OUT) { writeFileAtomic(path.resolve(ROOT, RAW_OUT), JSON.stringify(rawRows, null, 1)); console.log(`raw rows: ${rawRows.length} -> ${RAW_OUT}`); }

    // Sorted by numeric id and one edition per line: stable, diff-friendly
    const list = [...editions.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const header = { fetchedAt: new Date().toISOString(), source: "atlas.v1.EditionService/SearchEditions (product nba)", totalCount: total, editionCount: list.length };
    const body = `{\n${Object.entries(header).map(([k, v]) => ` "${k}": ${JSON.stringify(v)},`).join("\n")}\n "editions": [\n${list.map((e) => "  " + JSON.stringify(e)).join(",\n")}\n ]\n}\n`;
    writeFileAtomic(OUT, body);

    const parallels = {};
    const badges = {};
    list.forEach((e) => {
      parallels[e.parallel] = (parallels[e.parallel] || 0) + 1;
      e.badges.forEach((b) => { badges[b] = (badges[b] || 0) + 1; });
    });
    console.log(`Wrote ${path.relative(ROOT, OUT)}: ${list.length} editions (${list.filter((e) => !e.guid).length} without a play GUID)`);
    console.log("parallels:", JSON.stringify(parallels));
    console.log("badges (edition counts):", JSON.stringify(badges));
    if (list.length < total) console.warn(`WARNING: ${total - list.length} edition(s) short of Atlas's count; re-run`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
