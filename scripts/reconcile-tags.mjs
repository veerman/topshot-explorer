// Reconciles data/additions/plays.json against the app's own tag derivation.
//
// Rule (no approval needed, it is a hard rule): a stored tag that the app
// derives on its own from the play data and teams.json carries no
// information and is stripped. The stored tags array is the external Dapper
// import and gets re-pushed on every import, so this runs on every build
// (prebuild) and can be run by hand at any time. It is idempotent.
//
// Only computable tags are touched (the COMPUTABLE_TAG_NAMES set in
// overrides.service). A stored copy the derivation does NOT produce is a
// disagreement: either our data or Dapper is wrong, and that is a judgment
// call surfaced on the Corrections page, never resolved here. Non-computable
// Dapper tags (Rookie Premiere, MVP Year, ...) are never touched.
//
// The derivation is the app's `getCalculatedPlayTags`, run over plays
// compiled exactly the way the app compiles them (raw on-chain metadata plus
// overrides and additions), so the script and the Corrections page can never
// disagree about what is derivable.
//
// Usage:
//   npm run reconcile                 fetch plays from Flow, strip, write
//   npm run reconcile -- --dry-run    report only, write nothing
//   --raw <file>        use a saved raw snapshot instead of fetching
//   --save-raw <file>   save the fetched raw snapshot for later --raw runs
//   --allow-offline     exit 0 with a warning when the chain fetch fails
//                       (prebuild uses this: leanness must never block a build;
//                       display is unaffected because the derivation wins)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadRawPlays, loadSeedPlaysRaw } from "./lib/raw-plays.mjs";
import { seedEditions } from "./lib/seed-facts.mjs";
import { flag, opt } from "./lib/args.mjs";
import { readJsonPreservingEol, writeJsonAtomic } from "./lib/json-file.mjs";
import {
  applyPlayOverrides,
  compilePlayMetadata,
  attachMintTotals,
  buildTsdIndex,
  buildMintClock,
  buildNameAliases,
  getCalculatedPlayTags,
  standardizePlayKeys,
  refreshOverridesDisabledCache,
  COMPUTABLE_TAG_NAMES
} from "../src/services/overrides.service.js";
import playsOverrides from "../data/overrides/plays.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDITIONS_PATH = path.join(ROOT, "data", "additions", "plays.json");

const dryRun = flag("--dry-run");
const allowOffline = flag("--allow-offline");
const rawPath = opt("--raw");
const saveRawPath = opt("--save-raw");

function reconcile(raw, additions) {
  // Compile exactly like the app: raw + overrides + additions (+ the
  // canonical-name aliases the overrides imply)
  buildNameAliases(raw);
  const plays = attachMintTotals(Object.entries(raw)
    .map(([id, metadata]) => compilePlayMetadata(id, metadata))
    .filter(Boolean), seedEditions());
  const byID = new Map(plays.map((p) => [String(p.playID), p]));
  const tsdIndex = buildTsdIndex(plays);
  const mintClock = buildMintClock(plays);

  const stripped = {};
  const kept = {};
  COMPUTABLE_TAG_NAMES.forEach((t) => { stripped[t] = 0; kept[t] = 0; });
  let entriesChanged = 0;
  let skippedNoPlay = 0;

  Object.entries(additions).forEach(([id, entry]) => {
    if (!Array.isArray(entry.tags) || entry.tags.length === 0) return;
    if (!entry.tags.some((t) => COMPUTABLE_TAG_NAMES.has(t))) return;
    const play = byID.get(id);
    if (!play) {
      // No play data to derive from: leave the entry alone
      skippedNoPlay++;
      return;
    }
    // Derive from a clean seed so the stored tags cannot mask the data
    const derived = new Set(getCalculatedPlayTags({ ...play, tags: [] }, null, tsdIndex, mintClock));
    const next = entry.tags.filter((t) => {
      if (!COMPUTABLE_TAG_NAMES.has(t)) return true;
      if (derived.has(t)) { stripped[t]++; return false; }
      kept[t]++;
      return true;
    });
    if (next.length !== entry.tags.length) {
      entriesChanged++;
      if (next.length === 0) delete entry.tags;
      else entry.tags = next;
    }
  });

  return { plays: plays.length, entriesChanged, stripped, kept, skippedNoPlay };
}

/*
 * Unused-override report (idea ported from the retired validator project):
 * compile every play twice, with and without the overrides layer, and flag
 * any override field where both compiles agree ("unnecessary": the raw data
 * or a normalizer already produces the value) or where the final value is
 * not what the override asked for ("ineffective"). Report-only: overrides
 * are hand-verified facts, so deleting them stays a human decision.
 */
function reportUnusedOverrides(raw) {
  // The overrides-disabled flag is read from localStorage, which Node lacks;
  // shim it so the same app code runs both passes.
  let disabled = "false";
  globalThis.localStorage = { getItem: (k) => (k === "disable_overrides" ? disabled : null) };
  buildNameAliases(raw);

  const compileAll = () => {
    const map = new Map();
    Object.entries(raw).forEach(([id, metadata]) => {
      const p = compilePlayMetadata(id, metadata);
      if (p) map.set(String(p.playID), p);
    });
    return map;
  };

  refreshOverridesDisabledCache();
  const withOv = compileAll();
  disabled = "true";
  refreshOverridesDisabledCache();
  const withoutOv = compileAll();
  disabled = "false";
  refreshOverridesDisabledCache();

  const rows = [];
  Object.entries(playsOverrides).forEach(([id, entry]) => {
    const a = withOv.get(id);
    const b = withoutOv.get(id);
    if (!a || !b) {
      rows.push({ id, field: "*", reason: "play not on chain", value: "" });
      return;
    }
    Object.entries(standardizePlayKeys(entry)).forEach(([field, val]) => {
      const withStr = String(a[field] ?? "").trim();
      const withoutStr = String(b[field] ?? "").trim();
      const valStr = String(val ?? "").trim();
      // What the override asks for once normalized like any other value (a
      // DateOfMoment override is written in the chain's UTC form and
      // compiles to the Eastern form, which is not a failure)
      const askedStr = String((applyPlayOverrides({ playID: Number(id), [field]: val }) || {})[field] ?? "").trim();
      if (withStr === withoutStr) {
        rows.push({ id, field, reason: "unnecessary: raw or normalizer already yields this", value: valStr });
      } else if (withStr !== valStr && withStr !== askedStr) {
        rows.push({ id, field, reason: `ineffective: final value is "${withStr}"`, value: valStr });
      }
    });
  });
  return rows;
}

async function main() {
  // Preserve the file's line-ending and trailing-newline style
  const { data: additions, eol, trailing } = readJsonPreservingEol(ADDITIONS_PATH);
  const additionsCount = Object.keys(additions).length;

  // The seed's playsRaw answers for existing plays (immutable once
  // minted), so a prebuild run only fetches ids minted since the seed
  const previousRaw = loadSeedPlaysRaw();

  let raw;
  try {
    raw = await loadRawPlays({ rawPath, saveRawPath, previousRaw });
  } catch (err) {
    const msg = `reconcile-tags: could not load play data (${err.message})`;
    if (allowOffline) {
      console.warn(`WARNING ${msg}; additions left as-is (display is unaffected: the derivation is authoritative)`);
      return;
    }
    throw new Error(msg, { cause: err });
  }

  // Integrity guard: never strip on the basis of a partial dataset
  const rawCount = Object.keys(raw).length;
  if (rawCount < additionsCount * 0.95) {
    throw new Error(`reconcile-tags: only ${rawCount} plays loaded for ${additionsCount} additions entries; refusing to reconcile on partial data`);
  }

  // Overrides leanness (report-only, never writes)
  const unused = reportUnusedOverrides(raw);
  if (unused.length > 0) {
    console.log(`Override leanness: ${unused.length} override field(s) look unnecessary or ineffective:`);
    unused.slice(0, 25).forEach((r) => console.log(`  #${r.id} ${r.field}: ${r.reason}${r.value ? ` (override: "${r.value}")` : ""}`));
    if (unused.length > 25) console.log(`  ... and ${unused.length - 25} more`);
    console.log("  (report only; deleting overrides is a human decision)");
  } else {
    console.log("Override leanness: every override in data/overrides/plays.json changes its play. Lean.");
  }

  const result = reconcile(raw, additions);
  const totalStripped = Object.values(result.stripped).reduce((a, b) => a + b, 0);
  const totalKept = Object.values(result.kept).reduce((a, b) => a + b, 0);

  console.log(`Compiled ${result.plays} plays; ${additionsCount} additions entries.`);
  COMPUTABLE_TAG_NAMES.forEach((t) => {
    console.log(`  ${t.padEnd(18)} stripped ${String(result.stripped[t]).padStart(5)} (derived too)   kept ${String(result.kept[t]).padStart(4)} (disagreement, needs judgment)`);
  });
  if (result.skippedNoPlay) console.log(`  ${result.skippedNoPlay} entries had no play data and were left untouched`);

  if (totalStripped === 0) {
    console.log("Nothing to strip: additions are already lean.");
    return;
  }
  if (dryRun) {
    console.log(`Dry run: ${totalStripped} tags across ${result.entriesChanged} entries would be stripped; ${totalKept} disagreements kept.`);
    return;
  }
  writeJsonAtomic(ADDITIONS_PATH, additions, { space: 2, eol, trailing });
  console.log(`Stripped ${totalStripped} tags across ${result.entriesChanged} entries; ${totalKept} disagreements kept for review. Wrote ${path.relative(ROOT, ADDITIONS_PATH)}.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
