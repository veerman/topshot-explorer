import { useState, useEffect, useMemo, useCallback } from "react";
import { useUsernames, introOf } from "../services/usernames.service";
import { Loader } from "../components/Loader";
import { writeFilters, useFacetFilters, useSortState, readSort, cascadeOf } from "../hooks/useFacetFilters";
import { SortableTh } from "../components/SortableTh";
import { LoadError } from "../components/LoadError";
import { useParams, Link } from "react-router-dom";
import { getOffersMadeBy, subeditionLabel } from "../services/fcl.service";
import { Pagination } from "../components/Pagination";
import { normalizeAddress } from "../services/account.context";
import { getAllPlaysDB, getAllSetsDB } from "../services/db.service";
import { applyPlayOverrides } from "../services/overrides.service";
import { getEditionTier } from "../services/set.status";
import { playSummary, getLeagueName, tierFacetRank as tierRank, playerPath } from "../utils/display.utils";
import { formatOfferAmount } from "../services/offers.service";
import { MultiSelect } from "../components/MultiSelect";
import { toQuery } from "../utils/query";

/*
 * Active marketplace offers MADE BY an account, enumerated live from its
 * public DapperOffersV2 collection (the buyer's account holds its own
 * offers, so this direction needs no snapshot). Offer levels: Serial
 * (one exact moment), Edition (any subedition of a play), Subedition
 * (one parallel of a play). Serial-level offers only carry the target
 * moment id on chain; there is no global moment -> edition index, so
 * those rows link out to nbatopshot.com instead of naming the play.
 */

const LEVEL_LABELS = { NFT: "Serial", TopShotEdition: "Edition", TopShotSubedition: "Subedition" };
const TYPE_OPTIONS = [["serial", "Serial"], ["edition", "Edition"], ["subedition", "Subedition"]];
const typeKeyOf = (level) => (level === "NFT" ? "serial" : level === "TopShotSubedition" ? "subedition" : "edition");

// Filters live in the URL, same convention as the account page; the
// read/write machinery is shared (hooks/useFacetFilters)
const EMPTY_FILTERS = { otype: [], league: [], series: [], set: [], sub: [], tier: [], type: [], year: [], player: [], team: [] };
const FILTER_KEYS = Object.keys(EMPTY_FILTERS);

const DEFAULT_SORT = { key: "amount", dir: "desc" };

function writeFiltersToLocation(filters, sort) {
  const params = new URLSearchParams();
  writeFilters(params, filters, EMPTY_FILTERS);
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  const qs = toQuery(params);
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

export function AccountOffers() {
  useUsernames();
  const { address } = useParams();
  const formattedAddress = normalizeAddress(address) || "";

  const [offers, setOffers] = useState(null);
  const [error, setError] = useState(null);
  const [localMeta, setLocalMeta] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  const resetPage = useCallback(() => setCurrentPage(1), []);

  const { filters, setFilter, clearFilters, anyFilter } = useFacetFilters(EMPTY_FILTERS, { onChange: resetPage });

  // Sort rides the URL with the filters, same as the other offer pages
  const { sort, sortBy } = useSortState(readSort(DEFAULT_SORT), { onChange: resetPage });
  const sortTh = (label, key) => (
    <SortableTh label={label} sortKey={key} sort={sort} onSort={sortBy} title={`Sort by ${label.toLowerCase()}`} />
  );

  useEffect(() => {
    writeFiltersToLocation(filters, sort);
  }, [filters, sort]);

  // Live enumeration of the account's offer book (a 2,777-offer whale
  // book returns in ~2s in one call)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.resolve(); // reset after mount settles, never mid-render
      if (cancelled) return;
      setOffers(null);
      setError(null);
      try {
        const rows = await getOffersMadeBy(address);
        if (!cancelled) setOffers(rows);
      } catch (err) {
        console.error("Failed to enumerate offers:", err);
        if (!cancelled) setError(`Failed to read the offer collection for ${formattedAddress}.`);
      }
    })();
    return () => { cancelled = true; };
  }, [address, formattedAddress]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllPlaysDB(), getAllSetsDB()])
      .then(([plays, sets]) => {
        if (cancelled) return;
        setLocalMeta({
          plays: new Map(plays.map((p) => [Number(p.playID), p])),
          sets: new Map(sets.map((s) => [Number(s.id), s]))
        });
      })
      .catch(() => { if (!cancelled) setLocalMeta({ plays: new Map(), sets: new Map() }); });
    return () => { cancelled = true; };
  }, []);

  // One fact record per offer, feeding the option cascade, the filters
  // and the table (serial-level offers carry no edition facts)
  const offerFacts = useMemo(() => {
    if (!offers || !localMeta) return null;
    return offers.map((o) => {
      const otype = typeKeyOf(o.level);
      if (otype === "serial") {
        return { ...o, otype, play: null, series: null, setName: "", tier: "", ptype: "", year: "", player: "", team: "", league: "" };
      }
      const sRec = localMeta.sets.get(o.setID);
      const raw = localMeta.plays.get(o.playID);
      const play = raw ? applyPlayOverrides({ playID: o.playID, ...raw }) : null;
      const team = (play?.TeamAtMoment || "").trim();
      return {
        ...o,
        otype,
        play,
        series: sRec?.series != null ? Number(sRec.series) : null,
        setName: sRec?.setName || `Set #${o.setID}`,
        tier: getEditionTier(o.setID, o.playID) || "",
        ptype: (play?.PlayCategory || play?.PlayType || "").trim(),
        year: play?.DateOfMoment ? String(play.DateOfMoment).slice(0, 4) : "",
        player: (play?.FullName || "").trim(),
        team,
        league: team ? getLeagueName(team) : ""
      };
    });
  }, [offers, localMeta]);

  const passFns = useMemo(() => ({
    otype: (v) => filters.otype.length === 0 || filters.otype.includes(v),
    league: (v) => filters.league.length === 0 || (Boolean(v) && filters.league.includes(v)),
    series: (v) => filters.series.length === 0 || (v != null && filters.series.includes(String(v))),
    set: (v) => filters.set.length === 0 || (v != null && filters.set.includes(String(v))),
    sub: (v) => filters.sub.length === 0 || (v != null && filters.sub.includes(String(v))),
    tier: (v) => filters.tier.length === 0 || (Boolean(v) && filters.tier.includes(v)),
    type: (v) => filters.type.length === 0 || (Boolean(v) && filters.type.includes(v)),
    year: (v) => filters.year.length === 0 || (Boolean(v) && filters.year.includes(v)),
    player: (v) => filters.player.length === 0 || (Boolean(v) && filters.player.includes(v)),
    team: (v) => filters.team.length === 0 || (Boolean(v) && filters.team.includes(v))
  }), [filters]);

  // Same cascade rule as the account page (hooks/useFacetFilters): a facet
  // offers a value when some offer carries it and fails no OTHER facet
  const facetData = useMemo(() => {
    if (!offerFacts) return null;
    const opts = { otype: new Set(), league: new Set(), series: new Set(), set: new Map(), sub: new Set(), tier: new Set(), type: new Set(), year: new Set(), player: new Set(), team: new Set() };
    const matched = [];
    offerFacts.forEach((f) => {
      const pass = {
        otype: passFns.otype(f.otype),
        league: passFns.league(f.league),
        series: passFns.series(f.series),
        set: passFns.set(f.setID),
        sub: passFns.sub(f.subID),
        tier: passFns.tier(f.tier),
        type: passFns.type(f.ptype),
        year: passFns.year(f.year),
        player: passFns.player(f.player),
        team: passFns.team(f.team)
      };
      const { matched: rowMatched, offer } = cascadeOf(pass, FILTER_KEYS);
      if (rowMatched) matched.push(f);
      if (offer("otype")) opts.otype.add(f.otype);
      if (offer("league") && f.league) opts.league.add(f.league);
      if (offer("series") && f.series != null) opts.series.add(f.series);
      if (offer("set") && f.setID != null) opts.set.set(f.setID, f.setName);
      if (offer("sub") && f.subID != null) opts.sub.add(f.subID);
      if (offer("tier") && f.tier) opts.tier.add(f.tier);
      if (offer("type") && f.ptype) opts.type.add(f.ptype);
      if (offer("year") && f.year) opts.year.add(f.year);
      if (offer("player") && f.player) opts.player.add(f.player);
      if (offer("team") && f.team) opts.team.add(f.team);
    });
    matched.sort((a, b) => (b.amount - a.amount) || ((b.playID || 0) - (a.playID || 0)) || ((b.nftID || 0) - (a.nftID || 0)));
    return { opts, matched };
  }, [offerFacts, passFns]);

  // Column sort over the matched rows; serial rows carry no edition
  // facts, so on edition-keyed sorts they sink to the end
  const sortedMatched = useMemo(() => {
    if (!facetData) return null;
    if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) return facetData.matched;
    const val = (f) => {
      switch (sort.key) {
        case "otype": return f.otype;
        case "set": return f.setName || "";
        case "play": return f.play?.DateOfMoment ? String(f.play.DateOfMoment).slice(0, 10) : "";
        case "sub": return f.subID != null ? Number(f.subID) : -1;
        case "player": return f.player || "";
        default: return f.amount;
      }
    };
    const d = sort.dir === "asc" ? 1 : -1;
    const rows = [...facetData.matched];
    rows.sort((a, b) => {
      let cmp;
      if (sort.key === "target") {
        cmp = ((a.setID ?? Infinity) - (b.setID ?? Infinity))
          || ((a.playID || 0) - (b.playID || 0))
          || ((a.subID || 0) - (b.subID || 0))
          || ((a.nftID || 0) - (b.nftID || 0));
      } else {
        const va = val(a);
        const vb = val(b);
        cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      }
      return (cmp * d) || (b.amount - a.amount);
    });
    return rows;
  }, [facetData, sort]);

  const totalPages = Math.ceil((sortedMatched?.length || 0) / pageSize) || 1;
  const pageRows = sortedMatched ? sortedMatched.slice((currentPage - 1) * pageSize, currentPage * pageSize) : [];

  const subLabel = subeditionLabel;
  const msFacet = (label, key, options) => ((options.length > 1 || filters[key].length > 0)
    ? <MultiSelect label={label} values={filters[key]} options={options} onChange={(vals) => setFilter(key, vals)} />
    : null);

  if (error) {
    return <LoadError title="⚠️ Offers Load Error" message={error} />;
  }

  return (
    <div className="account-container" style={{ maxWidth: "1250px", margin: "0 auto", width: "100%" }}>
      <div className="glass-panel" style={{ padding: "30px" }}>
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <span className="account-badge" style={{ background: "rgba(139, 92, 246, 0.12)", color: "var(--primary-hover)", fontSize: "0.85rem", padding: "4px 10px", borderRadius: "6px", fontWeight: 600 }}>
              Offers Made
            </span>
            <h1 className="mt-8" style={{ fontSize: "2rem", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{formattedAddress}</h1>
            {introOf(formattedAddress) && <div className="account-username" title={introOf(formattedAddress).detail}>{introOf(formattedAddress).text}</div>}
            <div className="d-flex gap-10 mt-8 flex-wrap">
              {offers && <span className="badge badge-success">Active offers: {offers.length.toLocaleString()}</span>}
            </div>
          </div>
          <Link
            to={`/account/${formattedAddress}`}
            className="btn-primary"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", boxShadow: "none", textDecoration: "none" }}
          >
            ← Collection
          </Link>
        </div>
      </div>

      <div className="glass-panel table-panel mt-20">
        {!offers || !offerFacts ? (
          <Loader message={<>Reading the offer collection from the Flow Blockchain...</>} />
        ) : offers.length === 0 ? (
          <div className="text-center text-muted" style={{ padding: "40px" }}>
            No active marketplace offers.
          </div>
        ) : (
          <div>
            <div className="d-flex align-center flex-wrap" style={{ gap: "10px 12px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              {msFacet("Type", "otype", TYPE_OPTIONS.filter(([k]) => facetData.opts.otype.has(k) || filters.otype.includes(k)))}
              {msFacet("League", "league", [...facetData.opts.league].sort().map((l) => [l, l]))}
              {msFacet("Series", "series", [...facetData.opts.series].sort((a, b) => a - b).map((s) => [String(s), `Series ${s}`]))}
              {msFacet("Set", "set", [...facetData.opts.set.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => [String(id), name]))}
              {msFacet("Subedition", "sub", [...facetData.opts.sub].sort((a, b) => a - b).map((s) => [String(s), subLabel(s)]))}
              {msFacet("Tier", "tier", [...facetData.opts.tier].sort((a, b) => tierRank(a) - tierRank(b)).map((t) => [t, t]))}
              {msFacet("Play type", "type", [...facetData.opts.type].sort().map((t) => [t, t]))}
              {msFacet("Year", "year", [...facetData.opts.year].sort().reverse().map((y) => [y, y]))}
              {msFacet("Player", "player", [...facetData.opts.player].sort((a, b) => a.localeCompare(b)).map((p) => [p, p]))}
              {msFacet("Team", "team", [...facetData.opts.team].sort((a, b) => a.localeCompare(b)).map((t) => [t, t]))}
              {anyFilter && (
                <button
                  className="btn-primary"
                  style={{ padding: "3px 10px", fontSize: "0.8rem", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", boxShadow: "none" }}
                  onClick={clearFilters}
                >
                  ✕ Clear
                </button>
              )}
              {anyFilter && (
                <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                  {facetData.matched.length.toLocaleString()} of {offers.length.toLocaleString()} offers match
                </span>
              )}
            </div>

            <div className="table-wrapper">
              <table className="premium-table">
                <thead>
                  <tr>
                    {sortTh("Type", "otype")}
                    {sortTh("Target", "target")}
                    {sortTh("Set", "set")}
                    {sortTh("Play", "play")}
                    {sortTh("Subedition", "sub")}
                    {sortTh("Player", "player")}
                    {sortTh("Offer", "amount")}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((f) => (
                    <tr key={f.offerId}>
                      <td>{LEVEL_LABELS[f.level] || f.level}</td>
                      {f.otype === "serial" ? (
                        <>
                          {/* On-chain the offer carries only the moment id;
                              its edition is on the target page */}
                          <td className="font-mono">
                            <a href={`https://nbatopshot.com/moment/${f.nftID}?tab=details`} target="_blank" rel="noopener noreferrer" style={{ fontWeight: "600", whiteSpace: "nowrap" }}>
                              NFT #{f.nftID} ↗
                            </a>
                          </td>
                          <td className="text-muted">-</td>
                          <td className="text-muted">-</td>
                          <td className="text-muted">-</td>
                          <td className="text-muted">-</td>
                        </>
                      ) : (
                        <>
                          <td className="font-mono">
                            <Link to={`/editions/${f.setID}_${f.playID}${f.otype === "subedition" ? `_${f.subID}` : ""}`}>
                              {f.setID}_{f.playID}{f.otype === "subedition" ? `_${f.subID}` : ""}
                            </Link>
                          </td>
                          <td><Link to={`/sets/${f.setID}`}>{f.setName}</Link></td>
                          <td><Link to={`/plays/${f.playID}`}>{playSummary(f.play, f.playID)}</Link></td>
                          <td>{f.otype === "subedition" ? subLabel(f.subID) : <span className="text-muted" title="An edition-level offer accepts any subedition of the play">Any</span>}</td>
                          <td>
                            {f.player ? (
                              <Link to={playerPath(f.player)} style={{ fontWeight: "600" }}>{f.player}</Link>
                            ) : (
                              <span>{f.team || "-"}</span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="font-mono" style={{ color: "var(--status-success)", fontWeight: "700", whiteSpace: "nowrap" }}>
                        {formatOfferAmount(f.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
          </div>
        )}
      </div>
    </div>
  );
}
