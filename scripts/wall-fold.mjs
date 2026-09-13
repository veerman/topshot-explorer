// Fold the Early Adopters wall: pull every signature from the hosted
// table (Cloudflare D1, through wrangler), add each collection's moment
// count read from the chain, and write data/early_adopters.json, the
// permanent record that ships with the app. Rows already in the file keep
// their fields; new rows are appended in sequence order. Idempotent: run
// it any time, commit the file, deploy.
//
//   node scripts/wall-fold.mjs [--dry]
//
// Needs wrangler access to the D1 database named in
// deploy/cloudflare/wrangler.jsonc. Moderation happens here: a row you do
// not want in the file is deleted from the table first (or left, and the
// entry removed from the JSON by hand; the fold never resurrects a
// sequence number the file dropped, see DROPPED below).

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = `${ROOT}data/early_adopters.json`;
const CONFIG = `${ROOT}deploy/cloudflare/wrangler.jsonc`;
const REST = "https://rest-mainnet.onflow.org";
const dry = process.argv.includes("--dry");

// Sequence numbers removed from the file on purpose stay out
const DROPPED = new Set((JSON.parse(readFileSync(FILE, "utf8")).dropped || []).map(Number));

function d1(sql) {
  // Through a shell on Windows (npx is a .cmd), so every argument with a
  // space is quoted by hand or the shell splits the SQL into arguments
  const q = (a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const args = ["wrangler", "d1", "execute", "topshot-explorer-lookup", "--remote", "--json", "--config", CONFIG, "--command", sql].map(q);
  const r = spawnSync("npx", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`wrangler: ${r.stderr || r.stdout}`);
  const out = JSON.parse(r.stdout);
  return (out[0] && out[0].results) || [];
}

const COUNT_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(addrs: [Address]): [Int] {
  let out: [Int] = []
  for a in addrs {
    var n = 0
    if let col = getAccount(a).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection) {
      n = col.getIDs().length
    }
    out.append(n)
  }
  return out
}`;

async function momentCounts(addresses) {
  const counts = new Map();
  for (let i = 0; i < addresses.length; i += 25) {
    const batch = addresses.slice(i, i + 25);
    const body = {
      script: Buffer.from(COUNT_SCRIPT).toString("base64"),
      arguments: [Buffer.from(JSON.stringify({ type: "Array", value: batch.map((a) => ({ type: "Address", value: a })) })).toString("base64")]
    };
    try {
      const res = await fetch(`${REST}/v1/scripts?block_height=sealed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status}`);
      const decoded = JSON.parse(Buffer.from(JSON.parse(await res.text()), "base64").toString("utf8"));
      (decoded.value || []).forEach((v, k) => counts.set(batch[k], Number(v.value)));
    } catch (err) {
      console.warn(`moment count failed for a batch of ${batch.length}: ${err.message}`);
    }
  }
  return counts;
}

const list = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const withPrefix = (a) => `0x${String(a).toLowerCase().replace(/^0x/, "")}`;

const file = JSON.parse(readFileSync(FILE, "utf8"));
const byAddress = new Map((file.entries || []).map((e) => [withPrefix(e.address), e]));

const rows = d1("SELECT seq, address, show_name, username, dapper, parents, children, signed_at, block_height, kind FROM wall ORDER BY seq ASC");
console.log(`${rows.length} signatures in the table, ${byAddress.size} already in the file`);

const fresh = rows.filter((r) => !byAddress.has(withPrefix(r.address)) && !DROPPED.has(Number(r.seq)));
const changed = rows.filter((r) => {
  const e = byAddress.get(withPrefix(r.address));
  return e && ((r.show_name ? r.username : null) || null) !== (e.username || null);
});
console.log(`${fresh.length} new, ${changed.length} changed their username choice`);

const counts = await momentCounts([...new Set([...fresh, ...changed].map((r) => withPrefix(r.address)))]);

for (const r of changed) {
  byAddress.get(withPrefix(r.address)).username = r.show_name && r.username ? r.username : null;
}
for (const r of fresh) {
  const address = withPrefix(r.address);
  byAddress.set(address, {
    seq: Number(r.seq),
    address,
    username: r.show_name && r.username ? r.username : null,
    kind: r.kind || (r.dapper ? "dapper" : null),
    linked: [...new Set([...list(r.parents), ...list(r.children)])].map(withPrefix),
    signedAt: r.signed_at,
    block: r.block_height === null ? null : Number(r.block_height),
    moments: counts.has(address) ? counts.get(address) : null
  });
}

const entries = [...byAddress.values()].sort((a, b) => a.seq - b.seq);
const out = { foldedAt: new Date().toISOString(), dropped: [...DROPPED], entries };
if (dry) {
  console.log(JSON.stringify(out, null, 1).slice(0, 2000));
} else {
  writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
  if (fresh.length > 0) d1(`UPDATE wall SET folded = 1 WHERE seq <= ${Math.max(...fresh.map((r) => Number(r.seq)))}`);
  console.log(`wrote ${entries.length} entries to data/early_adopters.json; commit it and deploy`);
}
