import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { toQuery } from "../utils/query";
import { MEDIA_BASE, setArtThumbUrl, fetchMediaManifest } from "../services/media.service";
import { getAllSetsDB, getAllEditionsDB, getAllIPFSDB, getAllPlaysDB } from "../services/db.service";
import { isNbaTeam, isWnbaTeam, ownedMintsColumn, ownedCountColumn } from "../utils/display.utils";
import { LeagueFilter } from "../components/LeagueFilter";
import { useUrlParam } from "../hooks/useUrlParam";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useDbData } from "../hooks/useDbData";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import { getSubeditions as getSubeditionsService } from "../services/fcl.service";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction } from "../components/OwnedFraction";
import { useOwnedPct } from "../hooks/useOwnedPct";
import setsParallels from "../../data/sets_parallels.json";
import { getSeriesInfo } from "../services/overrides.service";
import { supplyOf, otherSupplyOf, burnedOf, isRemainingSupply } from "../services/supply.service";
import { Supply } from "../components/Supply";
import { computeIpfsCoverageForSets, formatCoveragePct, buildCoverageTooltip, isMismintPlay } from "../services/ipfs.analysis";
import { getSetStatus, getSetTier, getEditionTier, isMismintSet, MIXED_TIER } from "../services/set.status";
import { parallelGroup } from "../services/parallel.groups";
import { TIER_ORDER, TIER_COLORS } from "../utils/display.utils";

import { DataTable } from "../components/DataTable";
import { SetArtPlaceholder } from "../components/SetArt";

const NO_ROWS = [];
const NO_MAP = {};

// 40x40 set-art chip beside the set name (the 512 derived square, browser
// scaled; docs/MEDIA-PIPELINE.md). The box is reserved whenever media is on, so
// the manifest and images arriving later never shift the rows; a set with
// no art (or a 404) gets the monogram stand-in once the manifest has
// answered, and stays empty while it is still loading.
function SetArtChip({ file, name, pending }) {
  const [broken, setBroken] = useState(false);
  const url = setArtThumbUrl(file);
  const showImg = Boolean(url) && !broken;
  return (
    <span aria-hidden="true" style={{ width: "40px", height: "40px", flex: "0 0 40px", borderRadius: "6px", overflow: "hidden", background: "rgba(255,255,255,0.04)", display: "inline-block", containerType: "inline-size" }}>
      {showImg ? (
        <img src={url} width="40" height="40" loading="lazy" alt="" onError={() => setBroken(true)}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (!pending && <SetArtPlaceholder name={name} mono />)}
    </span>
  );
}

async function loadSetsData() {
  const [dbSets, dbEditions, dbIPFS, dbPlays] = await Promise.all([getAllSetsDB(), getAllEditionsDB(), getAllIPFSDB(), getAllPlaysDB()]);
  // Live chain call: must not take the offline data down with it
  let subeditions = NO_MAP;
  try {
    subeditions = await getSubeditionsService();
  } catch (subErr) {
    console.warn("Failed to load subeditions from chain (offline?). Parallel counts unavailable:", subErr);
  }
  return { sets: dbSets, editions: dbEditions, ipfsRecords: dbIPFS, allPlays: dbPlays, subeditions };
}

export function Sets() {
  const { data, loading, loadError, retry } = useDbData(loadSetsData, "Could not read the sets from the local database.");
  const sets = data ? data.sets : NO_ROWS;
  const editions = data ? data.editions : NO_ROWS;
  const ipfsRecords = data ? data.ipfsRecords : NO_ROWS;
  const allPlays = data ? data.allPlays : NO_ROWS;
  const subeditions = data ? data.subeditions : NO_MAP;
  const [selectedLeague, setSelectedLeague] = useUrlParam("league", "all", ["all", "nba", "wnba", "mixed", "unknown"]);
  const owned = useAccountCollection();
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();
  const syncState = useSyncStatus();

  // setID -> cover art filename, from the media manifest (null until it
  // loads or when media is off; the chip boxes are reserved regardless)
  const [setArtByID, setSetArtByID] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchMediaManifest().then((m) => { if (alive && m && m.setArt) setSetArtByID(m.setArt); });
    return () => { alive = false; };
  }, []);

  // Deep-link filters (the homepage matrices link here): ?series=, ?tier=
  // (sets containing an edition of that tier; "Unknown" = no tier known)
  // and ?parallel= (sets containing a parallel of that size group)
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const seriesFilter = searchParams.get("series");
  const tierFilter = searchParams.get("tier");
  const parallelFilter = searchParams.get("parallel");
  const DEEP_LINK_KEYS = ["series", "tier", "parallel"];

  // Find total mints and subedition breakdowns offline
  const getSetMintMetrics = (setEditions, setID, numEditions) => {
    const totalMints = setEditions.reduce((sum, ed) => sum + supplyOf(ed.momentCount, setID, ed.playID), 0);
    const totalOther = setEditions.reduce((sum, ed) => sum + otherSupplyOf(ed.momentCount, setID, ed.playID), 0);

    const subIDs = setsParallels[String(setID)] || [];
    if (subIDs.length === 0) {
      return { totalMints, totalOther, subMintsSum: 0, breakdown: null };
    }

    let subMintsSum = 0;
    const breakdown = subIDs.map((subID) => {
      const subInfo = subeditions[subID] || { name: `Subedition ${subID}`, mintCount: 0 };
      // The parallel run is a fixed size per play; burns come off it per edition
      const totalSubMintsForSet = subInfo.mintCount * numEditions
        - (isRemainingSupply() ? setEditions.reduce((s, ed) => s + burnedOf(setID, ed.playID, subID), 0) : 0);
      subMintsSum += totalSubMintsForSet;
      return {
        id: subID,
        name: subInfo.name,
        mintCountPerPlay: subInfo.mintCount,
        totalMints: totalSubMintsForSet
      };
    });

    return {
      totalMints,
      totalOther,
      subMintsSum,
      breakdown
    };
  };

  // Drops the deep-link filters; the league tab stays
  const handleClearFilter = () => {
    const params = new URLSearchParams(window.location.search);
    DEEP_LINK_KEYS.forEach((k) => params.delete(k));
    const qs = toQuery(params);
    navigate({ pathname: window.location.pathname, search: qs ? `?${qs}` : "" }, { replace: true });
  };

  // 3. Define columns for Sets table
  const columns = useMemo(() => {
    return [
      { key: "idCell", text: "ID" },
      // Filtering to one series makes the column a single repeated value
      ...(seriesFilter ? [] : [{ key: "seriesName", text: "Series" }]),
      { key: "name", text: "Set Name" },
      // Rarest first; "Mixed" (editions carry different tiers) after the
      // tiers, unknown last
      { key: "tierCell", text: "Tier", sortValue: (_val, rec) => rec.tierSort },
      { key: "leagueCell", text: "League", sortValue: (_val, rec) => rec.league || "" },
      ownedCountColumn({ key: "playsCount", text: "Editions", totalField: "playsCountSort", ownedField: "ownedEditions", accountMode }),
      ownedMintsColumn({ key: "totalMintsFormatted", text: isRemainingSupply() ? "Remaining" : "Mints", totalField: "totalMints", ownedField: "ownedMoments", accountMode, pctMode }),
      { key: "parallels", text: "Subeditions" },
      // 2 = burned, 1 = closed (mirrors the on-chain locked boolean), 0 = open
      { key: "status", text: "Status", align: "center", sortValue: (_val, rec) => (rec.burned ? 2 : rec.locked ? 1 : 0) },
      { key: "retiredPct", text: "Retired", align: "right", sortValue: (_val, rec) => (rec.retiredPctSort === null ? -1 : rec.retiredPctSort) },
      { key: "ipfsCell", text: "IPFS", align: "right", sortValue: (_val, rec) => (rec.ipfsPct === null ? -1 : rec.ipfsPct) }
    ];
  }, [seriesFilter, accountMode, pctMode]);

  // Per-set IPFS media coverage vs. the set's series-era expectation
  const ipfsCoverageBySet = useMemo(() => {
    return computeIpfsCoverageForSets(sets, ipfsRecords);
  }, [sets, ipfsRecords]);

  // League classification per set: NBA/WNBA only when every play in the set
  // resolves cleanly to that league; MIXED only when BOTH leagues are
  // confirmed present; UNKNOWN when the league cannot be determined (plays
  // with missing/unrecognized team data, e.g. zero-mint sets)
  const setLeagueMap = useMemo(() => {
    const playLeague = new Map();
    allPlays.forEach((p) => {
      let league = null;
      if (p.TeamAtMoment) {
        if (isWnbaTeam(p.TeamAtMoment)) league = "WNBA";
        else if (isNbaTeam(p.TeamAtMoment)) league = "NBA";
      }
      playLeague.set(String(Number(p.playID)), league);
    });

    const map = new Map();
    sets.forEach((set) => {
      const playIDs = set.playIDs || [];
      let hasNBA = false, hasWNBA = false, hasUnknown = false;
      playIDs.forEach((pid) => {
        const league = playLeague.get(String(Number(pid)));
        if (league === "NBA") hasNBA = true;
        else if (league === "WNBA") hasWNBA = true;
        else hasUnknown = true;
      });

      let league = "UNKNOWN";
      if (playIDs.length > 0) {
        if (hasNBA && hasWNBA) league = "MIXED";
        else if (hasNBA && !hasUnknown) league = "NBA";
        else if (hasWNBA && !hasUnknown) league = "WNBA";
      }
      map.set(Number(set.id), league);
    });
    return map;
  }, [sets, allPlays]);

  // Sets within the active series filter (league counts reflect this scope).
  // Mismint sets (empty duplicates the contract created by mistake) are
  // hidden outright; they stay reachable by URL.
  const seriesSets = useMemo(() => {
    const hasTier = (set) => (tierFilter === "Unknown"
      ? getSetTier(set.id, set.playIDs) === null
      : (set.playIDs || []).some((p) => getEditionTier(set.id, p) === tierFilter));
    const hasParallel = (set) => (setsParallels[String(set.id)] || []).some((subID) => {
      const n = Number((subeditions[subID] || {}).mintCount) || 0;
      return n > 0 && parallelGroup(n) === parallelFilter;
    });
    return sets.filter((set) => !isMismintSet(set.id)
      && (!seriesFilter || String(set.series) === String(seriesFilter))
      && (!tierFilter || hasTier(set))
      && (!parallelFilter || hasParallel(set)));
  }, [sets, seriesFilter, tierFilter, parallelFilter, subeditions]);

  const leagueCounts = useMemo(() => {
    const counts = { nba: 0, wnba: 0, mixed: 0, unknown: 0 };
    seriesSets.forEach((set) => {
      const league = setLeagueMap.get(Number(set.id));
      if (league === "NBA") counts.nba++;
      else if (league === "WNBA") counts.wnba++;
      else if (league === "MIXED") counts.mixed++;
      else counts.unknown++;
    });
    return counts;
  }, [seriesSets, setLeagueMap]);

  // Zero-count league options are hidden below; if the active selection
  // becomes one of them (e.g. after a series filter change), fall back to All
  useEffect(() => {
    if (selectedLeague !== "all" && (leagueCounts[selectedLeague] ?? 0) === 0) {
      setSelectedLeague("all");
    }
  }, [selectedLeague, leagueCounts, setSelectedLeague]);

  // 4. Map sets into table records
  const tableRecords = useMemo(() => {
    const filteredSets = seriesSets.filter((set) => {
      if (selectedLeague === "nba") return setLeagueMap.get(Number(set.id)) === "NBA";
      if (selectedLeague === "wnba") return setLeagueMap.get(Number(set.id)) === "WNBA";
      if (selectedLeague === "mixed") return setLeagueMap.get(Number(set.id)) === "MIXED";
      if (selectedLeague === "unknown") return setLeagueMap.get(Number(set.id)) === "UNKNOWN";
      return true;
    });

    // Group editions by set once instead of filtering the full list per row
    const editionsBySet = new Map();
    editions.forEach((ed) => {
      const sID = Number(ed.setID !== undefined ? ed.setID : ed.setid);
      if (!editionsBySet.has(sID)) editionsBySet.set(sID, []);
      editionsBySet.get(sID).push(ed);
    });

    return filteredSets.map((set) => {
      // Mismint plays (plays_exclude.json) are not real editions: keep them
      // out of the Editions denominator and the mint/retired math
      const numPlays = (set.playIDs || []).filter((p) => !isMismintPlay(p)).length;
      const setEditions = (editionsBySet.get(Number(set.id)) || []).filter((ed) => !isMismintPlay(ed.playID));
      const metrics = getSetMintMetrics(setEditions, set.id, numPlays);
      const status = getSetStatus(set.id);

      // Whole-set tier from the additions files; "Mixed" when the editions
      // carry different tiers (the Anthology sets, NBA Cup, ...)
      const tier = getSetTier(set.id, set.playIDs);
      const tierSort = tier === null ? TIER_ORDER.length + 1 : tier === MIXED_TIER ? TIER_ORDER.length : TIER_ORDER.indexOf(tier);
      const tierCell = tier === null ? (
        <span className="text-muted">-</span>
      ) : tier === MIXED_TIER ? (
        <span className="text-muted" title="Editions in this set carry different tiers" style={{ cursor: "help" }}>Mixed</span>
      ) : (
        <span style={{ color: TIER_COLORS[tier] || "inherit", fontWeight: "600" }}>{tier}</span>
      );

      const idCell = (
        <Link to={`/sets/${set.id}`} className="font-mono set-id-badge" style={{ display: "inline-block" }}>
          {set.id}
        </Link>
      );

      const seriesInfo = getSeriesInfo(set.series);
      const seriesName = seriesInfo ? seriesInfo.name : `Series ${set.series}`;

      const league = setLeagueMap.get(Number(set.id)) || "UNKNOWN";
      const leagueCell = league === "NBA" ? (
        <span className="badge badge-nba">NBA</span>
      ) : league === "WNBA" ? (
        <span className="badge badge-wnba">WNBA</span>
      ) : league === "MIXED" ? (
        <span className="badge" title="Confirmed players from both leagues" style={{ background: "rgba(245, 158, 11, 0.12)", color: "var(--status-mismint)", cursor: "help" }}>
          BOTH
        </span>
      ) : (
        <span className="badge" title="League could not be determined: the set has plays with missing or unrecognized team data (often zero-mint sets)" style={{ background: "rgba(255,255,255,0.06)", color: "var(--text-muted)", cursor: "help" }}>
          UNKNOWN
        </span>
      );

      const nameCell = (
        <Link to={`/sets/${set.id}`} style={{ fontWeight: "600", color: "#fff", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "10px" }} className="player-detail-link font-hover-glow">
          {MEDIA_BASE && <SetArtChip file={setArtByID ? setArtByID[String(set.id)] : null} pending={!setArtByID} name={set.setName} />}
          {set.setName}
        </Link>
      );

      // Closed = lock icon (hidden text keeps it searchable); open = plain
      // text, because 🔒 and 🔓 look too similar at a glance
      const statusBadge = status.burned ? (
        <span className="badge badge-danger" title={`Every moment in this set was burned by Top Shot on ${status.burned}`} style={{ cursor: "help" }}>
          Burned
        </span>
      ) : set.locked ? (
        <span title="Closed" style={{ cursor: "help" }}>
          <span style={{ display: "none" }}>closed</span>
          🔒
        </span>
      ) : (
        <span title="Open" style={{ color: "var(--status-success)", fontWeight: "600", fontSize: "0.75rem", letterSpacing: "0.5px" }}>
          OPEN
        </span>
      );

      // Wrap subedition names at two per line so a set with many parallels
      // cannot widen the whole table
      let parallelsText = "-";
      if (metrics.breakdown) {
        const names = metrics.breakdown.map((sub) => sub.name);
        const lines = [];
        for (let i = 0; i < names.length; i += 2) {
          lines.push(names.slice(i, i + 2).join(", "));
        }
        parallelsText = (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {lines.map((line, idx) => (
              <span key={idx}>{line}</span>
            ))}
          </div>
        );
      }

      const totalEditionsCount = setEditions.length;
      const retiredCount = setEditions.filter((ed) => ed.retired).length;
      const retiredPercentage = totalEditionsCount > 0 ? (retiredCount / totalEditionsCount) * 100 : 0;

      // Number-only with color carrying the complete/incomplete signal
      let retiredPct = "-";
      let retiredPctSort = null;
      if (totalEditionsCount > 0) {
        const pctStr = retiredPercentage % 1 === 0 ? retiredPercentage.toFixed(0) : retiredPercentage.toFixed(1);
        retiredPctSort = retiredPercentage;
        retiredPct = (
          <span style={{ color: retiredPercentage === 100 ? "var(--status-success)" : "var(--status-mismint)", fontWeight: "600" }}>
            {pctStr}%
          </span>
        );
      }

      // IPFS media coverage cell: headline % scores the core four (Hero,
      // Player, Video, Video Square); the muted +N counts extra media types
      // the set carries beyond that standard. Hover for the full breakdown.
      const coverage = ipfsCoverageBySet.get(Number(set.id));
      const ipfsPct = coverage ? coverage.pct : null;
      let ipfsCell = "-";
      if (ipfsPct !== null) {
        const ipfsColor = ipfsPct >= 100 ? "var(--status-success)" : ipfsPct === 0 ? "var(--status-danger)" : "var(--status-mismint)";
        ipfsCell = (
          <span title={buildCoverageTooltip(coverage)} style={{ cursor: "help", whiteSpace: "nowrap" }}>
            <span style={{ color: ipfsColor, fontWeight: "600" }}>{formatCoveragePct(ipfsPct)}%</span>
            {coverage.extrasCount > 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginLeft: "4px" }}>+{coverage.extrasCount}</span>
            )}
          </span>
        );
      }

      // Owned-as-account annotations: distinct editions owned of this set
      // (green when the set is complete) and moments owned (never green;
      // 150 copies of one LeBron is not the set)
      const ownedSet = owned ? owned.index?.bySet.get(Number(set.id)) : null;
      const ownedEditions = ownedSet ? ownedSet.editions.size : 0;
      const ownedMoments = ownedSet ? ownedSet.count : 0;

      return {
        ...set,
        idCell,
        seriesName,
        name: nameCell,
        status: statusBadge,
        playsCount: owned
          ? <OwnedFraction owned={ownedEditions} total={numPlays} greenWhenFull title={`${ownedEditions} of ${numPlays} editions owned`} />
          : numPlays,
        playsCountSort: numPlays,
        ownedEditions,
        ownedMoments,
        totalMints: metrics.totalMints,
        // A burned set keeps the chain's original count, struck through: the
        // contract never decrements numMinted, and none of them survive
        totalMintsFormatted: status.burned ? (
          <span title={`${metrics.totalMints.toLocaleString()} minted, all burned on ${status.burned}`} style={{ textDecoration: "line-through", color: "var(--text-muted)", cursor: "help" }}>
            {metrics.totalMints.toLocaleString()}
          </span>
        ) : owned ? (
          <OwnedFraction owned={ownedMoments} total={metrics.totalMints} pct={pctMode} title={`${ownedMoments.toLocaleString()} of ${metrics.totalMints.toLocaleString()} moments owned`} />
        ) : <Supply shown={metrics.totalMints} other={metrics.totalOther} />,
        burned: status.burned,
        tierCell,
        tierSort,
        parallels: parallelsText,
        retiredPct,
        retiredPctSort,
        ipfsCell,
        ipfsPct,
        league,
        leagueCell
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesSets, editions, subeditions, selectedLeague, setLeagueMap, ipfsCoverageBySet, owned, pctMode, setArtByID]);

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={retry} />;
  }

  if (loading) {
    return <Loader message="Loading sets from local database..." />;
  }

  return (
    <div className="sets-page-container">
      <div className="glass-panel info-banner">
        <div className="d-flex justify-between align-center flex-wrap gap-10">
          <div>
            <h2>Sets</h2>
            <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
              Every set, its editions and mint counts, and how much of its media is on IPFS. Open a set to see
              each edition's video and artwork.
            </p>
          </div>
        </div>
      </div>

      {/* In-page sync progress only in the empty state: unmounting it once
          the table is up would jump the whole page, and the navbar pill
          already shows sync status */}
      {syncState.isSyncing && sets.length === 0 && (
        <div className="glass-panel" style={{ background: "rgba(139, 92, 246, 0.05)", borderColor: "var(--primary)" }}>
          <div className="d-flex justify-between" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
            <span className="text-muted">Syncing from the Flow Blockchain: <strong>{syncState.stage}</strong></span>
            <span>{syncState.progressPercent}%</span>
          </div>
          <div className="sync-bar-container">
            <div className="sync-bar-fill" style={{ width: `${syncState.progressPercent}%` }}></div>
          </div>
        </div>
      )}

      {sets.length === 0 ? (
        <div className="glass-panel text-center" style={{ padding: "40px" }}>
          <p className="text-muted">Loading sets from the Flow Blockchain...</p>
        </div>
      ) : (
        <div className="glass-panel mt-20 table-panel">
          <LeagueFilter
            options={[
              { value: "all", label: "All", count: seriesSets.length },
              { value: "nba", label: "NBA", count: leagueCounts.nba },
              { value: "wnba", label: "WNBA", count: leagueCounts.wnba },
              { value: "mixed", label: "Both", count: leagueCounts.mixed, title: "Sets with confirmed players from both leagues" },
              { value: "unknown", label: "Unknown", count: leagueCounts.unknown, title: "Sets whose league cannot be determined: plays with missing or unrecognized team data (often zero-mint sets)" }
            ].filter((opt) => opt.value === "all" || opt.count > 0)}
            selected={selectedLeague}
            onSelect={setSelectedLeague}
          />
          {(seriesFilter || tierFilter || parallelFilter) && (
            <div className="series-filter-indicator">
              <span>Displaying Sets for <strong>{[
                seriesFilter ? `${(getSeriesInfo(seriesFilter) || {}).name || `Series ${seriesFilter}`} (S${seriesFilter})` : "",
                tierFilter ? (tierFilter === "Unknown" ? "no known tier" : `${tierFilter} tier`) : "",
                parallelFilter ? `parallels of ${parallelFilter}` : ""
              ].filter(Boolean).join(" · ")}</strong></span>
              <button onClick={handleClearFilter} className="clear-filter-inline">Show All Sets ✖</button>
            </div>
          )}
          <DataTable
            columns={columns}
            records={tableRecords}
            defaultSortColumn="id"
            defaultSortOrder="asc"
          />
        </div>
      )}

      <style>{`
        .set-id-badge {
          font-family: var(--font-mono);
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 600;
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
        .series-filter-indicator {
          background: rgba(139, 92, 246, 0.05);
          border: 1px solid rgba(139, 92, 246, 0.15);
          padding: 12px 18px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
          font-size: 0.95rem;
          color: #fff;
        }
        .clear-filter-inline {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.8rem;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .clear-filter-inline:hover {
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }
      `}</style>
    </div>
  );
}
