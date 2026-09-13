// Retry with linear backoff, the one shape every script's hand-rolled
// variant reduced to. Throws after the last attempt (wrap in try/catch at
// the call site for a return-null policy); `fatal` short-circuits retries
// for errors that will never succeed (e.g. a 404).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetries(fn, label, { attempts = 4, backoffMs = 1500, fatal = null } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (fatal && fatal(err)) break;
      if (attempt < attempts) await wait(backoffMs * attempt);
    }
  }
  throw new Error(`${label}: ${String(lastErr).slice(0, 160)}`, { cause: lastErr });
}
