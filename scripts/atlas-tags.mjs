// Answer-sheet comparison: Atlas badges and play facts vs our data.
//
// For every Atlas play (joined to its Flow play through data/dapper/plays.json
// playUUID) this reports, per badge, where Atlas and we agree and where
// we differ: derived tags (Top Shot Debut, Rookie Year, Championship Year,
// Rookie Mint) against the app's own derivation, the rest (Rookie Premiere,
// MVP Year, ...) against the stored tags. It also cross-checks NbaSeason and
// the moment date. Atlas is a source, not an oracle (it has said "2010-12"
// about a 2011 game); every difference is a judgment, not a fix.
//
// Usage:
//   npm run atlas:tags                       report only
//   npm run atlas:tags -- --import           also write Atlas badges into
//         data/additions/plays.json tags (then run `npm run reconcile`, which
//         strips the copies our derivation already produces; the rest show
//         on the Corrections page as disagreements)
//   --atlas <file>     answer sheet (default data/atlas/editions.json)
//   --raw <file>       saved raw play snapshot instead of a chain fetch
//   --save-raw <file>  save the fetched snapshot for later runs
//   --show <n>         differences listed per badge (default 15)
//   --report <file>    also write every difference as Markdown tables
//                      (play, ours, Atlas, and where each side's value
//                      comes from) for review
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadRawPlays } from "./lib/raw-plays.mjs";
import { seedEditions } from "./lib/seed-facts.mjs";
import {
  compilePlayMetadata, buildTsdIndex, buildMintClock, buildNameAliases, getCalculatedPlayTags, attachMintTotals,
  COMPUTABLE_TAG_NAMES, TAG_BADGES, isWnbaTeamId as isWnbaId
} from "../src/services/overrides.service.js";
import { flag, opt } from "./lib/args.mjs";
import { readJsonPreservingEol, writeJsonAtomic } from "./lib/json-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS_PATH = path.resolve(ROOT, opt("--atlas", "data/atlas/editions.json"));
const ADDITIONS_PATH = path.join(ROOT, "data", "additions", "plays.json");
const DAPPER_PLAYS_PATH = path.join(ROOT, "data", "dapper", "plays.json");
const SHOW = Number(opt("--show", 15));
const doImport = flag("--import");
const REPORT = opt("--report", null);

// Badge titles Atlas can assert at PLAY level that the app knows how to
// show (Cup Year and Autograph are ours alone and never come from Atlas;
// the reward badges are edition-level and belong to `npm run
// atlas:editions`)
const ATLAS_VOCAB = TAG_BADGES.filter((b) => !b.reward).map((b) => b.tag).filter((t) => t !== "Cup Year" && t !== "Autograph");
const dateOnly = (s) => (String(s || "").match(/^\d{4}-\d{2}-\d{2}/) || [""])[0];


// Atlas stores the tip-off instant in UTC ("2019-11-06T03:30:00"; a 7pm ET
// tip is "T00:00:00" the next UTC day, and the legends drops carry the same
// instant in the on-chain style "2000-04-01 00:00:00 +0000 UTC" for a game
// played 2000-03-31). The house date is the Eastern calendar day, exactly as
// the app converts it, so both sides are compared on that day.
const easternDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const atlasDate = (s) => {
  const str = String(s || "");
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (!m) return dateOnly(str);
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? m[1] : easternDate.format(d);
};
// Atlas writes WNBA seasons in the NBA "2024-25" shape; the house format is
// the single year
const houseSeason = (season, wnba) => {
  const s = String(season || "").trim();
  const y = s.match(/^(\d{4})/);
  return wnba && y ? y[1] : s;
};

async function main() {
  const atlas = JSON.parse(readFileSync(ATLAS_PATH, "utf8"));
  const { data: additions, eol, trailing } = readJsonPreservingEol(ADDITIONS_PATH);
  const dapperPlays = JSON.parse(readFileSync(DAPPER_PLAYS_PATH, "utf8"));
  console.log(`Atlas sheet from ${atlas.fetchedAt}: ${atlas.editions.length} editions`);

  // One Atlas play per GUID: badges are the union over its editions
  const atlasPlays = new Map();
  atlas.editions.forEach((e) => {
    if (!e.guid) return;
    const p = atlasPlays.get(e.guid) || { badges: new Set(), play: e.play, editions: 0 };
    e.badges.forEach((b) => p.badges.add(b));
    p.editions++;
    atlasPlays.set(e.guid, p);
  });
  const flowIdByGuid = new Map();
  Object.entries(dapperPlays).forEach(([id, e]) => { if (e && e.playUUID) flowIdByGuid.set(e.playUUID, id); });

  const raw = await loadRawPlays({ rawPath: opt("--raw", null), saveRawPath: opt("--save-raw", null) });
  buildNameAliases(raw);
  const plays = attachMintTotals(Object.entries(raw).map(([id, m]) => compilePlayMetadata(id, m)).filter(Boolean), seedEditions());
  const byId = new Map(plays.map((p) => [String(p.playID), p]));
  const tsdIndex = buildTsdIndex(plays);
  const mintClock = buildMintClock(plays);

  const stats = {};
  ATLAS_VOCAB.forEach((t) => { stats[t] = { atlas: 0, ours: 0, both: 0, atlasOnly: [], oursOnly: [] }; });
  const facts = { season: [], date: [] };
  const vocab = {};
  let joined = 0;
  const unjoined = [];
  let imported = 0;
  // Rows for the Markdown report: { kind, id, name, team, date, season, ours, atlas, note }
  const rows = [];

  atlasPlays.forEach((a, guid) => {
    a.badges.forEach((b) => { vocab[b] = (vocab[b] || 0) + 1; });
    const flowId = flowIdByGuid.get(guid);
    const play = flowId && byId.get(flowId);
    if (!play) { unjoined.push(`${(a.play || {}).FullName || (a.play || {}).TeamAtMoment || "?"} ${dateOnly((a.play || {}).DateOfMoment)} (${guid})`); return; }
    joined++;
    const derived = new Set(getCalculatedPlayTags({ ...play, tags: [] }, null, tsdIndex, mintClock));
    const stored = new Set((additions[flowId] && additions[flowId].tags) || []);
    const label = `#${flowId} ${play.FullName || play.TeamAtMoment} (${dateOnly(play.DateOfMoment) || "no date"} · ${play.NbaSeason || "no season"})`;
    const base = { id: flowId, name: play.FullName || play.TeamAtMoment || "?", team: play.TeamAtMoment || "", date: dateOnly(play.DateOfMoment) || "no date", season: play.NbaSeason || "no season" };

    ATLAS_VOCAB.forEach((t) => {
      const computable = COMPUTABLE_TAG_NAMES.has(t);
      const ours = computable ? derived.has(t) : stored.has(t);
      const theirs = a.badges.has(t);
      const s = stats[t];
      if (theirs) s.atlas++;
      if (ours) s.ours++;
      if (theirs && ours) s.both++;
      if (theirs && !ours) s.atlasOnly.push(label);
      if (!theirs && ours) s.oursOnly.push(label);
      if (theirs !== ours) {
        rows.push({ ...base, kind: t, ours: ours ? "yes" : "no", atlas: theirs ? "yes" : "no", note: computable ? (ours ? "we derive it from our data" : "our data does not derive it") : (ours ? "stored in additions" : "not stored in additions") });
      }
    });

    // Play facts: season and date, both sides in the same shape
    const ap = a.play || {};
    const wnba = isWnbaId(play.TeamAtMomentNBAID);
    const as = houseSeason(ap.NbaSeason, wnba);
    if (as && play.NbaSeason && as !== String(play.NbaSeason)) {
      facts.season.push(`${label}: Atlas ${ap.NbaSeason}`);
      rows.push({ ...base, kind: "NbaSeason", ours: String(play.NbaSeason), atlas: String(ap.NbaSeason), note: "" });
    }
    const ad = atlasDate(ap.DateOfMoment);
    const od = dateOnly(play.DateOfMoment);
    if (ad && od && ad !== od) {
      facts.date.push(`${label}: Atlas ${ad} (${ap.DateOfMoment} UTC)`);
      rows.push({ ...base, kind: "DateOfMoment", ours: od, atlas: ad, note: `Atlas raw ${ap.DateOfMoment}` });
    }

    if (doImport) {
      // Atlas owns the badges it can assert; anything else stored stays
      const keep = [...stored].filter((t) => !ATLAS_VOCAB.includes(t));
      const next = [...keep, ...ATLAS_VOCAB.filter((t) => a.badges.has(t))];
      const entry = (additions[flowId] = additions[flowId] || {});
      const before = JSON.stringify(entry.tags || []);
      if (next.length === 0) delete entry.tags; else entry.tags = next;
      if (JSON.stringify(entry.tags || []) !== before) imported++;
    }
  });

  console.log(`Atlas plays: ${atlasPlays.size}; joined to Flow plays: ${joined}; unjoined: ${unjoined.length}`);
  if (unjoined.length) console.log(`  unjoined (no playUUID link yet; usually new mints or twins):\n    ${unjoined.slice(0, SHOW).join("\n    ")}${unjoined.length > SHOW ? `\n    ... ${unjoined.length - SHOW} more` : ""}`);
  console.log("Atlas badge vocabulary (plays):", JSON.stringify(vocab));
  const unknownVocab = Object.keys(vocab).filter((b) => !ATLAS_VOCAB.includes(b));
  if (unknownVocab.length) console.log(`  not tracked here (edition-level reward badges go through atlas:editions): ${unknownVocab.join(", ")}`);

  console.log("\nBadge            atlas   ours  agree  atlas-only  ours-only");
  ATLAS_VOCAB.forEach((t) => {
    const s = stats[t];
    if (s.atlas + s.ours === 0) return;
    console.log(`${t.padEnd(18)}${String(s.atlas).padStart(5)}${String(s.ours).padStart(7)}${String(s.both).padStart(7)}${String(s.atlas - s.both).padStart(12)}${String(s.ours - s.both).padStart(11)}`);
  });
  const list = (arr, title) => {
    if (!arr.length) return;
    console.log(`\n${title} (${arr.length}):\n  ${arr.slice(0, SHOW).join("\n  ")}${arr.length > SHOW ? `\n  ... ${arr.length - SHOW} more` : ""}`);
  };
  ATLAS_VOCAB.forEach((t) => {
    list(stats[t].atlasOnly, `${t}: Atlas has it, we do not`);
    list(stats[t].oursOnly, `${t}: we have it, Atlas does not`);
  });
  list(facts.season, "NbaSeason differs");
  list(facts.date, "Moment date differs");

  if (REPORT) {
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    const kinds = [...ATLAS_VOCAB, "NbaSeason", "DateOfMoment"];
    const md = [`# Atlas vs our data (${atlas.fetchedAt.slice(0, 10)})`, "", `Atlas plays ${atlasPlays.size}, joined ${joined}, unjoined ${unjoined.length}. "Ours" is what the app shows today; "Atlas" is Dapper's catalogue. Every row is a judgment, not a fix.`, ""];
    kinds.forEach((kind) => {
      const list = rows.filter((r) => r.kind === kind);
      if (list.length === 0) return;
      md.push(`## ${kind} (${list.length})`, "", "| Play | Player | Team | Date | Season | Ours | Atlas | Note |", "|---|---|---|---|---|---|---|---|");
      list.forEach((r) => md.push(`| #${r.id} | ${esc(r.name)} | ${esc(r.team)} | ${r.date} | ${r.season} | ${esc(r.ours)} | ${esc(r.atlas)} | ${esc(r.note)} |`));
      md.push("");
    });
    if (unjoined.length) md.push(`## Unjoined Atlas plays (${unjoined.length})`, "", ...unjoined.map((u) => `- ${u}`), "");
    writeFileSync(path.resolve(REPORT), md.join("\n"));
    console.log(`\nWrote ${path.relative(ROOT, path.resolve(REPORT))} (${rows.length} rows).`);
  }

  if (doImport) {
    writeJsonAtomic(ADDITIONS_PATH, additions, { space: 2, eol, trailing });
    console.log(`\nImported Atlas badges into ${imported} entries of ${path.relative(ROOT, ADDITIONS_PATH)}. Run \`npm run reconcile\` next.`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
