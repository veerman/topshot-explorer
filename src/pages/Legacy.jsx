import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { getAllPlaysDB, getAllSetsDB } from "../services/db.service";
import { buildIdentityContext } from "../services/identity.service";
import { subeditionLabel } from "../services/fcl.service";
import { loadDapperIds, parseLegacyInput, resolveLegacy } from "../services/legacy.service";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";

/**
 * Old nbatopshot.com links, resolved to pages here. Two ways in: paste a
 * link into the box, or swap the host on an old link so that
 * nbatopshot.com/edition/<set>/<play> becomes /legacy/edition/<set>/<play>
 * (the route is /legacy/*), which redirects straight through when the link
 * resolves and shows the explanation when it cannot.
 */
const PREFIX = "/legacy";

export function Legacy() {
  const location = useLocation();
  // The mirrored path, when the visitor arrived through /legacy/<old path>
  const mirrored = location.pathname.length > PREFIX.length + 1
    ? location.pathname.slice(PREFIX.length) + location.search
    : "";

  const [maps, setMaps] = useState(null);
  const [mapsError, setMapsError] = useState("");
  const [input, setInput] = useState(mirrored);
  const [submitted, setSubmitted] = useState(mirrored);
  const [names, setNames] = useState(null);

  useEffect(() => {
    let alive = true;
    loadDapperIds()
      .then((m) => { if (alive) setMaps(m); })
      .catch((err) => { console.error("Dapper id files failed to load", err); if (alive) setMapsError("The id files failed to load. Retry, or reload the page."); });
    // Names for the result card come from the local database when it has
    // synced; the lookup itself never waits for them
    Promise.all([getAllPlaysDB(), getAllSetsDB()])
      .then(([plays, sets]) => { if (alive && plays.length && sets.length) setNames(buildIdentityContext(plays, sets)); })
      .catch(() => { /* names stay off */ });
    return () => { alive = false; };
  }, []);

  const result = useMemo(() => (maps && submitted ? resolveLegacy(parseLegacyInput(submitted), maps) : null), [maps, submitted]);

  // Arrived through the mirror and it resolved: go straight there
  if (mirrored && submitted === mirrored && result && result.target) {
    return <Navigate to={result.target} replace />;
  }

  const onSubmit = (e) => {
    e.preventDefault();
    setSubmitted(input.trim());
  };

  return (
    <div className="legacy-page">
      <div className="glass-panel info-banner">
        <h2>Legacy links</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Paste a link from the original nbatopshot.com to open the same set, play or edition here. The old site
          named things by Dapper Labs ids; this page maps them to the ids on the Flow Blockchain. Moment and pack links
          cannot be mapped: Dapper Labs never published those ids beside the on-chain ones.
        </p>
      </div>

      <form className="glass-panel mt-20" onSubmit={onSubmit} style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          className="form-control"
          placeholder="https://nbatopshot.com/..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Old nbatopshot.com link"
          style={{ flex: "1 1 320px", minWidth: 0 }}
        />
        <button type="submit" className="btn-primary" disabled={!maps || !input.trim()}>Look up</button>
      </form>

      {mapsError && <div className="mt-20"><LoadError message={mapsError} onRetry={() => { setMapsError(""); loadDapperIds().then(setMaps).catch(() => setMapsError("The id files failed to load. Retry, or reload the page.")); }} /></div>}
      {!maps && !mapsError && <div className="mt-20"><Loader message="Loading the id tables..." /></div>}

      {result && <ResultCard result={result} names={names} />}

      {maps && !result && (
        <p className="text-muted mt-20" style={{ fontSize: "0.85rem" }}>
          Ids on file: {maps.counts.plays.toLocaleString()} plays, {maps.counts.sets.toLocaleString()} sets,{" "}
          {maps.counts.editions.toLocaleString()} old-site editions, {maps.counts.atlas.toLocaleString()} current-site edition numbers.
        </p>
      )}
    </div>
  );
}

const KIND_LABEL = { set: "set", play: "play", edition: "edition", "atlas edition": "edition", unknown: "not on file" };

function ResultCard({ result, names }) {
  const { label, found, target, targetLabel, note } = result;
  if (!result.family && found.length === 0 && !note) return null;
  return (
    <div className="glass-panel mt-20">
      <h3 style={{ margin: 0 }}>{label}</h3>
      {found.length > 0 && (
        <ul className="mt-8" style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: "4px" }}>
          {found.map((f) => (
            <li key={f.id} style={{ fontSize: "0.85rem" }}>
              <code style={{ wordBreak: "break-all" }}>{f.id}</code>
              <span className="text-muted">{" "}is {KIND_LABEL[f.kind] || f.kind}{f.flowID != null ? ` ${f.flowID}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {target ? (
        <p className="mt-8" style={{ marginBottom: 0 }}>
          <Link to={target} className="btn-primary" style={{ display: "inline-flex" }}>Open {targetLabel}</Link>
          <span className="text-muted" style={{ marginLeft: "10px", fontSize: "0.9rem" }}><Description target={target} names={names} /></span>
        </p>
      ) : null}
      {note && <p className="text-muted mt-8" style={{ marginBottom: 0, fontSize: "0.9rem" }}>{note}</p>}
    </div>
  );
}

/** What the target is, in words, when the local database can name it */
function Description({ target, names }) {
  if (!names) return null;
  const m = target.match(/^\/editions\/(\d+)_(\d+)(?:_(\d+))?$/);
  if (m) {
    const f = names.factsOf(m[1], m[2]);
    if (!f.play) return null;
    const bits = [f.setName, f.player, [f.ptype, f.year].filter(Boolean).join(" ")].filter(Boolean);
    if (m[3]) bits.push(subeditionLabel(Number(m[3])));
    return bits.join(" · ");
  }
  const s = target.match(/^\/sets\/(\d+)$/);
  if (s) {
    const rec = names.sets.get(Number(s[1]));
    return rec ? (rec.setName || rec.name || "") + (rec.series != null ? ` (Series ${rec.series})` : "") : null;
  }
  const p = target.match(/^\/plays\/(\d+)$/);
  if (p) {
    const raw = names.plays.get(Number(p[1]));
    return raw ? [raw.FullName, raw.PlayCategory || raw.PlayType, raw.DateOfMoment ? String(raw.DateOfMoment).slice(0, 4) : ""].filter(Boolean).join(" · ") : null;
  }
  return null;
}
