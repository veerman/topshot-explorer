// The Early Adopters wall: signed-in collectors put their name on the
// almanac once, in the order they arrive. A signature is a row here
// (D1 in the Worker, a local SQLite file in dev, same shape); the fold
// script (scripts/wall-fold.mjs) turns rows into data/early_adopters.json,
// which ships with the app and is the permanent record. Until a row is
// folded the page shows it as pending, read live from /wall/pending.
//
// Who may sign: a Dapper wallet, or a wallet that is the confirmed
// parent of one (graph.js wallKindOf decides from the chain). The row
// records the address (proved by the sign-in cookie), which of the two it
// was ("dapper" or "parent"), the choice to show the username, the
// username the lookup table knew (a parent's is its Dapper child's), the
// linked addresses (a Dapper wallet's parents, a parent's Dapper
// children), the sealed block and the time. Nothing free-form.
//
// `db` is D1-shaped: db.prepare(sql).bind(...args).first() / .all() /
// .run(); the dev server wraps node:sqlite to the same shape.

export const WALL_SCHEMA = `CREATE TABLE IF NOT EXISTS wall (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  show_name INTEGER NOT NULL DEFAULT 1,
  username TEXT,
  dapper INTEGER,
  parents TEXT,
  children TEXT,
  signed_at TEXT NOT NULL,
  block_height INTEGER,
  folded INTEGER NOT NULL DEFAULT 0,
  kind TEXT
)`;

const bare = (a) => String(a || "").toLowerCase().replace(/^0x/, "");
const withPrefix = (a) => `0x${bare(a)}`;
const parseList = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(bare).filter(Boolean) : []; } catch { return []; } };

/** A row as the page sees it: the username only when the signer chose it */
export function publicEntry(row) {
  return {
    seq: Number(row.seq),
    address: withPrefix(row.address),
    username: row.show_name && row.username ? row.username : null,
    kind: row.kind || (row.dapper ? "dapper" : null),
    linked: [...new Set([...parseList(row.parents), ...parseList(row.children)])].map(withPrefix),
    signedAt: row.signed_at,
    block: row.block_height === null || row.block_height === undefined ? null : Number(row.block_height)
  };
}

const own = (row) => ({ ...publicEntry(row), showName: Boolean(row.show_name), folded: Boolean(row.folded) });

/**
 * Sign, or re-sign to change the username choice. The sequence number is
 * fixed at first signing. `facts` is what the host established for the
 * address: { kind, username, dapper, parents: [addr], children: [addr] }.
 */
export async function signWall(db, address, showName, facts, blockHeight, now = new Date()) {
  const a = bare(address);
  const existing = await db.prepare("SELECT * FROM wall WHERE address = ?1").bind(a).first();
  const username = (facts && facts.username) || (existing && existing.username) || null;
  if (existing) {
    await db.prepare("UPDATE wall SET show_name = ?2, username = ?3 WHERE address = ?1").bind(a, showName ? 1 : 0, username).run();
  } else {
    await db.prepare(`INSERT INTO wall (address, show_name, username, dapper, parents, children, signed_at, block_height, kind)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(
      a, showName ? 1 : 0, username,
      facts && facts.dapper !== null && facts.dapper !== undefined ? (facts.dapper ? 1 : 0) : null,
      JSON.stringify(((facts && facts.parents) || []).map(bare)), JSON.stringify(((facts && facts.children) || []).map(bare)),
      now.toISOString(), blockHeight, (facts && facts.kind) || null
    ).run();
  }
  return own(await db.prepare("SELECT * FROM wall WHERE address = ?1").bind(a).first());
}

export async function wallEntryFor(db, address) {
  const row = await db.prepare("SELECT * FROM wall WHERE address = ?1").bind(bare(address)).first();
  return row ? own(row) : null;
}

/** Rows newer than the shipped file (seq > after), oldest first, capped */
export async function wallPending(db, after, limit = 500) {
  const r = await db.prepare("SELECT * FROM wall WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2").bind(Number(after) || 0, limit).all();
  const rows = (r && r.results) || [];
  const count = await db.prepare("SELECT COUNT(*) AS n FROM wall").bind().first();
  return { total: Number((count && count.n) || 0), entries: rows.map(publicEntry) };
}
