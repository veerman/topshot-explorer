import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useSession, connectWallet, signIn, stepOf } from "../services/wallet.service";
import { useWall, allEntries, signTheWall, myEntry, foldedAt } from "../services/wall.service";
import { approxCreatedAt, formatMonth } from "../services/flow.address";
import { AboutTabs } from "../components/AboutTabs";

const fmt = (n) => Number(n).toLocaleString();
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

/**
 * The Early Adopters wall: the collectors who signed in during the launch
 * and put their name on the almanac, in the order they did. Signing
 * records the address (proved by the sign-in), the username if they chose
 * to show it, the linked accounts, the block and the time. The folded
 * entries ship in data/early_adopters.json; newer ones show as pending
 * until the next fold commits them. It confers nothing.
 */
export function EarlyAdopters() {
  const s = useSession();
  const w = useWall();
  const [sort, setSort] = useState("order");
  const [showName, setShowName] = useState(true);
  // The reader's own entry, asked once per signed-in address; undefined
  // until asked (or when not signed in), null when they have not signed
  const [mineState, setMineState] = useState(null);
  const mine = s.status === "signed" && mineState && mineState.address === s.address ? mineState.entry : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (s.status !== "signed") return undefined;
    let alive = true;
    const address = s.address;
    myEntry().then((e) => { if (alive) { setMineState({ address, entry: e }); if (e) setShowName(e.showName); } });
    return () => { alive = false; };
  }, [s.status, s.address]);
  const setMine = (entry) => setMineState({ address: s.address, entry });

  const entries = useMemo(() => {
    const list = allEntries(w).map((e) => ({ ...e, since: approxCreatedAt(e.address) }));
    if (sort === "size") return [...list].sort((a, b) => (b.moments ?? -1) - (a.moments ?? -1) || a.seq - b.seq);
    if (sort === "since") return [...list].sort((a, b) => (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity) || a.seq - b.seq);
    return list;
  }, [w, sort]);

  const sign = async () => {
    setBusy(true);
    setError(null);
    try {
      setMine(await signTheWall(showName));
    } catch (err) {
      setError((err && err.message) || String(err));
    }
    setBusy(false);
  };

  const sortBtn = (key, label) => (
    <button type="button" className={`ea-sort${sort === key ? " is-on" : ""}`} onClick={() => setSort(key)} aria-pressed={sort === key}>
      {sort === key ? "✓ " : ""}{label}
    </button>
  );

  return (
    <div className="ea-page">
      <AboutTabs />
      <div className="glass-panel ea-head">
        <h1 className="ea-title">Early Adopters</h1>
        <p className="text-muted ea-lead">
          The first collectors to put their name on the almanac, in the order they did. Sign with your linked wallet, or your Dapper wallet. The list ships with the code, in the order people signed. It confers nothing; it says they were here.
        </p>
        <div className="ea-count">
          <span className="ea-count-num font-mono">{fmt(w.total)}</span>
          <span className="text-muted"> {w.total === 1 ? "signature" : "signatures"}{foldedAt ? `, committed through ${day(foldedAt)}` : ""}</span>
        </div>

        <div className="ea-sign">
          {s.status === "signed" ? (
            mine ? (
              <p className="ea-signed">
                You signed <span className="font-mono">#{fmt(mine.seq)}</span> at block <span className="font-mono">{fmt(mine.block)}</span>{mine.folded ? "." : ", pending the next commit."}
                {" "}<label className="ea-check"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Show my username</label>
                {showName !== mine.showName && <button type="button" className="btn-primary ea-btn" onClick={() => void sign()} disabled={busy}>Save</button>}
              </p>
            ) : mine === null ? (
              <div className="ea-sign-row">
                <label className="ea-check"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Show my username</label>
                <button type="button" className="btn-primary ea-btn" onClick={() => void sign()} disabled={busy}>{busy ? "Signing" : "Sign the wall"}</button>
              </div>
            ) : null
          ) : s.status === "unavailable" || w.available === false ? null : (
            <div className="ea-sign-row">
              {/* Connected (the navbar's Sign in) but the message not yet
                  signed: this is the one place that asks for it */}
              <button type="button" className="btn-primary ea-btn" onClick={() => void (s.wallet ? signIn() : connectWallet())} disabled={stepOf(s) === "busy"}>
                {stepOf(s) === "busy" ? "Waiting for your wallet" : s.wallet ? "Sign the message" : "Sign in with your wallet"}
              </button>
              {s.wallet && <span className="text-muted ea-connected">One signature with <span className="font-mono">{s.wallet.address}</span>; no transaction, nothing moves.</span>}
            </div>
          )}
          {(error || (s.status !== "signed" && s.error)) && <p className="ea-error" role="alert">{error || s.error}</p>}
        </div>
      </div>

      <div className="glass-panel ea-list-panel">
        <div className="ea-sorts">
          <span className="text-muted">Order by</span>
          {sortBtn("order", "Signing order")}
          {sortBtn("size", "Collection size")}
          {sortBtn("since", "Collecting since")}
        </div>
        {entries.length === 0 ? (
          <p className="text-muted ea-empty">{w.status === "loading" ? "Loading signatures" : "No signatures yet."}</p>
        ) : (
          <ol className="ea-list">
            {entries.map((e) => (
              <li key={e.address} className="ea-row">
                <span className="ea-seq font-mono">#{fmt(e.seq)}</span>
                <span className="ea-who">
                  {e.username && <span className="ea-name">@{e.username}</span>}
                  <Link to={`/account/${e.address}`} className="font-mono ea-addr">{e.address}</Link>
                  {e.linked.map((a) => (
                    <Link key={a} to={`/account/${a}`} className="font-mono ea-addr ea-addr-linked" title="Linked account">{a}</Link>
                  ))}
                </span>
                <span className="ea-facts text-muted">
                  {e.kind === "parent" ? <span>Parent wallet</span> : e.kind === "dapper" ? <span>Dapper wallet</span> : null}
                  {e.moments !== undefined && e.moments !== null && <span>{fmt(e.moments)} moments</span>}
                  {e.since && <span>since ~{formatMonth(e.since)}</span>}
                  {e.block && <span>block {fmt(e.block)}</span>}
                  <span>{day(e.signedAt)}</span>
                  {e.pending && <span className="ea-pending">pending</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <style>{`
        .ea-page { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 4px; }
        .ea-head { margin-bottom: 16px; }
        .ea-head { padding: 30px; }
        .ea-title { font-size: 1.8rem; margin: 0 0 8px; }
        .ea-lead { margin: 0 0 18px; font-size: 0.95rem; max-width: 66ch; }
        .ea-count { font-size: 1rem; margin-bottom: 18px; }
        .ea-count-num { font-size: 1.4rem; font-weight: 700; color: #fff; }
        .ea-sign { min-height: 40px; }
        .ea-sign-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
        .ea-check { display: inline-flex; align-items: center; gap: 6px; font-size: 0.9rem; cursor: pointer; }
        .ea-btn { padding: 8px 16px; }
        .ea-signed { margin: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .ea-connected { font-size: 0.9rem; overflow-wrap: anywhere; }
        .ea-error { margin: 12px 0 0; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; color: #fff; font-size: 0.9rem; }
        .ea-list-panel { padding: 22px 30px; }
        .ea-sorts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 14px; }
        .ea-sort { background: transparent; border: 1px solid var(--border-light); color: var(--text-main); border-radius: 9999px; padding: 4px 12px; cursor: pointer; font-size: 0.82rem; }
        .ea-sort.is-on { border-color: rgba(255,255,255,0.5); color: #fff; }
        .ea-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
        .ea-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 6px 14px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--border-light); }
        .ea-row:first-child { border-top: none; }
        .ea-seq { color: var(--text-muted); font-weight: 600; }
        .ea-who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .ea-name { color: #fff; font-weight: 600; }
        .ea-addr { color: var(--text-main); text-decoration: none; font-size: 0.9rem; }
        .ea-addr-linked { color: var(--text-muted); font-size: 0.82rem; }
        .ea-facts { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.8rem; justify-content: flex-end; text-align: right; }
        .ea-pending { border: 1px solid var(--border-light); border-radius: 9999px; padding: 1px 8px; }
        .ea-empty { margin: 0; }
        @media (max-width: 640px) { .ea-row { grid-template-columns: 52px minmax(0, 1fr); } .ea-facts { grid-column: 2; justify-content: flex-start; text-align: left; } }
      `}</style>
    </div>
  );
}
