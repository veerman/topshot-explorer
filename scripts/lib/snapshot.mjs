// Dated local copies of what a run saw, under scratch/snapshots/<YYYY-MM-DD>/
// (gitignored, never shipped). Since play metadata can be edited on chain
// after the mint, and Atlas rewrites its own copy, "what did the chain or
// Atlas say then" can only be answered from a copy kept at the time. A
// second run on the same day replaces that day's copy.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";

export function keepSnapshot(srcPath, name) {
  const dir = path.join(ROOT, "scratch", "snapshots", new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  copyFileSync(srcPath, dest);
  console.log(`Snapshot kept: ${path.relative(ROOT, dest)}`);
  return dest;
}
