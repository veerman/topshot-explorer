import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { getSeriesOverrides, ROOKIE_TAGS } from "../services/overrides.service";
import { subscribeAccountContext, getAccountContext, setAccountAddress, clearAccountAddress, reloadAccount, subscribeRecentAddresses, forgetAddress, toggleLinkedAccount, rememberUsername, usernameOf, evmAddressesOf, isEvmAddress } from "../services/account.context";
import { isAddressLike, lookupUsername } from "../services/username.lookup";
import { NavSearch } from "./NavSearch";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { getOffersMadeBy } from "../services/fcl.service";
import { getAllPlaysDB } from "../services/db.service";
import { clearLockCache } from "../services/account.locks";
import { buildTsdIndex, buildMintClock, getCalculatedPlayTags, isMismintPlay } from "../services/overrides.service";
import { useSession, signOut, connectWallet, stepOf, isProved, dismissSessionError } from "../services/wallet.service";
import { facetParam } from "../utils/query";

// Owning any moment whose play carries one of these counts as a rookie
// moment in the menu stats

// A looked-up Top Shot username on its own line under the wallet facts,
// always in full (a name can run to 40 characters; it wraps before it is
// ever cut off)
function UserName({ address }) {
  const name = usernameOf(address);
  return name ? <span className="nav-username">@{name}</span> : null;
}

export function Navbar() {
  const [searchAddress, setSearchAddress] = useState("");
  // Look up: the bar shows a Look up button;
  // opening it hides the links on desktop and the address box takes the
  // whole bar, with Go, Sign in and Close beside it. Esc or Close puts
  // the links back; so does navigating or landing on an account.
  const [lookupState, setLookupState] = useState({ open: false, path: null });
  const lookupInputRef = useRef(null);
  // Quick search (NavSearch): open for the page it was opened on, like
  // Look up, so the box closes when a result takes the reader somewhere
  const [searchState, setSearchState] = useState({ open: false, path: null });
  // A username being resolved through /lookup/user, or why it was not:
  // { name, status: "loading" | "missing" | "invalid" | "unavailable" | "error", message }
  const [lookup, setLookup] = useState(null);
  const [setsDropdownOpen, setSetsDropdownOpen] = useState(false);
  const [moreDropdownOpen, setMoreDropdownOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // Mobile: the links collapse behind a menu button under 990px
  const [menuOpen, setMenuOpen] = useState(false);
  const syncState = useSyncStatus();
  const [account, setAccount] = useState(getAccountContext);
  // "Sign in" here connects a wallet (Flow Wallet or Dapper Wallet); the
  // connected wallet becomes the account in view, so the address box
  // gives way to the chip and the menu is the wallet's. Signing the
  // message (the proof behind usernames and the wall) happens on the
  // Early Adopters page, never here.
  const session = useSession();
  const wallet = session.wallet ? session.wallet.address : null;
  const walletName = (session.wallet && session.wallet.name) || "wallet";
  const busy = stepOf(session) === "busy";
  // Sign in = connect a wallet; the chip then replaces the corner. A
  // wallet connected while no account is in view (after Exit account) is
  // one click from being the account again
  const signInButton = session.status !== "unavailable" && (
    <button
      type="button"
      className="nav-signin-link"
      onClick={() => { if (wallet) setAccountAddress(wallet); else void connectWallet(); }}
      disabled={busy}
      title={wallet ? `Browse as your ${walletName} (${wallet})` : "Connect Flow Wallet or Dapper Wallet"}
    >
      {wallet ? "✓ Signed in" : busy ? "Waiting for your wallet" : "Sign in"}
    </button>
  );
  // The wallet's own words when connecting fails, under the control, until dismissed
  const sessionError = session.error && (
    <div className="nav-dropdown-menu nav-recent-menu nav-session-error" role="alert">
      <span>{session.error}</span>
      <button type="button" className="nav-session-error-close" onClick={dismissSessionError} aria-label="Dismiss">×</button>
    </div>
  );
  // The collection index (moments/plays/editions/sets) for the quick stats
  const owned = useAccountCollection();
  const location = useLocation();

  useEffect(() => subscribeAccountContext(setAccount), []);

  // Lookup history: previously entered addresses, offered under the input
  // while it has focus and as one-click switches in the account menu
  const [recent, setRecent] = useState([]);
  const [recentOpen, setRecentOpen] = useState(false);
  useEffect(() => subscribeRecentAddresses(setRecent), []);

  // Active offers made by the browsed address: one live chain call (the
  // same enumeration the AccountOffers page runs), started lazily the
  // first time the menu opens and cached per address
  const [offersMade, setOffersMade] = useState(null);
  const offersReqRef = useRef("");
  const ensureOffersCount = (addr) => {
    if (!addr || isEvmAddress(addr) || offersReqRef.current === addr) return;
    offersReqRef.current = addr;
    setOffersMade({ addr, count: undefined });
    getOffersMadeBy(addr)
      .then((rows) => setOffersMade({ addr, count: rows.length }))
      .catch(() => setOffersMade({ addr, count: null }));
  };

  // Tag/tier stats need the plays plus the additions files; loaded once,
  // lazily, the first time the menu opens (dynamic imports keep the
  // additions JSON out of the main bundle)
  const [statsData, setStatsData] = useState(null);
  const statsReqRef = useRef(false);
  const ensureQuickStats = () => {
    if (statsReqRef.current) return;
    statsReqRef.current = true;
    Promise.all([
      getAllPlaysDB(),
      import("../../data/additions/sets.json"),
      import("../../data/additions/editions.json")
    ])
      .then(([plays, setsAdd, edsAdd]) => setStatsData({ plays, setsAdd: setsAdd.default, edsAdd: edsAdd.default }))
      .catch(() => setStatsData({ plays: [], setsAdd: {}, edsAdd: {} }));
  };

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  const copyAddress = () => {
    try {
      navigator.clipboard.writeText(account.address).then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
      }).catch(() => { /* clipboard blocked; the tooltip still has it */ });
    } catch { /* clipboard unavailable */ }
  };

  // Entering an address sets the browsing context in place: no navigation,
  // no refresh; every page annotates itself with that collection. Anything
  // that is not an address is taken as a Top Shot username and resolved
  // through the edge lookup first.
  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const raw = searchAddress.trim();
    if (!raw) return;
    // A Flow address, or an EVM address browsed on its own (what it holds
    // through the bridge; nothing is linked to anything)
    if (isAddressLike(raw) || isEvmAddress(raw)) {
      setAccountAddress(raw);
      setSearchAddress("");
      setRecentOpen(false);
      setLookup(null);
      return;
    }
    const name = raw.replace(/^@/, "");
    setLookup({ name, status: "loading" });
    lookupUsername(name)
      .then((r) => {
        rememberUsername(r.address, r.username, r.fetchedAt);
        setLookup(null);
        setAccountAddress(r.address);
        setSearchAddress("");
        setRecentOpen(false);
      })
      .catch((err) => setLookup({ name, status: err.code || "error", message: err.message }));
  };
  const pickRecent = (addr) => {
    setAccountAddress(addr);
    setSearchAddress("");
    setRecentOpen(false);
    setAccountMenuOpen(false);
  };

  // Linked accounts checked into the context, and the merged moment count
  const included = account.included || [];
  const linkedTotal = included.reduce((sum, a) => sum + ((account.linked && account.linked[a] && account.linked[a].moments) ? account.linked[a].moments.length : 0), 0);
  const accountTitle = account.status === "loading"
    ? `Fetching collection... ${account.progress}%`
    : account.status === "error"
      ? `Could not load this collection: ${account.error}`
      : account.moments
        ? `${account.address}: ${(account.moments.length + linkedTotal).toLocaleString()} moments${included.length > 0 ? ` across ${included.length + 1} linked accounts` : ""}`
        : account.address || "";
  const linkedRows = account.graph
    ? [
        ...account.graph.parents.map((p) => ({ ...p, rel: "Parent" })),
        ...account.graph.children.map((c) => ({ ...c, rel: "Child" }))
      ]
    : [];
  // The connected wallet already listed among the linked accounts needs no
  // row of its own at the top: that row is marked as yours instead
  const walletLinked = Boolean(wallet) && linkedRows.some((a) => a.address === wallet);

  const isActive = (path) => location.pathname === path;
  // Open only for the page it was opened on: navigating closes it
  const lookupOpen = lookupState.open && lookupState.path === location.pathname;
  const setLookupOpen = (open) => setLookupState({ open, path: location.pathname });
  const searchOpen = searchState.open && searchState.path === location.pathname;
  const pathname = location.pathname;
  const openSearch = useCallback(() => setSearchState({ open: true, path: pathname }), [pathname]);
  const closeSearch = useCallback(() => setSearchState({ open: false, path: null }), []);
  useEffect(() => { if (lookupOpen && lookupInputRef.current) lookupInputRef.current.focus(); }, [lookupOpen]);

  // Grace period before a dropdown closes, so brief mouse excursions
  // (the gap under the trigger, diagonal paths to a menu item) don't kill it
  const closeTimerRef = useRef(null);
  // Hover opens a menu only on devices that hover. A phone fires a
  // synthetic mouseenter before the tap's click, so hover-open plus
  // click-toggle used to open and close the menu in one tap.
  const hoverOpens = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(hover: hover)").matches;
  const openSetsDropdown = () => {
    if (!hoverOpens()) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setSetsDropdownOpen(true);
  };
  const scheduleSetsDropdownClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setSetsDropdownOpen(false), 250);
  };
  const moreCloseTimerRef = useRef(null);
  const openMoreDropdown = () => {
    if (!hoverOpens()) return;
    if (moreCloseTimerRef.current) clearTimeout(moreCloseTimerRef.current);
    setMoreDropdownOpen(true);
  };
  const scheduleMoreDropdownClose = () => {
    if (moreCloseTimerRef.current) clearTimeout(moreCloseTimerRef.current);
    moreCloseTimerRef.current = setTimeout(() => setMoreDropdownOpen(false), 250);
  };
  const accountCloseTimerRef = useRef(null);
  const openAccountMenu = () => {
    if (!hoverOpens()) return;
    if (accountCloseTimerRef.current) clearTimeout(accountCloseTimerRef.current);
    setAccountMenuOpen(true);
    ensureOffersCount(account.address);
    ensureQuickStats();
  };
  const scheduleAccountMenuClose = () => {
    if (accountCloseTimerRef.current) clearTimeout(accountCloseTimerRef.current);
    accountCloseTimerRef.current = setTimeout(() => setAccountMenuOpen(false), 250);
  };
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (moreCloseTimerRef.current) clearTimeout(moreCloseTimerRef.current);
      if (accountCloseTimerRef.current) clearTimeout(accountCloseTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Get active series list from centralized overrides & additions mapping
  const seriesItems = Object.entries(getSeriesOverrides()).sort((a, b) => Number(a[0]) - Number(b[0]));

  // Owned-copy counts per badge/tier/parallel for the menu. The tag
  // machinery is WeakMap-cached on the plays array, so after any page has
  // derived tags this is one cheap pass over the owned entries.
  const quickStats = useMemo(() => {
    if (!statsData || !owned || !owned.index) return null;
    const { plays, setsAdd, edsAdd } = statsData;
    let tsd = 0, rookies = 0;
    if (plays.length > 0) {
      const tsdIndex = buildTsdIndex(plays);
      const clock = buildMintClock(plays);
      const playById = new Map(plays.map((p) => [Number(p.playID), p]));
      owned.index.byPlay.forEach((count, playID) => {
        const p = playById.get(Number(playID));
        if (!p || isMismintPlay(p.playID)) return;
        const tags = getCalculatedPlayTags(p, null, tsdIndex, clock);
        if (tags.includes("Top Shot Debut")) tsd += count;
        if (ROOKIE_TAGS.some((t) => tags.includes(t))) rookies += count;
      });
    }
    const tiers = {};
    owned.index.byEdition.forEach((count, key) => {
      const setID = key.split("_")[0];
      const tier = (edsAdd[key] && edsAdd[key].tier) || (setsAdd[setID] && setsAdd[setID].tier);
      if (tier) tiers[tier] = (tiers[tier] || 0) + count;
    });
    let parallels = 0;
    const parallelSubs = new Set();
    owned.index.serials.forEach((list, key) => {
      const sub = Number(key.split("_")[2]);
      if (sub > 0) {
        parallels += list.length;
        parallelSubs.add(sub);
      }
    });
    return { tsd, rookies, tiers, parallels, parallelSubs: [...parallelSubs].sort((a, b) => a - b) };
  }, [statsData, owned]);

  // Menu stat rows, owned copies each; zero rows are hidden.
  // Moments is the whole; the rest are subsets of it
  // and sit indented under it, in this order: Top Shot
  // Debut, Rookies, Legendary, Rare, Parallels. Common and Fandom are
  // not shown. Each row links to the collection page with the matching
  // facet already applied.
  const statRows = [];
  if (owned && owned.index) {
    const base = `/account/${account.address}`;
    const facet = (key, values) => `${base}?${facetParam(key, values)}`;
    const addStat = (label, n, href, sub = true) => { if (n > 0) statRows.push([label, n, href, sub]); };
    addStat("Moments", owned.index.total, base, false);
    if (quickStats) {
      addStat("Top Shot Debut", quickStats.tsd, facet("badge", ["Top Shot Debut"]));
      addStat("Rookies", quickStats.rookies, facet("badge", ROOKIE_TAGS));
      ["Legendary", "Rare"].forEach((t) => addStat(t, quickStats.tiers[t] || 0, facet("tier", [t])));
      addStat("Parallels", quickStats.parallels, facet("sub", quickStats.parallelSubs.map(String)));
    }
  }
  // Offers count rides on the "Offers made" link; zero and errors show
  // no number at all
  const offersCell = offersMade && offersMade.addr === account.address
    ? (offersMade.count === undefined ? "..." : offersMade.count ? offersMade.count.toLocaleString() : null)
    : "...";

  return (
    <nav className="glass-navbar">
      {/* Clicking any link anywhere in the bar (menu, brand, account)
          closes the mobile menu, so no navigation leaves it hanging open */}
      <div
        className="nav-container"
        onClick={(e) => {
          if (menuOpen && e.target.closest && e.target.closest("a")) setMenuOpen(false);
        }}
      >
        {/* Brand */}
        <div className="nav-brand-group">
          <Link to="/" className="nav-brand">
            <span>🏀</span> Top Shot Explorer <span className="brand-badge">V2</span>
          </Link>
          
          {/* Glowing Sync Status: always mounted at a fixed width so the bar
              never reflows when syncing starts or stops; just invisible idle */}
          <div
            className={`nav-sync-indicator${syncState.isSyncing ? " syncing" : ""}`}
            title={syncState.stage}
            style={{ visibility: syncState.isSyncing ? "visible" : "hidden", "--sync-pct": `${syncState.progressPercent || 0}%` }}
          >
            <span className="sync-dot animate-pulse"></span>
            <span className="sync-text">
              {syncState.progressPercent > 0 ? `${syncState.progressPercent}%` : "Syncing..."}
            </span>
          </div>
        </div>

        {/* Mobile menu button (hidden on desktop); the icon is drawn with
            spans so no glyph outside the font subset is needed */}
        <button
          type="button"
          className="nav-menu-btn"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="nav-menu-bar" />
          <span className="nav-menu-bar" />
          <span className="nav-menu-bar" />
        </button>

        {/* Links */}
        <div className={`nav-links${menuOpen ? " open" : ""}${(lookupOpen && !account.address) || searchOpen ? " lookup" : ""}`}>
          <Link
            to="/plays"
            className={`nav-item ${isActive("/plays") ? "active" : ""}`}
          >
            Plays
          </Link>

          {/* Unified Sets Dropdown */}
          <div
            className="nav-dropdown-wrapper"
            onMouseEnter={openSetsDropdown}
            onMouseLeave={scheduleSetsDropdownClose}
          >
            <Link
              to="/sets"
              className={`nav-item ${isActive("/sets") || setsDropdownOpen ? "active" : ""}`}
              onClick={() => setSetsDropdownOpen(false)}
            >
              Sets ▾
            </Link>
            {setsDropdownOpen && (
              <div className="nav-dropdown-menu">
                <div className="dropdown-scroll-container">
                  {seriesItems.map(([seriesId, data]) => (
                    <Link
                      key={seriesId}
                      to={`/sets?series=${seriesId}`}
                      className="dropdown-item"
                      onClick={() => setSetsDropdownOpen(false)}
                    >
                      <span className="dropdown-series-id">S{seriesId}</span>
                      <span className="dropdown-series-name">{data.name}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Link
            to="/players"
            className={`nav-item ${isActive("/players") ? "active" : ""}`}
          >
            Players
          </Link>

          <Link
            to="/teams"
            className={`nav-item ${isActive("/teams") ? "active" : ""}`}
          >
            Teams
          </Link>

          <Link
            to="/seasons"
            className={`nav-item ${isActive("/seasons") ? "active" : ""}`}
          >
            Seasons
          </Link>

          <Link
            to="/arenas"
            className={`nav-item ${isActive("/arenas") ? "active" : ""}`}
          >
            Arenas
          </Link>

          <Link
            to="/calendar"
            className={`nav-item ${isActive("/calendar") ? "active" : ""}`}
          >
            Calendar
          </Link>

          <Link
            to="/live"
            className={`nav-item ${isActive("/live") ? "active" : ""}`}
          >
            Live
          </Link>

          <Link
            to="/offers"
            className={`nav-item ${isActive("/offers") ? "active" : ""}`}
          >
            Offers
          </Link>

          {/* Utility pages live behind one dropdown so browsing pages keep
              their top-level spots (click toggles for touch, hover opens
              on desktop) */}
          <div
            className="nav-dropdown-wrapper"
            onMouseEnter={openMoreDropdown}
            onMouseLeave={scheduleMoreDropdownClose}
          >
            <button
              type="button"
              className={`nav-item nav-more-btn ${isActive("/corrections") || isActive("/settings") || isActive("/about") || moreDropdownOpen ? "active" : ""}`}
              onClick={() => setMoreDropdownOpen((o) => !o)}
            >
              More ▾
            </button>
            {moreDropdownOpen && (
              <div className="nav-dropdown-menu nav-more-menu">
                <div className="dropdown-scroll-container">
                  <Link to="/cube" className="dropdown-item" onClick={() => setMoreDropdownOpen(false)}>Cube Lab</Link>
                  <Link to="/corrections" className="dropdown-item" onClick={() => setMoreDropdownOpen(false)}>Corrections</Link>
                  <Link to="/glossary" className="dropdown-item" onClick={() => setMoreDropdownOpen(false)}>Glossary</Link>
                  <Link to="/settings" className="dropdown-item" onClick={() => setMoreDropdownOpen(false)}>Settings</Link>
                  <Link to="/about" className="dropdown-item" onClick={() => setMoreDropdownOpen(false)}>About</Link>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Quick search: a magnifying glass that opens into a box across
            the bar (the links step aside, as for Look up) */}
        <NavSearch open={searchOpen} onOpen={openSearch} onClose={closeSearch} />

        {/* Account context: an input until an address is set, then one
            compact chip opening a menu (full address, quick stats, links,
            Exit). Not a login (no auth), just the address the app is
            currently browsing as. */}
        {account.address ? (
          <div
            className="nav-search-form nav-dropdown-wrapper nav-account-wrapper"
            onMouseEnter={openAccountMenu}
            onMouseLeave={scheduleAccountMenuClose}
          >
            <button
              type="button"
              className={`nav-account-chip font-mono${accountMenuOpen ? " open" : ""}`}
              title={accountTitle}
              onClick={() => {
                const next = !accountMenuOpen;
                setAccountMenuOpen(next);
                if (next) {
                  ensureOffersCount(account.address);
                  ensureQuickStats();
                }
              }}
            >
              {/* Always the FULL Flow address (they are short enough;
                  never ellipsize one, shrink it). An EVM address is 42
                  characters and is the one kind shortened to its ends. */}
              {wallet === account.address && <span className="nav-account-signed" title={`Your ${walletName}`}>✓</span>}
              {isEvmAddress(account.address) ? `${account.address.slice(0, 8)}…${account.address.slice(-8)}` : account.address}
              {included.length > 0 && <span className="nav-account-plus" title={`${included.length} linked ${included.length === 1 ? "account" : "accounts"} included`}>+{included.length}</span>}
              {account.status === "loading" && <span className="nav-account-progress">{account.progress}%</span>}
              <span className="nav-account-caret">▾</span>
            </button>
            {accountMenuOpen && (
              <div className="nav-dropdown-menu nav-account-menu">
                <div className="dropdown-scroll-container">
                  {/* The connected wallet, beside the address being browsed;
                      none connected offers to connect one. Leaving (and
                      signing out of the wallet) is the Exit account button
                      at the bottom, one control for both cases. */}
                  {/* The wallet is the account in view in the common case, so
                      the address row below says so; only a wallet browsing
                      someone else gets its own row here, and no wallet gets
                      the offer to connect one */}
                  {wallet && wallet !== account.address && !walletLinked ? (
                    <>
                      <div className="nav-session-row" title={isProved(session) ? "Connected, and the message is signed" : "Connected"}>
                        <span className="nav-account-menu-label" style={{ padding: 0 }}>Your {walletName}</span>
                        <span className="font-mono nav-session-addr">{wallet}</span>
                        <UserName address={wallet} />
                      </div>
                      <button type="button" className="dropdown-item nav-account-action" onClick={() => { setAccountMenuOpen(false); setAccountAddress(wallet); }} title="Browse as your wallet again">
                        Browse as your wallet
                      </button>
                      <div className="dropdown-divider" />
                    </>
                  ) : !wallet && session.status !== "unavailable" ? (
                    <>
                      <button type="button" className="dropdown-item nav-account-action" onClick={() => { setAccountMenuOpen(false); void connectWallet(); }} disabled={busy} title="Connect Flow Wallet or Dapper Wallet">
                        {busy ? "Waiting for your wallet" : "Sign in with your wallet"}
                      </button>
                      <div className="dropdown-divider" />
                    </>
                  ) : null}
                  {/* The account in view, once: address, wallet kind, whether
                      it is the connected wallet, its username, and Copy */}
                  <button type="button" className="dropdown-item nav-account-copy font-mono" onClick={copyAddress} title="Copy the address">
                    <span className="nav-account-self">
                      <span className={isEvmAddress(account.address) ? "nav-account-evm-full" : undefined}>{account.address}</span>
                      {account.graph && account.graph.dapper && <span className="nav-account-role" title="A Dapper wallet: Dapper Labs holds the keys">Dapper</span>}
                      {wallet === account.address && <span className="nav-account-role nav-account-role-me" title={isProved(session) ? `Your ${walletName}, connected and signed` : `Your ${walletName}, connected`}>✓ signed in</span>}
                      <UserName address={account.address} />
                    </span>
                    <span className="nav-account-copy-hint">{copied ? "Copied" : "Copy"}</span>
                  </button>
                  {account.status === "loading" && (
                    <div className="nav-account-menu-note">Fetching collection... {account.progress}%</div>
                  )}
                  {account.status === "error" && (
                    <div className="nav-account-menu-note">Could not load this collection: {account.error}</div>
                  )}
                  {/* Account linking (fcl.service getAccountGraph): the
                      account itself first, then its parents and children.
                      A checked linked account's moments merge into the
                      context, so every page counts the group as one
                      collection (a parent can own many children). */}
                  {account.graph && (
                    <div className="nav-account-graph">
                      {linkedRows.length > 0 && (
                        <>
                          <div className="nav-account-menu-label">Linked accounts</div>
                          {linkedRows.map((a) => {
                            const on = included.includes(a.address);
                            const l = account.linked ? account.linked[a.address] : null;
                            // The moment count on its own line, after the username
                            const note = !on || !l ? ""
                              : l.status === "loading" && !l.moments ? "loading..."
                                : l.moments ? `${l.moments.length.toLocaleString()} moments${l.status === "loading" ? " (refreshing)" : ""}`
                                  : l.status === "error" ? "could not load" : "";
                            return (
                              <div key={a.address} className="nav-linked-row">
                                <label className="nav-linked-main" title={on ? "Uncheck to drop this account's moments from the context" : "Check to count this account's moments as yours everywhere in the app"}>
                                  <input type="checkbox" checked={on} onChange={() => toggleLinkedAccount(a.address)} />
                                  <span className="nav-linked-addr font-mono">{a.address}</span>
                                </label>
                                <button type="button" className="nav-linked-swap" title="Browse as this account instead" onClick={() => setAccountAddress(a.address)}>⇄</button>
                                <Link to={`/account/${a.address}`} className="nav-linked-open" title="Open this account's own collection page" onClick={() => setAccountMenuOpen(false)}>→</Link>
                                <span className="nav-linked-role">{a.rel}{a.dapper ? " · Dapper" : ""}{a.address === wallet ? " · ✓ your wallet" : ""}</span>
                                <UserName address={a.address} />
                                {note && <span className="nav-linked-role">{note}</span>}
                              </div>
                            );
                          })}
                        </>
                      )}
                      {/* One row per Cadence-owned EVM account, shortened to
                          its ends (the full one is in the hover); the arrow
                          opens the collection filtered to what is held on EVM */}
                      {evmAddressesOf(account.graph).map((evm) => (
                        <div key={evm} className="nav-account-graph-evm">
                          <span className="nav-account-menu-label" style={{ padding: 0 }}>EVM</span>
                          <span className="nav-account-evm-hex font-mono" title={`${evm}: this account's own EVM address; moments held there are part of the collection, marked EVM`}>
                            {`${evm.slice(0, 8)}…${evm.slice(-8)}`}
                          </span>
                          <Link to={`/account/${account.address}?held=evm`} className="nav-linked-open" title="Open the collection, only the moments held on EVM" onClick={() => setAccountMenuOpen(false)}>→</Link>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="dropdown-divider" />
                  <Link to={`/account/${account.address}`} className="dropdown-item" onClick={() => setAccountMenuOpen(false)}>Collection</Link>
                  {!isEvmAddress(account.address) && <>
                  <Link
                    to={`/account/${account.address}/offers`}
                    className="dropdown-item nav-account-offers-link"
                    title="Marketplace offers this address has open right now"
                    onClick={() => setAccountMenuOpen(false)}
                  >
                    <span>Offers made</span>
                    {offersCell !== null && <span className="font-mono nav-account-offers-count">{offersCell}</span>}
                  </Link>
                  <Link
                    to={`/account/${account.address}?listed=yes`}
                    className="dropdown-item"
                    title="The collection filtered to moments listed for sale"
                    onClick={() => setAccountMenuOpen(false)}
                  >
                    Listings
                  </Link>
                  </>}
                  {statRows.length > 0 && (
                    <>
                      <div className="dropdown-divider" />
                      <div className="nav-account-stats">
                        {statRows.map(([label, n, href, sub]) => (
                          <Link key={label} to={href} className={sub ? "nav-account-stat nav-account-stat-sub" : "nav-account-stat"} title={`Open the collection filtered to ${label.toLowerCase()}`} onClick={() => setAccountMenuOpen(false)}>
                            <span className="text-muted">{label}</span>
                            <span className="font-mono">{n.toLocaleString()}</span>
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="dropdown-divider" />
                  <button
                    type="button"
                    className="dropdown-item nav-account-action"
                    onClick={() => { setAccountMenuOpen(false); clearLockCache(account.address); reloadAccount(); }}
                    disabled={account.status === "loading"}
                    title="Refetch this collection from the chain: new moments, listings and lock states"
                  >
                    {account.status === "loading" ? "Reloading..." : "Reload collection"}
                  </button>
                  <div className="dropdown-divider" />
                  {/* One exit for both ways in: a pasted address just
                      leaves; a connected wallet is signed out of as well */}
                  <button
                    type="button"
                    className="dropdown-item nav-account-exit"
                    onClick={() => { setAccountMenuOpen(false); clearAccountAddress(); if (wallet) void signOut(); }}
                    disabled={session.busy}
                    title={wallet ? `Sign out of your ${walletName} and leave this account` : "Stop browsing as this account"}
                  >
                    Exit account
                  </button>
                </div>
              </div>
            )}
            {sessionError}
          </div>
        ) : !lookupOpen ? (
          <div className="nav-search-form nav-dropdown-wrapper nav-tools">
            <button type="button" className="nav-lookup-btn" onClick={() => setLookupOpen(true)} title="Look up an address or a Top Shot username">
              Look up
            </button>
            {signInButton}
            {sessionError}
          </div>
        ) : (
          <form
            onSubmit={handleSearchSubmit}
            className="nav-search-form nav-dropdown-wrapper nav-lookup-open"
            // The history opens for the address box alone (the buttons
            // share this form and must not raise it). Blur is watched in
            // the capture phase, since it does not bubble, so tabbing from
            // the box to a history row keeps the list open.
            onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setRecentOpen(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setLookupOpen(false); } }}
          >
            <input
              ref={lookupInputRef}
              type="text"
              placeholder="0xAddress or Top Shot username"
              className="form-control nav-search-input"
              onFocus={() => setRecentOpen(true)}
              value={searchAddress}
              onChange={(e) => { setSearchAddress(e.target.value); if (lookup && lookup.status !== "loading") setLookup(null); }}
              autoComplete="off"
            />
            <button type="submit" className="btn-primary nav-search-btn">
              Go
            </button>
            {signInButton}
            <button type="button" className="nav-lookup-close" onClick={() => setLookupOpen(false)} aria-label="Close" title="Close (Esc)">×</button>
            {sessionError}
            {/* Lookup history under the input: click to browse as one again,
                x to forget it. Blur inside the form (tabbing to a row) keeps
                the list open; the list itself is focusable so a click on it
                never counts as leaving. */}
            {lookup && (
              <div className="nav-dropdown-menu nav-recent-menu" tabIndex={-1} role="status">
                <div className="nav-account-menu-note" style={{ paddingTop: "8px" }}>
                  {lookup.status === "loading" ? `Looking up @${lookup.name}...` : lookup.message}
                </div>
              </div>
            )}
            {!lookup && recentOpen && recent.length > 0 && (
              <div className="nav-dropdown-menu nav-recent-menu" tabIndex={-1}>
                <div className="dropdown-scroll-container">
                  <div className="nav-account-menu-label">Recent</div>
                  {recent.map((addr) => (
                    <div key={addr} className="nav-recent-row">
                      <button
                        type="button"
                        className="dropdown-item nav-account-action nav-recent-item font-mono"
                        onClick={() => pickRecent(addr)}
                        title="Browse as this address"
                      >
                        {addr}
                        <UserName address={addr} />
                      </button>
                      <button
                        type="button"
                        className="nav-recent-forget"
                        onClick={() => forgetAddress(addr)}
                        title="Forget this address"
                        aria-label={`Forget ${addr}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </form>
        )}
      </div>

      <style>{`
        .glass-navbar {
          background: rgba(10, 11, 16, 0.85);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          position: sticky;
          top: 0;
          z-index: 1000;
          padding: 14px 24px;
          margin-bottom: 30px;
        }
        .nav-container {
          max-width: 1250px;
          margin: 0 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          /* Single row on desktop no matter what appears or disappears;
             the search input compresses instead of the bar reflowing */
          flex-wrap: nowrap;
          gap: 12px;
        }
        .nav-brand-group {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-shrink: 0;
        }
        .nav-brand {
          font-size: 1.3rem;
          font-weight: 700;
          color: #fff;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .brand-badge {
          background: linear-gradient(135deg, var(--primary) 0%, var(--accent-nba) 100%);
          font-size: 0.65rem;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 700;
        }
        .nav-sync-indicator {
          background: rgba(139, 92, 246, 0.12);
          border: 1px solid rgba(139, 92, 246, 0.3);
          border-radius: 9999px;
          padding: 3px 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 0.75rem;
          color: var(--primary-hover);
          font-weight: 600;
          /* Wide enough for "Syncing..." and "100%" alike, so the pill's
             width never changes as progress text updates */
          min-width: 92px;
        }
        .sync-dot {
          width: 6px;
          height: 6px;
          background-color: var(--primary-hover);
          border-radius: 50%;
          box-shadow: 0 0 8px var(--primary-glow);
        }
        .animate-pulse {
          animation: pulse 1.5s infinite ease-in-out;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .nav-links {
          display: flex;
          align-items: center;
          /* 14, not 24: ten links, the search icon and the account chip
             have to share a 1250px bar */
          gap: 14px;
          flex-shrink: 0;
        }
        .nav-menu-btn {
          display: none;
          flex-direction: column;
          justify-content: center;
          gap: 5px;
          width: 40px;
          height: 36px;
          padding: 8px 9px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          cursor: pointer;
        }
        .nav-menu-bar {
          display: block;
          height: 2px;
          width: 100%;
          background: #fff;
          border-radius: 1px;
        }
        .nav-item {
          color: var(--text-muted);
          font-weight: 500;
          font-size: 0.95rem;
          cursor: pointer;
          transition: var(--transition-smooth);
          padding: 6px 0;
          position: relative;
        }
        .nav-item:hover, .nav-item.active {
          color: #fff;
        }
        .nav-item::after {
          content: '';
          position: absolute;
          bottom: 0;
          left: 0;
          width: 0;
          height: 2px;
          background: var(--primary);
          transition: var(--transition-smooth);
        }
        .nav-item:hover::after, .nav-item.active::after {
          width: 100%;
        }
        .nav-dropdown-wrapper {
          position: relative;
        }
        /* The More trigger is a button (no landing page), restyled to
           match the link items exactly */
        .nav-more-btn {
          background: none;
          border: none;
          font: inherit;
          font-weight: 500;
          font-size: 0.95rem;
          padding: 6px 0;
        }
        .nav-more-menu {
          width: 150px;
        }
        /* Invisible hover bridge spanning the 8px offset between the trigger
           and the menu, so crossing the gap never counts as leaving */
        .nav-dropdown-menu::before {
          content: '';
          position: absolute;
          top: -10px;
          left: -10px;
          right: -10px;
          height: 12px;
        }
        .nav-dropdown-menu {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(18, 20, 30, 0.95);
          backdrop-filter: blur(25px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.5);
          width: 250px;
          margin-top: 8px;
          z-index: 1010;
          animation: fadeIn 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translate(-50%, 5px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        .dropdown-scroll-container {
          /* Scrolls only when the viewport is shorter than the menu */
          max-height: calc(100vh - 90px);
          overflow-y: auto;
          padding: 8px;
        }
        .dropdown-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: 6px;
          font-size: 0.85rem;
          color: var(--text-main);
          transition: var(--transition-smooth);
        }
        .dropdown-item:hover {
          background: rgba(139, 92, 246, 0.12);
          color: #fff;
        }
        .dropdown-view-all {
          font-weight: 600;
          color: var(--primary-hover);
        }
        .dropdown-divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.08);
          margin: 6px 0;
        }
        .dropdown-series-id {
          font-family: var(--font-mono);
          color: var(--primary-hover);
          font-weight: 700;
          background: rgba(139, 92, 246, 0.1);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.75rem;
        }
        .dropdown-series-name {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .nav-search-form {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .nav-search-input {
          padding: 6px 12px;
          font-size: 0.85rem;
          width: 220px;
          min-width: 0;
          flex: 1 1 auto;
        }
        .nav-search-btn {
          padding: 6px 12px;
          font-size: 0.85rem;
        }
        .nav-lookup-btn {
          padding: 6px 12px;
          font: inherit;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--text-main);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          white-space: nowrap;
          cursor: pointer;
        }
        .nav-lookup-btn:hover {
          border-color: var(--primary);
        }
        /* Look up open (desktop): the links step aside and the box takes
           the bar; the history under it stays a readable width. The mobile
           column below shows the links regardless (.nav-links.open wins). */
        .nav-links.lookup {
          display: none;
        }
        .nav-lookup-open {
          flex: 1 1 auto;
        }
        .nav-lookup-open .nav-search-input {
          width: auto;
          flex: 1 1 auto;
        }
        .nav-lookup-open .nav-recent-menu {
          width: min(100%, 460px);
        }
        /* Quick search: the icon matches the Look up button; open, the
           box takes the bar and the matches list under it */
        .nav-search-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          min-width: 0;
        }
        .nav-search-wrap.open {
          flex: 1 1 auto;
        }
        .nav-search-wrap.open .nav-search-input {
          width: auto;
          flex: 1 1 auto;
        }
        .nav-search-open-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 32px;
          padding: 0;
          color: var(--text-main);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          cursor: pointer;
        }
        .nav-search-open-btn:hover {
          border-color: var(--primary);
        }
        .nav-search-menu {
          width: min(100%, 520px);
          padding: 6px;
        }
        .nav-search-result {
          width: 100%;
          padding: 8px 10px;
          font: inherit;
          font-size: 0.85rem;
          text-align: left;
          background: none;
          border: none;
          cursor: pointer;
        }
        /* The highlighted match carries a box and a mark, never colour alone */
        .nav-search-result.is-active {
          background: rgba(139, 92, 246, 0.12);
          color: #fff;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
        }
        .nav-search-kind {
          flex: 0 0 auto;
          min-width: 52px;
          font-size: 0.68rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .nav-search-name {
          flex: 0 1 auto;
          min-width: 0;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .nav-search-detail {
          flex: 1 1 auto;
          min-width: 0;
          text-align: right;
          font-size: 0.78rem;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .nav-lookup-close {
          width: 32px;
          height: 32px;
          padding: 0;
          font-size: 1.2rem;
          line-height: 1;
          color: var(--text-muted);
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          cursor: pointer;
        }
        .nav-lookup-close:hover {
          color: #fff;
          border-color: var(--primary);
        }
        .nav-account-chip {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 6px 12px;
          font-size: 0.85rem;
          font-weight: 600;
          color: #fff;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          cursor: pointer;
          white-space: nowrap;
          transition: var(--transition-smooth);
        }
        .nav-account-chip:hover, .nav-account-chip.open {
          border-color: var(--primary);
          background: rgba(139, 92, 246, 0.1);
        }
        .nav-account-progress {
          color: var(--text-muted);
          font-size: 0.75rem;
        }
        .nav-account-signed {
          color: #fff;
          font-weight: 700;
        }
        .nav-signin-link {
          padding: 6px 10px;
          font: inherit;
          font-size: 0.85rem;
          color: var(--text-main);
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          white-space: nowrap;
          cursor: pointer;
        }
        .nav-signin-link:hover:not(:disabled) {
          border-color: var(--primary);
        }
        .nav-signin-link:disabled {
          cursor: default;
          color: var(--text-muted);
        }
        .nav-session-error {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          font-size: 0.85rem;
          color: #fff;
        }
        .nav-session-error span { flex: 1; overflow-wrap: anywhere; }
        .nav-session-error-close {
          background: transparent;
          border: 0;
          color: var(--text-muted);
          font-size: 1.1rem;
          line-height: 1;
          cursor: pointer;
          padding: 0 2px;
        }
        .nav-session-error-close:hover { color: #fff; }
        .nav-session-row {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px 16px 4px;
          font-size: 0.85rem;
        }
        .nav-session-addr {
          color: #fff;
        }
        .nav-account-caret {
          color: var(--text-muted);
          font-size: 0.7rem;
        }
        /* The account menu hangs off the right edge of the bar, so it
           anchors right instead of centering like the nav dropdowns */
        .nav-account-menu {
          left: auto;
          right: 0;
          transform: none;
          width: 290px;
          animation: fadeInDown 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .nav-account-copy {
          width: 100%;
          background: none;
          border: none;
          justify-content: space-between;
          font-size: 0.85rem;
          color: #fff;
          cursor: pointer;
        }
        /* Menu actions rendered as buttons: no browser button chrome, the
           item's own colours */
        .nav-account-action {
          width: 100%;
          background: none;
          border: none;
          cursor: pointer;
          color: var(--text-main);
          font: inherit;
          font-size: 0.85rem;
          text-align: left;
        }
        .nav-account-action:disabled {
          color: var(--text-muted);
          cursor: default;
        }
        /* Lookup history: under the input (anchored to its left edge, the
           input's width) and as a Recent block in the account menu */
        .nav-recent-menu {
          left: 0;
          right: auto;
          transform: none;
          width: 100%;
          min-width: 250px;
          animation: fadeInDown 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .nav-account-menu-label {
          padding: 6px 14px 2px;
          font-size: 0.68rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .nav-recent-row {
          display: flex;
          align-items: center;
          gap: 2px;
        }
        .nav-recent-item {
          display: block;
          flex: 1;
          min-width: 0;
          font-size: 0.8rem;
          color: #fff;
        }
        .nav-recent-item .nav-username {
          font-size: 0.72rem;
          font-family: var(--font-sans);
        }
        .nav-recent-forget {
          flex: none;
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 6px;
          background: none;
          color: var(--text-muted);
          font-size: 1rem;
          line-height: 1;
          cursor: pointer;
        }
        .nav-recent-forget:hover {
          background: rgba(239, 68, 68, 0.12);
          color: #f87171;
        }
        .nav-account-copy-hint {
          color: var(--text-muted);
          font-size: 0.7rem;
          font-family: var(--font-sans);
          font-weight: 600;
        }
        /* Address, badges, then the username on its own line, all flush
           left; the Copy hint keeps to the first line's right edge */
        .nav-account-copy {
          align-items: flex-start;
          text-align: left;
        }
        .nav-account-self {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 4px 6px;
          flex: 1 1 auto;
          min-width: 0;
        }
        .nav-account-self .nav-username {
          font-family: var(--font-sans);
          font-size: 0.72rem;
        }
        /* Custody chip beside the address: the one the app is browsing as */
        .nav-account-role-me {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
        }
        .nav-account-role {
          font-family: var(--font-sans);
          font-size: 0.6rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(139, 92, 246, 0.2);
          color: var(--primary-hover);
        }
        .nav-account-plus {
          color: var(--primary-hover);
          font-size: 0.7rem;
          margin-left: -2px;
        }
        .nav-account-graph {
          padding: 0 0 6px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 0.78rem;
        }
        .nav-account-graph .nav-account-menu-label {
          padding-top: 4px;
        }
        /* One linked account: checkbox + address on the first line, the
           open arrow at the right, role and count on a second line */
        .nav-linked-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 2px 6px;
          padding: 4px 14px;
        }
        .nav-linked-main {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          cursor: pointer;
        }
        .nav-linked-self .nav-linked-main {
          cursor: default;
        }
        .nav-linked-main input {
          accent-color: var(--primary);
          margin: 0;
          width: 13px;
          height: 13px;
        }
        .nav-linked-addr {
          font-size: 0.74rem;
          color: #fff;
          white-space: nowrap;
        }
        /* The two row controls (swap, open) share one box so their glyphs,
           both from fallback fonts, sit on the same line in every row */
        .nav-linked-open,
        .nav-linked-swap {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 18px;
          padding: 0;
          background: none;
          border: 0;
          color: var(--primary-hover);
          font: inherit;
          font-size: 0.85rem;
          line-height: 1;
          cursor: pointer;
        }
        .nav-linked-swap:hover, .nav-linked-open:hover {
          color: #fff;
        }
        .nav-linked-role {
          width: 100%;
          padding-left: 21px;
          font-size: 0.68rem;
          color: var(--text-muted);
          white-space: nowrap;
        }
        /* The username line: full width, never truncated */
        .nav-username {
          display: block;
          width: 100%;
          font-size: 0.68rem;
          color: var(--text-muted);
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .nav-linked-row .nav-username {
          padding-left: 21px;
        }
        /* The 42-character EVM address gets its own label line and a
           smaller face than the Flow addresses, so it fits the menu width
           in full (never ellipsized; the wrap is a last-resort guard) */
        .nav-account-graph-evm {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 14px 0;
        }
        .nav-account-evm-hex {
          color: var(--text-muted);
          font-size: 0.72rem;
          letter-spacing: -0.01em;
        }
        .nav-account-evm-full {
          font-size: 0.72rem;
          letter-spacing: -0.01em;
          overflow-wrap: anywhere;
        }
        .nav-account-stats {
          padding: 8px 14px 8px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .nav-account-stat {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          font-size: 0.8rem;
          color: var(--text-main);
          border-radius: 4px;
          margin: 0 -6px;
          padding: 0 6px;
        }
        .nav-account-stat-sub {
          padding-left: 18px;
        }
        .nav-account-stat:hover {
          background: rgba(139, 92, 246, 0.12);
        }
        .nav-account-stat:hover .text-muted {
          color: #fff;
        }
        .nav-account-menu-note {
          padding: 2px 14px 8px;
          font-size: 0.78rem;
          color: var(--text-muted);
        }
        .nav-account-offers-link {
          justify-content: space-between;
        }
        .nav-account-offers-count {
          color: var(--text-muted);
          font-size: 0.75rem;
        }
        .nav-account-exit {
          width: 100%;
          background: none;
          border: none;
          cursor: pointer;
          color: #f87171;
          font-weight: 600;
          text-align: left;
          font-size: 0.85rem;
        }
        /* Ten links plus search: tighten before the wrap breakpoint so
           the bar never pushes the page wider than the viewport */
        @media (max-width: 1240px) {
          .nav-links {
            gap: 12px;
          }
          .nav-item {
            font-size: 0.86rem;
          }
          .nav-search-input {
            width: 170px;
          }
          /* The full address always shows; it shrinks instead of
             truncating when the bar tightens */
          .nav-account-chip {
            font-size: 0.78rem;
            padding: 6px 9px;
          }
        }
        @media (max-width: 1150px) {
          .nav-links {
            gap: 8px;
          }
          .nav-item {
            font-size: 0.8rem;
          }
          .nav-search-input {
            width: 120px;
          }
          .nav-account-chip {
            font-size: 0.72rem;
            padding: 5px 8px;
          }
        }
        /* Mobile: brand and menu button share the top row; the links live
           behind the button as a full-width vertical menu, so nothing is
           ever cut off the edge of a narrow screen. 1040 rather than 990:
           ten links do not fit a narrower bar at a readable size */
        @media (max-width: 1040px) {
          .glass-navbar {
            padding: 10px 14px;
            margin-bottom: 20px;
          }
          .nav-container {
            flex-wrap: wrap;
            position: relative;
            gap: 10px;
          }
          /* Brand and pill shrink so the whole top row (with the absolute
             menu button at its right edge) fits a 390px phone in one line */
          .nav-brand {
            font-size: 1.05rem;
          }
          .nav-sync-indicator {
            min-width: 70px;
            font-size: 0.7rem;
          }
          /* On a phone the idle pill gives its width back so the brand and
             the account chip share one row; while syncing it takes the
             space it needs */
          .nav-sync-indicator:not(.syncing) {
            display: none;
          }
          .nav-sync-indicator.syncing {
            position: absolute;
            left: -14px;
            bottom: -10px;
            width: calc(var(--sync-pct, 0%) + 0px);
            min-width: 0;
            height: 2px;
            padding: 0;
            border: none;
            border-radius: 0;
            background: var(--primary);
            transition: width 0.4s ease;
          }
          .nav-sync-indicator.syncing > * {
            display: none;
          }
          .nav-menu-btn {
            display: inline-flex;
            position: absolute;
            top: 0;
            right: 0;
          }
          /* The top row is at least the menu button's height (36px plus
             its border), so the Look up row below never runs into it */
          .nav-brand-group {
            min-height: 38px;
          }
          .nav-links {
            display: none;
            /* After the brand and the account chip, so the open menu lists
               under the top row instead of pushing the chip below it */
            order: 2;
          }
          .nav-links.open {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            width: 100%;
            gap: 2px;
            padding: 6px 0 2px;
          }
          .nav-links.open .nav-item {
            padding: 10px 10px;
            font-size: 1rem;
            border-radius: 8px;
          }
          .nav-links.open .nav-item:hover,
          .nav-links.open .nav-item.active {
            background: rgba(139, 92, 246, 0.12);
          }
          .nav-links.open .nav-item::after {
            display: none;
          }
          .nav-links.open .nav-dropdown-wrapper {
            width: 100%;
          }
          .nav-links.open .nav-dropdown-wrapper .nav-item {
            display: block;
            width: 100%;
            text-align: left;
          }
          /* In the mobile column the More menu flows in place instead of
             floating (hover does not exist; the button click opens it) */
          .nav-links.open .nav-dropdown-menu {
            position: static;
            transform: none;
            width: 100%;
            margin-top: 2px;
            animation: none;
          }
          .nav-search-form {
            width: 100%;
            max-width: 420px;
            margin: 0 auto;
          }
          /* Look up and Sign in share the second row edge to edge; the
             open box does too */
          .nav-tools,
          .nav-lookup-open {
            max-width: none;
          }
          .nav-tools .nav-lookup-btn {
            flex: 1;
          }
          .nav-recent-menu {
            width: 100%;
          }
          .nav-search-input {
            flex: 1;
            width: auto;
            min-width: 0;
          }
          /* The account chip takes the second row, right-aligned (the
             top row is the brand, the search icon and the menu button);
             the menu stays anchored beside the chip */
          .nav-account-wrapper {
            flex-basis: 100%;
            max-width: none;
            justify-content: flex-end;
            margin: 0;
          }
          /* The search icon is pinned to the top row beside the menu
             button (40px plus a gap), whatever the second row holds;
             open, the box is its own full-width row under the top row */
          .nav-search-wrap {
            position: absolute;
            top: 0;
            right: 50px;
          }
          .nav-search-wrap.open {
            position: static;
            width: 100%;
            max-width: none;
          }
          /* While the box is open, the Look up row steps aside */
          .nav-container:has(.nav-search-wrap.open) .nav-tools {
            display: none;
          }
          .nav-search-menu {
            width: 100%;
          }
          /* A long name wraps and its detail drops under it */
          .nav-search-result {
            flex-wrap: wrap;
            row-gap: 2px;
          }
          .nav-search-name {
            white-space: normal;
          }
          .nav-search-detail {
            flex-basis: 100%;
            text-align: left;
            padding-left: 64px;
          }
        }
        /* Small phones: the full address never truncates, so the
           brand gives way instead; under 375px the V2 badge goes too */
        @media (max-width: 480px) {
          .nav-brand {
            font-size: 0.85rem;
          }
          .nav-account-chip {
            font-size: 0.66rem;
            padding: 5px 7px;
            gap: 5px;
          }
        }
        @media (max-width: 375px) {
          .brand-badge {
            display: none;
          }
        }
      `}</style>
    </nav>
  );
}
