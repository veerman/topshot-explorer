// Generates the SET ART (or set/team art) for every set in the app by
// splitting HERO images (scripts/lib/hero-split.mjs): the right cube face
// of a hero render IS the set art. Extraction uses the FIXED canonical
// trapezoids (FIXED_QUADS, measured from hand-painted masks):
// the render camera never moves, so the face sits at the same absolute
// pixels in every hero of a render generation ("old" quad for roughly
// S1-S5, "new" for S6+); nothing is detected per image.
//
// Core sets (Base Set, Metallic Gold LE, Holo MMXX...) carry per-TEAM set
// art, so one hero per team in the set is processed; every other set has
// one shared set art, so a single hero suffices.
//
// Data comes fully offline: public/seed/topshot-seed.json for set names,
// editions and HERO CIDs plus play metadata (TeamAtMoment), the
// image-borders lookup for the border crop, and the local IPFS mirror
// (ipfs_dirs.json search dirs) for the files themselves.
//
//   node scripts/extract-set-art.mjs [options]
//     --set N     only this setID
//     --limit N   stop after N new extractions
//     --size N    output resolution (default 1024)
//     --out DIR   output dir (default assets/sets; generated, never committed)
//     --dry-run   print the plan (which editions would be processed) only
//     --force     re-extract even when the output file already exists
//     --single    one art per set: no per-team fan-out and no verifier
//                 pass (review mode)
//
// Output: <out>/<setID>_<playID>_0-<set_name_slug>-<tier>.jpg (edition id
// setID_playID_subeditionID, then set name, then tier, "-" separated;
// the trailing tier is SUPPRESSED when the set name already mentions
// it, so it never appears twice) plus <out>/index.json, a manifest mapping each set to
// its file(s), mode and quad variant. Mixed-tier sets get one file per tier;
// heroes that are stray raw play photos (no border on every side) are
// skipped, and sets where EVERY hero is such a photo land in the
// manifest's noCubeHero list (no usable set art exists for them).
//
// Idempotent: existing output files are skipped; rerun after topping up
// the mirror or the seed to fill gaps.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  ROOT, findCachedImage, loadBorderLookup,
  extractSetArtFixed, fixedQuadVariantForSeries
} from "./lib/hero-split.mjs";
import { flag, opt, num } from "./lib/args.mjs";
import { seedFacts } from "./lib/seed-facts.mjs";

const ONLY_SET = opt("--set", null);
const LIMIT = num("--limit", Infinity) || Infinity;
const SIZE = num("--size", 1024);
const OUT_DIR_RAW = opt("--out", join("assets", "sets"));
const OUT_DIR = isAbsolute(OUT_DIR_RAW) ? OUT_DIR_RAW : join(ROOT, OUT_DIR_RAW);
const DRY = flag("--dry-run");
const FORCE = flag("--force");
const SINGLE = flag("--single");

// Sets whose art varies by team (one file per team); everything else gets
// one file per set. Extend as more core-style sets appear.
// Added: 141 The Champion's Path 2024, 52 Platinum Ice,
// 56 Metallic Silver FE (NOT 167 Metallic Silver), 73 WNBA Base Set
// (pattern covers it), 102 Fit Check (unconfirmed, "i think but maybe
// not").
const SET_TEAM_ART_PATTERNS = [/base set/i, /metallic gold/i, /holo/i];
const SET_TEAM_ART_IDS = new Set([141, 52, 56, 73, 102]);
const isTeamArtSet = (setID, name) =>
  SET_TEAM_ART_IDS.has(setID) || SET_TEAM_ART_PATTERNS.some((re) => re.test(name));

// spaces -> underscore, alphanumerics kept, every other char -> dash
const slug = (name) => name.toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "-");

const { seed, namesBySet, seriesBySet, tierFor, teamFor } = seedFacts();
const mismints = new Set(JSON.parse(readFileSync(join(ROOT, "data", "plays_exclude.json"), "utf8")).map(String));
const lookup = loadBorderLookup();
const heroFor = (ed) => (ed.ipfsCIDs || {}).HERO || null;

// A real cube-render hero floats in padding on all four sides. A hero
// with NO border on some side is a stray raw play photo (a known Dapper
// mistake) and would poison the extraction, so it is skipped; another
// edition of the set supplies the art instead. Missing lookup entries
// pass (the extraction measures inline anyway).
const isCubeHero = (cid) => {
  const entry = lookup[cid];
  if (!Array.isArray(entry)) return true;
  return Math.min(entry[2], entry[3], entry[4], entry[5]) > 0;
};

// ---------- plan: which (set, edition) pairs to process ----------
// Buckets: every distinct TIER in a set gets its own art (mixed-tier sets
// carry different art per tier), and team-art sets additionally fan out
// per team (unless --single).
const plan = []; // { setID, setName, mode, playID, team, tier, cid, file, dest }
const noHero = [];
const noCubeHero = [];
for (const sd of seed.setDetails) {
  const setID = Number(sd.id);
  if (ONLY_SET && setID !== Number(ONLY_SET)) continue;
  const setName = namesBySet.get(setID) || `set ${setID}`;
  const mode = !SINGLE && isTeamArtSet(setID, setName) ? "team" : "set";

  // Candidate editions in play order, mismints out, HERO required
  const candidates = [...sd.editions]
    .sort((a, b) => a.playOrder - b.playOrder)
    .filter((ed) => !mismints.has(String(Number(ed.playID))) && heroFor(ed));
  const cubeCandidates = candidates.filter((ed) => isCubeHero(heroFor(ed)));
  const photosSkipped = candidates.length - cubeCandidates.length;

  // One pick per bucket. When ONE image represents a team-art set (no
  // per-team fan-out), a fixed team preference decides whose art it is:
  // Raptors, then Lakers (WNBA sets: Aces, then Fever), otherwise an
  // arbitrary-but-stable pick (rotated by setID so it is not always the
  // first play, but reruns stay deterministic). Raw TeamAtMoment values
  // need trimming ("Indiana Fever " ships with a trailing space).
  const prefTeams = /wnba/i.test(setName)
    ? ["Las Vegas Aces", "Indiana Fever"]
    : ["Toronto Raptors", "Los Angeles Lakers"];
  const buckets = new Map(); // bucket -> candidate list in play order
  for (const ed of cubeCandidates) {
    const playID = Number(ed.playID);
    const tier = tierFor(setID, playID);
    const team = teamFor(playID);
    const bucket = mode === "team" ? `${tier}|${team}` : tier;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ playID, tier, team, cid: heroFor(ed) });
  }
  const picks = new Map(); // bucket -> { playID, tier, team, cid, file }
  for (const [bucket, cands] of buckets) {
    let ordered = cands;
    if (mode === "set" && isTeamArtSet(setID, setName)) {
      const preferred = prefTeams
        .map((t) => cands.find((c) => c.team.trim() === t))
        .filter(Boolean);
      const rest = cands.filter((c) => !preferred.includes(c));
      const rot = rest.length ? setID % rest.length : 0;
      ordered = [...preferred, ...rest.slice(rot), ...rest.slice(0, rot)];
    }
    for (const c of ordered) {
      const file = findCachedImage(c.cid);
      if (!file) continue; // hero not mirrored locally; try the next
      picks.set(bucket, { ...c, team: mode === "team" ? c.team : null, file });
      break;
    }
  }

  if (picks.size === 0) {
    if (candidates.length > 0 && cubeCandidates.length === 0) noCubeHero.push({ setID, setName, photosSkipped });
    else noHero.push({ setID, setName, editions: sd.editions.length });
    continue;
  }
  // Single-art sets get a VERIFIER: a hero from a different team, whose
  // extraction is compared (not saved) against the primary. Some sets that
  // look like shared art actually carry the team logo (the early styles),
  // and a low similarity flags that in the manifest for review.
  let verify = null;
  if (mode === "set" && !SINGLE) {
    const primary = [...picks.values()][0];
    const primaryTeam = teamFor(primary.playID);
    for (const ed of cubeCandidates) {
      if (Number(ed.playID) === primary.playID || teamFor(ed.playID) === primaryTeam) continue;
      if (tierFor(setID, Number(ed.playID)) !== primary.tier) continue;
      const cid = heroFor(ed);
      const file = findCachedImage(cid);
      if (!file) continue;
      verify = { playID: Number(ed.playID), cid, file };
      break;
    }
  }
  for (const p of picks.values()) {
    // Everything flattens to black and saves as jpg (transparency is not needed here, and webp/avif are out because
    // Windows tooling still mishandles them; lossless png on noisy art
    // was 3MB+ per file). Tier goes at the END of the name, and is
    // suppressed entirely when the set name already mentions it (e.g.
    // "2025 NBA Playoffs: Legendary"), so a tier never appears twice.
    const nameSlug = slug(setName);
    const tierSlug = slug(p.tier);
    // startsWith so plurals count as a mention ("Rookie Ultimates")
    const tierInName = nameSlug.split(/[_-]+/).some((w) => w.startsWith(tierSlug));
    plan.push({
      setID, setName, mode, verify,
      team: p.team, tier: p.tier,
      playID: p.playID, cid: p.cid, file: p.file,
      dest: `${setID}_${p.playID}_0-${nameSlug}${tierInName ? "" : `-${tierSlug}`}.jpg`,
      photosSkipped: photosSkipped || undefined
    });
  }
}

const teamSets = new Set(plan.filter((p) => p.mode === "team").map((p) => p.setID));
const multiTier = new Set(plan.filter((p, _, all) => all.some((q) => q.setID === p.setID && q.tier !== p.tier)).map((p) => p.setID));
console.log(`plan: ${plan.length} extractions over ${new Set(plan.map((p) => p.setID)).size} sets (${teamSets.size} team-art sets; ${multiTier.size} mixed-tier sets: ${[...multiTier].join(", ") || "none"})`);
if (noHero.length) console.log(`sets with NO locally mirrored hero: ${noHero.map((s) => `${s.setID} ${s.setName}`).join("; ")}`);
if (noCubeHero.length) console.log(`sets whose heroes are ALL raw play photos (unusable): ${noCubeHero.map((s) => `${s.setID} ${s.setName}`).join("; ")}`);

if (DRY) {
  for (const p of plan) console.log(`${p.dest}  <- ${p.cid}${p.team ? `  [${p.team}]` : ""}`);
  process.exit(0);
}

// ---------- run ----------
mkdirSync(OUT_DIR, { recursive: true });
const manifestPath = join(OUT_DIR, "index.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { sets: {}, failures: [] };
manifest.generatedAt = new Date().toISOString();

const fileEntries = new Map(); // dest -> manifest file entry (kept if skipped)
for (const s of Object.values(manifest.sets)) {
  for (const f of s.files || []) fileEntries.set(f.file, f);
}

// Pearson correlation of two equally sized greyscale buffers
const correlate = (a, b) => {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; }
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den === 0 ? 1 : (n * sab - sa * sb) / den;
};
// flatten() first: greyscale().raw() on an alpha image emits 2 channels
// and would garble the correlation
const thumb = (image) => image.clone().flatten({ background: "#000" }).greyscale().resize(64, 64, { fit: "fill" }).raw().toBuffer();

let done = 0, skipped = 0, failed = 0, suspects = 0, teamVaries = 0;
const failures = [];
const start = Date.now();

for (const p of plan) {
  const destPath = join(OUT_DIR, p.dest);
  if (!FORCE && existsSync(destPath) && fileEntries.has(p.dest)) { skipped++; continue; }
  if (done >= LIMIT) break;
  try {
    const variant = fixedQuadVariantForSeries(seriesBySet.get(p.setID));
    const { image } = await extractSetArtFixed(p.file, { variant, size: SIZE });
    await image.flatten({ background: "#000" }).jpeg({ quality: 92, mozjpeg: true }).toFile(destPath);

    const entry = {
      file: p.dest, playID: p.playID, team: p.team, tier: p.tier, cid: p.cid,
      variant
    };
    if (p.verify) {
      try {
        const v = await extractSetArtFixed(p.verify.file, { variant, size: SIZE });
        entry.similarity = Number(correlate(await thumb(image), await thumb(v.image)).toFixed(3));
        entry.verifyCid = p.verify.cid;
        if (entry.similarity < 0.9) { entry.teamVaries = true; teamVaries++; }
      } catch (err) {
        entry.verifyError = err.message;
      }
    }
    fileEntries.set(p.dest, entry);
    done++;
    if (done % 10 === 0) {
      const mins = ((Date.now() - start) / 60000).toFixed(1);
      console.log(`${done} extracted (${skipped} skipped, ${failed} failed, ${suspects} suspect), ${mins} min`);
    }
  } catch (err) {
    failed++;
    failures.push({ setID: p.setID, playID: p.playID, cid: p.cid, error: err.message });
    console.warn(`FAILED set ${p.setID} play ${p.playID} (${p.cid}): ${err.message}`);
  }
}

// Rebuild the manifest's per-set view from the plan + surviving entries
manifest.sets = {};
for (const p of plan) {
  const entry = fileEntries.get(p.dest);
  if (!entry) continue;
  const s = (manifest.sets[p.setID] ??= { setName: p.setName, series: seriesBySet.get(p.setID), mode: p.mode, photosSkipped: p.photosSkipped, files: [] });
  s.files.push(entry);
}
manifest.failures = failures;
manifest.noCubeHero = noCubeHero;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));

console.log(`\nfinished: ${done} extracted, ${skipped} already present, ${failed} failed, ${suspects} flagged suspect, ${teamVaries} single-art sets flagged team-varying`);
if (noCubeHero.length) console.log(`unusable (all heroes are raw photos): ${noCubeHero.map((s) => `${s.setID} ${s.setName}`).join("; ")}`);
console.log(`output: ${OUT_DIR} (manifest: index.json)`);
