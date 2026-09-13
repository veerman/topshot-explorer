// Throw away every Early Adopters signature and start the numbering at
// #1 again: for testing before the real launch. Empties the hosted table
// (Cloudflare D1, through wrangler) and, with --file, the shipped
// data/early_adopters.json too. Nothing else holds a signature: the
// sign-in itself stores no signatures anywhere (a signature is checked
// once and becomes a cookie).
//
//   node scripts/wall-reset.mjs --yes [--file]

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = `${ROOT}data/early_adopters.json`;
const CONFIG = `${ROOT}deploy/cloudflare/wrangler.jsonc`;

if (!process.argv.includes("--yes")) {
  console.log("This deletes every signature on the hosted wall. Run again with --yes (add --file to also empty data/early_adopters.json).");
  process.exit(1);
}

function d1(sql) {
  const q = (a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const args = ["wrangler", "d1", "execute", "topshot-explorer-lookup", "--remote", "--json", "--config", CONFIG, "--command", sql].map(q);
  const r = spawnSync("npx", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`wrangler: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

const before = d1("SELECT COUNT(*) AS n FROM wall")[0].results[0].n;
d1("DELETE FROM wall");
d1("DELETE FROM sqlite_sequence WHERE name = 'wall'");
console.log(`hosted wall emptied (${before} signatures removed); the next signature is #1`);

if (process.argv.includes("--file")) {
  const file = JSON.parse(readFileSync(FILE, "utf8"));
  const n = (file.entries || []).length;
  writeFileSync(FILE, JSON.stringify({ foldedAt: null, dropped: [], entries: [] }, null, 1) + "\n");
  console.log(`data/early_adopters.json emptied (${n} entries); deploy to publish the empty wall`);
} else if ((JSON.parse(readFileSync(FILE, "utf8")).entries || []).length > 0) {
  console.log("note: data/early_adopters.json still holds folded entries; add --file to empty it too");
}
