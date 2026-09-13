// Atomic JSON file IO for the pipeline's shared files. Every writer of a
// file another script (or a resumed run) reads goes through here: write to
// a temp file, then rename, so a crash or Ctrl-C mid-write can never leave
// a truncated file behind. Same-volume renames are atomic on every
// platform this runs on.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// space: JSON.stringify indent (0 = compact). eol/trailing: preserve a
// hand-edited file's line-ending and trailing-newline style (pair with
// readJsonPreservingEol).
export function writeJsonAtomic(path, value, { space = 0, eol = null, trailing = null } = {}) {
  let text = JSON.stringify(value, null, space || undefined);
  if (eol && eol !== "\n") text = text.replace(/\n/g, eol);
  if (trailing) text += trailing;
  writeFileAtomic(path, text);
}

export function readJsonPreservingEol(path) {
  const source = readFileSync(path, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(source) ? eol : "";
  return { data: JSON.parse(source), eol, trailing };
}
