// Lock states for an account's moments (TopShotLocking registry), shared
// by the account page (whole collection) and the set page (this set's
// moments only).
//
// Lock states drift slowly, and the expiry timestamps are absolute, so a
// cached lock still flips from locked to unlockable on its own; the whole
// collection's map persists in the account_collections store under
// "<address>:locks" for a day, with an in-memory copy per session. A page
// reload on the account page always refetches (force).
import { getLockData } from "./fcl.service";
import { getAccountCollectionDB, saveAccountCollectionDB } from "./db.service";
import { normalizeAddress } from "./account.context";

// Lock state buckets: locked (expiry in the future), unlockable (expiry
// passed but not unlocked yet), unlocked (no lock at all)
export const lockStateOf = (expirySeconds) => {
  if (expirySeconds == null) return "unlocked";
  return expirySeconds * 1000 > Date.now() ? "locked" : "unlockable";
};

const sessionLockCache = new Map();
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const lockRecordKey = (address) => `${normalizeAddress(address)}:locks`;

export function clearLockCache(address) {
  sessionLockCache.delete(normalizeAddress(address));
}

/**
 * momentID -> lock expiry (seconds) for the LOCKED moments among
 * momentIDs; unlocked ids are absent. Serves the account's cached
 * whole-collection map when one is fresh (it covers any subset), else asks
 * the chain for exactly momentIDs. `persist` (the account page, which
 * passes the whole collection) stores the answer as that cached map; a
 * subset caller must leave it false. Returns null when shouldAbort fires.
 */
export async function loadAccountLocks(address, momentIDs, { force = false, persist = true, shouldAbort = null } = {}) {
  const key = normalizeAddress(address);
  if (!force) {
    const cached = sessionLockCache.get(key);
    if (cached) {
      await Promise.resolve(); // settle like the fetch path, never mid-render
      return cached;
    }
    // A fresh-enough persisted copy skips the chain scan entirely
    try {
      const rec = await getAccountCollectionDB(lockRecordKey(address));
      if (rec && Date.now() - (rec.fetchedAt || 0) < LOCK_TTL_MS) {
        const map = new Map(rec.locks || []);
        sessionLockCache.set(key, map);
        return map;
      }
    } catch { /* fall through to the chain */ }
  }
  // The locking registry answers by token id (no collection borrow), so
  // batches of 10,000 work: a 61K collection is 7 calls
  const rows = [];
  for (let i = 0; i < momentIDs.length; i += 10000) {
    if (shouldAbort && shouldAbort()) return null;
    rows.push(...await getLockData(momentIDs.slice(i, i + 10000)));
  }
  const map = new Map(rows);
  if (persist) {
    sessionLockCache.set(key, map);
    try { await saveAccountCollectionDB({ address: lockRecordKey(address), fetchedAt: Date.now(), locks: rows }); } catch { /* cache is best-effort */ }
  }
  return map;
}
