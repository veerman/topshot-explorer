// The record of play metadata edited on chain after the mint.
//
// Since the TopShot contract update of 2026-09-22 an admin can set any
// metadata field of an existing play (updatePlayMetadata, which emits
// PlayMetadataUpdated); the older updatePlayTagline sets the tagline and
// emits nothing. So the only complete way to see an edit is to read every
// play again and compare it with the last copy, which the seed does on
// every run. Each difference is appended to data/chain_edits.json:
//   { "_note", "edits": [ { since, seen, play, field, before, after } ] }
// `since` is the previous seed's time and `seen` this run's: the edit
// happened between the two. `before` or `after` is null when the field was
// absent. Entries are never rewritten; the chain's current value is what
// the app compiles from, and overrides still layer on top of it.
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";
import { readJsonPreservingEol, writeJsonAtomic } from "./json-file.mjs";

const EDITS_PATH = path.join(ROOT, "data", "chain_edits.json");
const NOTE = "Play metadata edited on chain after the mint, as seen by `npm run seed` (which re-reads every play and compares it with the previous seed). since/seen bracket when the edit happened; before/after are the raw chain values, null when the field was absent. Append-only.";

/** Every field that differs between two raw play maps, as edit rows */
export function diffPlays(before, after) {
  const rows = [];
  Object.keys(before).map(Number).sort((a, b) => a - b).forEach((id) => {
    const a = before[String(id)] || {};
    const b = after[String(id)];
    if (!b) return;
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach((field) => {
      if (a[field] === b[field]) return;
      rows.push({ play: id, field, before: a[field] ?? null, after: b[field] ?? null });
    });
  });
  return rows;
}

/** Appends edit rows (with since/seen stamps) to data/chain_edits.json */
export function recordChainEdits(rows, since, seen) {
  const { data, eol, trailing } = existsSync(EDITS_PATH)
    ? readJsonPreservingEol(EDITS_PATH)
    : { data: { _note: NOTE, edits: [] }, eol: "\n", trailing: "\n" };
  rows.forEach((r) => data.edits.push({ since, seen, ...r }));
  writeJsonAtomic(EDITS_PATH, data, { space: 2, eol, trailing });
}
