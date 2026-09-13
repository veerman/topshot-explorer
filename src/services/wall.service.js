import { useState, useEffect } from "react";
import folded from "../../data/early_adopters.json";

/**
 * The Early Adopters wall as the app reads it: the folded entries that
 * ship in data/early_adopters.json (permanent, committed by the fold
 * script), plus the signatures since the last fold, read live from the
 * host and shown as pending. A host without the route shows the file.
 */

const norm = (a) => { const x = String(a || "").trim().toLowerCase(); return x.startsWith("0x") ? x : `0x${x}`; };

export const foldedEntries = (folded.entries || []).map((e) => ({ ...e, address: norm(e.address), pending: false }));
export const foldedAt = folded.foldedAt || null;
const lastFoldedSeq = foldedEntries.reduce((m, e) => Math.max(m, e.seq || 0), 0);
const foldedByAddress = new Map(foldedEntries.map((e) => [e.address, e]));

/** The folded entry for an address (the permanent marker), or null */
export const foldedEntryOf = (address) => foldedByAddress.get(norm(address)) || null;

let wall = { status: "unknown", pending: [], total: foldedEntries.length, available: true };
const listeners = new Set();
const set = (patch) => { wall = { ...wall, ...patch }; listeners.forEach((fn) => fn(wall)); };

export async function refreshPending() {
  try {
    const res = await fetch(`/wall/pending?after=${lastFoldedSeq}`, { headers: { accept: "application/json" } });
    if (!(res.headers.get("content-type") || "").includes("application/json")) { set({ status: "ready", available: false }); return; }
    if (!res.ok) { set({ status: "ready" }); return; }
    const body = await res.json();
    const pending = (body.entries || []).filter((e) => !foldedByAddress.has(norm(e.address))).map((e) => ({ ...e, address: norm(e.address), pending: true }));
    set({ status: "ready", pending, total: Math.max(body.total || 0, foldedEntries.length + pending.length) });
  } catch {
    set({ status: "ready" });
  }
}

export function useWall() {
  const [w, setW] = useState(wall);
  useEffect(() => {
    listeners.add(setW);
    if (wall.status === "unknown") { set({ status: "loading" }); refreshPending(); }
    return () => listeners.delete(setW);
  }, []);
  return w;
}

/** Every entry, folded first then pending, each with its sequence number */
export const allEntries = (w) => [...foldedEntries, ...w.pending];

const readError = async (res) => { try { return (await res.json()).error || `${res.status}`; } catch { return `${res.status}`; } };

/** Sign (or change the username choice); needs the sign-in cookie */
export async function signTheWall(showName) {
  const res = await fetch("/wall/sign", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ showName: Boolean(showName) })
  });
  if (!res.ok) throw new Error(await readError(res));
  const entry = await res.json();
  await refreshPending();
  return entry;
}

/** The signed-in reader's own entry, or null */
export async function myEntry() {
  try {
    const res = await fetch("/wall/me", { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
