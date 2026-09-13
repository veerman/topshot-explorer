import { useEffect, useMemo, useState } from "react";
import { Loader } from "../components/Loader";
import { Link } from "react-router-dom";
import { getAllSetsDB } from "../services/db.service";
import { MEDIA_BASE, fetchMediaManifest } from "../services/media.service";
import logosRecipe from "../../data/logos.json";
import { getAdditionsTeamNameMap } from "../services/overrides.service";

// Gallery of the assets derived from set art by the recipes
// (data/logos.json + the extractors). The files live in the gitignored
// assets/ tree; in dev a vite middleware serves them plus a synthesized
// manifest at /assets/manifest.json. No manifest = nothing generated on
// this host, and the page says so instead of rendering broken images.
//
// Layout: group team logos BY TEAM, and within a team show the
// sets in a fixed sequence (Base, Metallic Silver, Metallic Gold, Holo,
// Genesis, ...), not chain order.

const FILE_RE = /^(\d+)_(\d+)_(\d+)-(.+)\.(png|jpg)$/;

const TYPE_ORDER = [/\bbase\b/i, /metallic silver/i, /metallic gold/i, /\bholo\b/i, /genesis/i, /champion/i];
const typeRank = (setName) => {
  const i = TYPE_ORDER.findIndex((re) => re.test(setName || ""));
  return i === -1 ? TYPE_ORDER.length : i;
};

const ACRONYMS = new Set(["nba", "wnba", "la"]);
const slugToName = (slug) => String(slug)
  .split("_")
  .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(" ");

// Badge display names come from the recipe verbatim (title-cased), so
// characters the filename slug drops (parentheses) still show; keyed by
// the same slug the extractor writes into filenames
const nameSlug = (name) => name.toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");
const titleCaseName = (name) => name.split(" ").map((w) => {
  const m = w.match(/[a-z]+/i);
  if (!m) return w;
  const core = m[0];
  return w.replace(core, ACRONYMS.has(core.toLowerCase()) ? core.toUpperCase() : core.charAt(0).toUpperCase() + core.slice(1));
}).join(" ");
const RECIPE_NAMES = new Map();
(logosRecipe.badges || []).forEach((b) => { if (b.name) RECIPE_NAMES.set(nameSlug(b.name), b.name); });
(logosRecipe.masks || []).forEach((m) => { if (m.name) RECIPE_NAMES.set(nameSlug(m.name), m.name); });
const badgeName = (slug) => {
  const raw = RECIPE_NAMES.get(slug);
  return raw ? titleCaseName(raw) : slugToName(slug);
};

export function Assets() {
  const [manifest, setManifest] = useState(undefined); // undefined = loading, null = unavailable
  const [sets, setSets] = useState(null);

  useEffect(() => {
    // Media base: the bucket in production, the vite middleware in dev,
    // null on hosts serving no derived media (the page says so below)
    fetchMediaManifest()
      .then((m) => setManifest(m && m.teams ? m : null))
      .catch(() => setManifest(null));
    getAllSetsDB()
      .then((all) => setSets(new Map(all.map((s) => [Number(s.id), s]))))
      .catch(() => setSets(new Map()));
  }, []);

  const data = useMemo(() => {
    if (!manifest || !sets) return null;
    const parseFiles = (files, urlBase) => (files || [])
      .map((file) => {
        const m = FILE_RE.exec(file);
        if (!m) return null;
        const setID = Number(m[1]);
        const setRec = sets.get(setID);
        return {
          file,
          url: `${urlBase}/${file}`,
          setID,
          playID: Number(m[2]),
          slug: m[4],
          setName: setRec?.setName || `Set #${setID}`,
          series: setRec?.series
        };
      })
      .filter(Boolean);

    const byTeam = new Map(); // slug -> { name, league, items }
    for (const league of ["nba", "wnba"]) {
      for (const item of parseFiles(manifest.teams?.[league], `${MEDIA_BASE}/logos/teams/${league}`)) {
        let team = byTeam.get(item.slug);
        if (!team) {
          const name = slugToName(item.slug);
          // The team page, by the curated name map (historical names
          // included); a slug it does not know stays a plain heading
          const teamID = getAdditionsTeamNameMap()[name.toLowerCase()] || null;
          byTeam.set(item.slug, (team = { name, teamID, league, items: [] }));
        }
        team.items.push(item);
      }
    }
    const seq = (a, b) => (typeRank(a.setName) - typeRank(b.setName))
      || ((Number(a.series) || 0) - (Number(b.series) || 0))
      || (a.setID - b.setID);
    byTeam.forEach((t) => t.items.sort(seq));
    const teams = [...byTeam.values()].sort((a, b) =>
      (a.league === b.league ? a.name.localeCompare(b.name) : (a.league === "nba" ? -1 : 1)));

    // By name so families cluster (all the allstar badges together, all
    // the finals together, ...); set id only breaks name ties
    const badges = parseFiles(manifest.badges, `${MEDIA_BASE}/logos/badges`)
      .map((b) => ({ ...b, name: badgeName(b.slug) }))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.setID - b.setID));

    return { teams, badges, total: teams.reduce((n, t) => n + t.items.length, 0) + badges.length };
  }, [manifest, sets]);

  return (
    <div className="assets-container">
      <div className="glass-panel" style={{ padding: "24px 30px" }}>
        <div className="d-flex align-center gap-10 flex-wrap">
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Derived Assets</h1>
        </div>
        <p className="text-muted mt-8" style={{ fontSize: "0.85rem", margin: "8px 0 0" }}>
          Team logos and event badges extracted from hero set art by the recipes, grouped by team in set sequence.
          {data ? ` ${data.total} assets.` : ""}
        </p>
      </div>

      {manifest === undefined || (manifest && !data) ? (
        <Loader message={<>Loading asset manifest...</>} />
      ) : manifest === null ? (
        <div className="glass-panel text-center mt-20" style={{ padding: "40px" }}>
          <h3>No derived assets on this host</h3>
          <p className="text-muted mt-8" style={{ fontSize: "0.9rem" }}>
            No derived media on this host. Generate the assets/ tree from the recipes (scripts/extract-set-art.mjs and
            scripts/extract-set-badges.mjs), or point VITE_MEDIA_BASE at a bucket that serves it (docs/MEDIA-PIPELINE.md).
          </p>
        </div>
      ) : (
        <>
          {data.teams.map((team) => (
            <div key={`${team.league}-${team.name}`} className="glass-panel mt-20 asset-section">
              <div className="d-flex align-center gap-10">
                <h3 style={{ margin: 0 }}>
                  {team.teamID
                    ? <Link to={`/teams/${team.teamID}`} className="font-hover-glow" style={{ textDecoration: "none", color: "inherit" }}>{team.name}</Link>
                    : team.name}
                </h3>
                <span className="set-id-tag" style={{ fontSize: "0.7rem" }}>{team.league.toUpperCase()}</span>
              </div>
              <div className="asset-grid mt-8">
                {team.items.map((item) => (
                  <div key={item.file} className="asset-card" title={`${item.setName} (set ${item.setID}, play ${item.playID})`}>
                    <div className="asset-img"><img src={item.url} alt={`${team.name} - ${item.setName}`} loading="lazy" /></div>
                    <Link to={`/sets/${item.setID}`} className="asset-cap">
                      {item.setName}{item.series != null ? <span className="text-muted"> · S{item.series}</span> : null}
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {data.badges.length > 0 && (
            <div className="glass-panel mt-20 asset-section">
              <h3 style={{ margin: 0 }}>Badges</h3>
              <div className="asset-grid mt-8">
                {data.badges.map((b) => (
                  <div key={b.file} className="asset-card" title={`${b.setName} (set ${b.setID}, play ${b.playID})`}>
                    <div className="asset-img"><img src={b.url} alt={b.name} loading="lazy" /></div>
                    <Link to={`/sets/${b.setID}`} className="asset-cap">
                      {b.name}
                      <span className="text-muted" style={{ display: "block" }}>{b.setName}</span>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <style>{`
        .assets-container {
          max-width: 1250px;
          margin: 0 auto;
          width: 100%;
        }
        .asset-section {
          padding: 20px 24px;
        }
        .asset-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 14px;
        }
        .asset-card {
          width: 132px;
        }
        .asset-img {
          width: 132px;
          height: 132px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.07);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .asset-img img {
          max-width: 88%;
          max-height: 88%;
          object-fit: contain;
        }
        .asset-cap {
          display: block;
          font-size: 0.72rem;
          line-height: 1.35;
          padding: 4px 1px 0;
          color: inherit;
          text-decoration: none;
        }
        .asset-cap:hover {
          color: var(--primary-hover);
        }
        .set-id-tag {
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          font-family: var(--font-mono);
          font-size: 0.8rem;
          padding: 3px 9px;
          border-radius: 6px;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
