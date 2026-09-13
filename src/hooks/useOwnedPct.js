import { useEffect, useState } from "react";

/*
 * Shared display preference for owned Mints fractions: false = stacked
 * fraction, true = percentage. One toggle (the small % chip in any Mints
 * column header) flips every Mints cell in the app; persisted so it
 * survives reloads.
 */
const STORAGE_KEY = "topshot_owned_pct";

let pctMode = false;
try { pctMode = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* private mode */ }

const listeners = new Set();

export function toggleOwnedPct() {
  pctMode = !pctMode;
  try { localStorage.setItem(STORAGE_KEY, pctMode ? "1" : "0"); } catch { /* private mode */ }
  listeners.forEach((l) => l(pctMode));
}

export function useOwnedPct() {
  const [value, setValue] = useState(pctMode);
  useEffect(() => {
    const l = (v) => setValue(v);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return value;
}
