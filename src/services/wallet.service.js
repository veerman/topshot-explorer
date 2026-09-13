import * as fcl from "@onflow/fcl";
import { useState, useEffect } from "react";
import { resetLookups } from "./usernames.service";
import { getAccountContext, setAccountAddress, clearAccountAddress } from "./account.context";

/**
 * Wallet sign-in. A wallet (Flow Wallet, Dapper Wallet, any FCL
 * wallet) signs one short message; the host checks it on chain and sets a
 * session cookie; from then on the username lookup answers (see
 * deploy/cloudflare/auth.js for the host side). Nothing is stored about
 * the person beyond the address in the cookie, and no transaction is ever
 * sent. The session is what the cookie says, asked once per page load.
 */

// Dapper Wallet is an opt-in entry in FCL discovery, listed by its id
const DAPPER_WALLET_ID = "0xead892083b3e2c6c";
// Hidden from the wallet picker: Blocto is dead, and
// NuFi (a Cardano-first extension and hardware wallet) is not where Top
// Shot collectors keep anything. Discovery shows both on desktop only;
// mobile already lists just Flow Wallet and Dapper Wallet.
const HIDDEN_WALLET_IDS = ["0x55ad22f01ef568a1", "0x95b85a9ef4daabb1"];
let configured = false;
function configureWallet() {
  if (configured) return;
  configured = true;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  fcl.config({
    "flow.network": "mainnet",
    "discovery.wallet": "https://fcl-discovery.onflow.org/authn",
    "discovery.authn.endpoint": "https://fcl-discovery.onflow.org/api/authn",
    "discovery.authn.include": [DAPPER_WALLET_ID],
    "discovery.authn.exclude": HIDDEN_WALLET_IDS,
    "app.detail.title": "Top Shot Explorer",
    "app.detail.icon": `${origin}/favicon.svg`,
    "app.detail.url": origin
  });
}

// ---- session store ---------------------------------------------------------
let session = { status: "unknown", address: null, error: null, busy: false, wallet: null, challenge: null };
const listeners = new Set();
const set = (patch) => {
  session = { ...session, ...patch };
  listeners.forEach((fn) => fn(session));
};
let asked = null;

/** What a wallet told FCL about itself, kept on the session */
function walletFacts(user) {
  const address = String(user.addr).toLowerCase();
  const services = (user.services || []);
  const provider = services.map((s) => s.provider).find(Boolean) || {};
  return { address, name: provider.name || null, services: services.map((s) => s.type).filter(Boolean) };
}

/**
 * FCL remembers the connected wallet across page loads; mirror it onto
 * the session, and keep a challenge ready for it so the message can be
 * signed inside one click. Connecting and disconnecting run through here
 * too (connectWallet / signOut).
 */
function watchWallet() {
  configureWallet();
  fcl.currentUser.subscribe((user) => {
    if (user && user.loggedIn && user.addr) {
      const w = walletFacts(user);
      if (session.wallet && session.wallet.address === w.address) return;
      set({ wallet: w, challenge: null });
      if (!isProved({ ...session, wallet: w })) {
        fetchChallenge(w.address).then((ch) => { if (session.wallet && session.wallet.address === w.address) set({ challenge: ch }); }).catch(() => {});
      }
    } else if (session.wallet && !session.busy) {
      set({ wallet: null, challenge: null });
    }
  });
}

/** The cookie proves the connected wallet (its signature was checked) */
export const isProved = (s = session) => s.status === "signed" && Boolean(s.wallet) && s.address === s.wallet.address;

/** Ask the host once who the cookie says we are, and FCL which wallet is connected */
export function ensureSession() {
  if (asked) return asked;
  try { watchWallet(); } catch { /* no window */ }
  asked = fetch("/auth/me", { headers: { accept: "application/json" } })
    .then(async (res) => {
      if (res.status === 200) {
        const body = await res.json();
        set({ status: "signed", address: body.address });
      } else if (res.status === 503) {
        set({ status: "unavailable" });
      } else {
        set({ status: "anonymous", address: null });
      }
    })
    .catch(() => set({ status: "anonymous", address: null }));
  return asked;
}

export const getSession = () => session;

/** Subscribe a component; starts the one /auth/me check */
export function useSession() {
  const [s, setS] = useState(session);
  useEffect(() => {
    listeners.add(setS);
    ensureSession();
    return () => listeners.delete(setS);
  }, []);
  return s;
}

const readError = async (res) => {
  try { return (await res.json()).error || `${res.status}`; } catch { return `${res.status}`; }
};

const fetchChallenge = async (address) => {
  const chRes = await fetch(`/auth/challenge?address=${address}`, { headers: { accept: "application/json" } });
  if (!chRes.ok) throw new Error(await readError(chRes));
  return await chRes.json();
};

/**
 * "Sign in", inside a click: connect a wallet (its own popup). The
 * connected wallet becomes the account in view (the address box
 * goes away, the account menu is the wallet). A challenge is fetched so
 * the message can be signed later inside one click: wallets open their
 * signing window as a popup, and a browser only allows a popup during
 * the click that asked for it, so connect and sign are separate clicks.
 */
export async function connectWallet() {
  configureWallet();
  set({ busy: true, error: null, challenge: null });
  try {
    await fcl.unauthenticate();
    const user = await fcl.authenticate();
    if (!user || !user.addr) throw new Error("no wallet connected");
    const w = walletFacts(user);
    set({ wallet: w });
    setAccountAddress(w.address);
    set({ challenge: isProved() ? null : await fetchChallenge(w.address), busy: false });
  } catch (err) {
    set({ busy: false, error: (err && err.message) || String(err) });
    return session;
  }
  // Signed in means usernames: the one signature the host needs
  // is asked for right away. An extension wallet signs in place; a popup
  // wallet may refuse a window this long after the click, in which case
  // the connection stands and the next "sign in" click (Live, Offers,
  // the wall) asks again inside its own click.
  if (session.wallet && !isProved()) await signIn({ quiet: true });
  return session;
}

/**
 * "Sign the message", inside its own click (the Early Adopters page):
 * sign the challenge (the wallet's popup opens at once) and hand the
 * signature to the host, which answers with the cookie. Sets
 * session.error with the wallet's own words on failure.
 */
export async function signIn({ quiet = false } = {}) {
  const wallet = session.wallet;
  let ch = session.challenge;
  if (!wallet) return connectWallet();
  if (isProved()) return session;
  if (!ch) {
    set({ busy: true, error: null });
    try { ch = await fetchChallenge(wallet.address); set({ challenge: ch, busy: false, error: "The sign-in request is ready, click again to sign it." }); }
    catch (err) { set({ busy: false, error: (err && err.message) || String(err) }); }
    return session;
  }
  set({ busy: true, error: null });
  try {
    // Sign first, with no await in front of it, so the popup belongs to
    // this click; a stale challenge (older than eight minutes) is refetched
    // and the reader clicks again
    if (Date.now() - Date.parse(ch.issuedAt) > 8 * 60 * 1000) {
      ch = await fetchChallenge(wallet.address);
      set({ challenge: ch, busy: false, error: "The sign-in request had expired; a new one is ready, click Sign again." });
      return session;
    }
    const signatures = await fcl.currentUser.signUserMessage(ch.messageHex);
    const vRes = await fetch("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ address: ch.address, issuedAt: ch.issuedAt, nonce: ch.nonce, signatures })
    });
    if (!vRes.ok) throw new Error(await readError(vRes));
    const body = await vRes.json();
    set({ status: "signed", address: body.address, busy: false, error: null, challenge: null });
    resetLookups();
  } catch (err) {
    set({ busy: false, error: quiet ? null : (err && err.message) || String(err) });
  }
  return session;
}

/**
 * Where the reader is: "proved" (cookie for the connected wallet),
 * "busy" (a wallet window is open), "connected" (the next click signs
 * the message) or "none" (the next click connects a wallet).
 */
export function stepOf(s = session) {
  if (isProved(s)) return "proved";
  if (s.busy) return "busy";
  if (s.wallet) return "connected";
  return "none";
}

export function dismissSessionError() {
  if (session.error) set({ error: null });
}

/** Disconnect the wallet, drop the cookie, and leave the account view if it was the wallet's */
export async function signOut() {
  const wallet = session.wallet;
  set({ busy: true });
  try { await fetch("/auth/signout", { method: "POST" }); } catch { /* cookie may already be gone */ }
  try { await fcl.unauthenticate(); } catch { /* not connected */ }
  set({ status: "anonymous", address: null, busy: false, error: null, wallet: null, challenge: null });
  resetLookups();
  if (wallet && getAccountContext().address === wallet.address) clearAccountAddress();
}
