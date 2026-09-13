import { editionBadges } from "../services/autograph.service";
import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getRecord, getSetEditionsDB, getSetIPFSDB, getAllPlaysDB } from "../services/db.service";
import {
  CORE_MEDIA_FIELDS,
  computeSetCoverage,
  getMediaTypeLabel,
  mediaCounts,
  isMismintPlay,
  formatCoveragePct
} from "../services/ipfs.analysis";
import { getSubeditions as getSubeditionsService, getSetDetails } from "../services/fcl.service";
import { supplyOf, otherSupplyOf, supplyLabel, isRemainingSupply } from "../services/supply.service";
import { Supply, SupplyWord } from "../components/Supply";
import { applySetOverrides, applyPlayOverrides, applyEditionOverrides, buildTsdIndex, buildMintClock, getCalculatedPlayTags, editionTags, withTags } from "../services/overrides.service";
import { Badges } from "../components/Badges";
import { editionSortKey, playerPath } from "../utils/display.utils";
import { harmonizePlayerProfiles } from "../services/relationship.service";
import { DataTable } from "../components/DataTable";
import { MediaOverlay } from "../components/MediaOverlay";
import { MediaStack } from "../components/MediaStack";
import { mapSetDetailsToRecords } from "../services/sync.coordinator";
import { useSyncStatus, useReloadOnSyncComplete } from "../hooks/useSyncStatus";
import { useLoad } from "../hooks/useLoad";
import { LoadError } from "../components/LoadError";
import { Loader } from "../components/Loader";
import setsParallels from "../../data/sets_parallels.json";
import teamsAdditions from "../../data/additions/teams.json";
import { commentaryFor, withCommentary } from "../services/commentary.service";
import { getSetStatus, getEditionTier } from "../services/set.status";
import { CubeOverlay } from "../components/CubeOverlay";
import { useIpfsMedia } from "../hooks/useIpfsMedia";
import { getMediaInfo } from "../services/ipfs.media";
import { generateSetArt } from "../services/ipfs.generate";
import { setArtThumbUrl, fetchMediaManifest } from "../services/media.service";
import { CubeTrigger } from "../components/MomentCube";
import { buildCubeConfig, cubeFaceFor, cubeThumbFor, resolveCubeFace } from "../services/cube.service";
import { SetArtPlaceholder } from "../components/SetArt";
import { isSilhouette } from "../services/ipfs.silhouette";
import { DynamicPhotoButton } from "../components/DynamicPhotoButton";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { OwnedFraction, OwnedPctToggle } from "../components/OwnedFraction";
import { OwnedStat, OwnedStrip, OwnedSpecials } from "../components/OwnedSummaryBanner";
import { loadAccountLocks } from "../services/account.locks";
import { useOwnedPct } from "../hooks/useOwnedPct";
import { useUrlParam } from "../hooks/useUrlParam";
import { serialKinds, playSerialFacts, runSizeFor } from "../utils/serials.utils";

const findTeamIdByName = (teamName) => {
  if (!teamName) return "";
  const nameToSearch = String(teamName).trim().toLowerCase();
  const matchedId = Object.keys(teamsAdditions).find((id) => {
    const team = teamsAdditions[id];
    return team.name && team.name.trim().toLowerCase() === nameToSearch;
  });
  return matchedId || "";
};

export function SetDetail() {
  const { setID } = useParams();
  const [setMeta, setSetMeta] = useState(null);
  const [editions, setEditions] = useState([]);
  const [ipfsRecords, setIpfsRecords] = useState([]);
  const [subeditions, setSubeditions] = useState({});
  const [plays, setPlays] = useState([]);
  const syncState = useSyncStatus();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [overlayMedia, setOverlayMedia] = useState(null);
  const [cubeOverlay, setCubeOverlay] = useState(null);
  // Header set artwork, generated in the browser: { cid, url|null on failure }
  const [headerArt, setHeaderArt] = useState(null);
  // The media host's 512 set-art squares (docs/MEDIA-PIPELINE.md; one manifest
  // per session): this set's file is undefined while the manifest loads
  // and null when it has none. Shown before any in-browser generation,
  // which fetches a multi-MB hero. A 404 is remembered per file, so no
  // state needs resetting when the set changes.
  const [setArtManifest, setSetArtManifest] = useState(null);
  const [brokenSetArtFile, setBrokenSetArtFile] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchMediaManifest().then((m) => { if (alive) setSetArtManifest((m && m.setArt) || {}); });
    return () => { alive = false; };
  }, []);
  const setArtFile = setArtManifest === null ? undefined : (setArtManifest[String(Number(setID))] || null);
  const setArtThumbBroken = Boolean(setArtFile) && brokenSetArtFile === setArtFile;
  const needsGeneratedArt = setArtFile === null || setArtThumbBroken;
  // Subedition rows are folded into one row per play by default; unchecking
  // expands every play at once, and clicking a row expands just that one.
  const [collapseSubeditions, setCollapseSubeditions] = useState(true);
  const [runtimeSilhouettes, setRuntimeSilhouettes] = useState(() => new Set());
  const [expandedPlays, setExpandedPlays] = useState(() => new Set());
  // Lazy per-CID media metadata (dimensions, duration, size, dead CIDs)
  const ipfsMedia = useIpfsMedia();
  // Browsing as an account: Minted becomes owned/total, honouring the
  // app-wide %-view toggle like every other Mints column
  const owned = useAccountCollection();

  // Lock states of the account's moments in THIS set: the account page's
  // cached whole-collection map when it has a fresh one, else one registry
  // call for just these ids (a set is a few hundred at most)
  const [lockMap, setLockMap] = useState(null);
  const ownedIndex = owned ? owned.index : null;
  const ownedAddress = owned ? owned.address : null;
  const setMomentIDs = useMemo(() => {
    if (!ownedIndex) return [];
    const prefix = `${Number(setID)}_`;
    const out = [];
    ownedIndex.ids.forEach((list, key) => { if (key.startsWith(prefix)) out.push(...list); });
    return out;
  }, [ownedIndex, setID]);
  useEffect(() => {
    if (!ownedAddress || setMomentIDs.length === 0) return undefined;
    let cancelled = false;
    loadAccountLocks(ownedAddress, setMomentIDs, { persist: false, shouldAbort: () => cancelled })
      .then((map) => { if (map && !cancelled) setLockMap(map); })
      .catch((err) => console.warn("lock data unavailable:", err));
    return () => { cancelled = true; };
  }, [ownedAddress, setMomentIDs]);
  const accountMode = Boolean(owned);
  const pctMode = useOwnedPct();
  // ?ipfs=missing narrows the table to editions missing a core file: a
  // link to hand to Dapper Labs' media team with the gaps already
  // isolated. Mirrored in the URL so the link carries the view.
  const [ipfsView, setIpfsView] = useUrlParam("ipfs", null, ["missing"]);

  // Guards against a stale async load (fast navigation between sets)
  // overwriting the newer set's state
  const loadSeqRef = useRef(0);

  // 2. Load data offline-first from IndexedDB, falling back to a live
  // on-chain query only when the set is not synced locally yet
  // reset: a new URL (set) clears the previous set's data first, so a
  // failed load never shows the prior record under the new URL; a reload
  // after a sync pass keeps the page as is while it refreshes
  const loadData = async ({ reset = false } = {}) => {
    const seq = ++loadSeqRef.current;
    const isStale = () => seq !== loadSeqRef.current;
    if (reset) {
      setLoading(true);
      setLoadError("");
      setSetMeta(null);
      setEditions([]);
      setIpfsRecords([]);
      setPlays([]);
    }

    try {
      // Both branches produce the same shape; ONE commit block below, so
      // the offline and live paths can never drift apart
      let loaded = null;

      let meta = await getRecord("sets", Number(setID));
      if (!meta) {
        meta = await getRecord("sets", String(setID));
      }

      if (meta) {
        const [dbSetEditions, dbSetIPFS, dbPlays] = await Promise.all([
          getSetEditionsDB(Number(setID)),
          getSetIPFSDB(Number(setID)),
          getAllPlaysDB()
        ]);
        loaded = { meta, editions: dbSetEditions, ipfs: dbSetIPFS, plays: harmonizePlayerProfiles(dbPlays) };
      } else {
        // Fallback: set missing locally (e.g. brand new on-chain), query
        // live. The response maps through the sync coordinator's own
        // record mapper; edition overrides applied here because this data
        // bypasses the DB read path that normally applies them.
        const onChainData = await getSetDetails(Number(setID));
        if (onChainData) {
          const liveMeta = applySetOverrides({
            id: onChainData.id,
            setName: onChainData.setName,
            series: onChainData.series,
            locked: onChainData.locked,
            playIDs: onChainData.editions.map(ed => ed.playID)
          });
          const { editions: rawEditions, ipfsRecords: ipfsData } = mapSetDetailsToRecords(onChainData);
          const playsData = onChainData.plays.map(p => applyPlayOverrides({ playID: p.playID, ...p.metadata }));
          loaded = {
            meta: liveMeta,
            editions: rawEditions.map(applyEditionOverrides),
            ipfs: ipfsData,
            plays: harmonizePlayerProfiles(playsData)
          };
        }
      }

      if (!loaded || isStale()) return;
      setSetMeta(loaded.meta);
      setEditions(loaded.editions);
      setIpfsRecords(loaded.ipfs);
      setPlays(loaded.plays);

      // Live chain call: must not take the offline data down with it
      try {
        const subs = await getSubeditionsService();
        if (!isStale()) setSubeditions(subs);
      } catch (subErr) {
        console.warn("Failed to load subeditions from chain (offline?). Parallel counts unavailable:", subErr);
      }
    } catch (err) {
      if (isStale()) return;
      console.error("Failed to load set details:", err);
      setLoadError("Could not load this set from the local database or the chain.");
    } finally {
      if (!isStale()) setLoading(false);
    }
  };

  useLoad(() => loadData({ reset: true }), [setID]);
  useReloadOnSyncComplete(loadData);

  // Determine if this set has subeditions (parallels)
  const associatedSubIDs = useMemo(() => {
    return setsParallels[String(setID)] || [];
  }, [setID]);

  const hasSubeditions = associatedSubIDs.length > 0;

  // IPFS media coverage for this set (core-four headline, extras listed
  // separately; mismint editions excluded, dead CIDs count as missing)
  const ipfsCoverage = useMemo(() => {
    if (editions.length === 0) return null;
    return computeSetCoverage(
      editions.map((ed) => ed.playID),
      ipfsRecords
    );
  }, [editions, ipfsRecords]);

  // Deterministic hero for the header set artwork, from editions whose
  // hero is live and actually contains the cube render (full-bleed heroes
  // are raw play photos, flagged in the media lookup, and hold no set
  // art). Team-art sets vary by team, so prefer the same representatives
  // as the offline extractor: Raptors then Lakers (WNBA sets: Las Vegas
  // Aces then Indiana Fever), else the first usable hero in play order.
  const setArtHeroCid = useMemo(() => {
    if (!ipfsMedia || editions.length === 0) return null;
    const heroByPlay = new Map(ipfsRecords.map((r) => [Number(r.playID), r.cids?.HERO]));
    const teamByPlay = new Map(plays.map((p) => [Number(p.playID), (p.TeamAtMoment || "").trim()]));
    const usable = [];
    for (const ed of editions) {
      const cid = heroByPlay.get(Number(ed.playID));
      if (!cid) continue;
      const info = getMediaInfo(cid); // null = dead at the gateway or unprobed
      if (!info || info.kind !== "image" || info.fullBleed) continue;
      usable.push({ cid, team: teamByPlay.get(Number(ed.playID)) || "" });
    }
    if (usable.length === 0) return null;
    const prefTeams = /wnba/i.test(setMeta?.setName || "")
      ? ["Las Vegas Aces", "Indiana Fever"]
      : ["Toronto Raptors", "Los Angeles Lakers"];
    for (const team of prefTeams) {
      const hit = usable.find((u) => u.team === team);
      if (hit) return hit.cid;
    }
    return usable[0].cid;
  }, [ipfsMedia, editions, ipfsRecords, plays, setMeta?.setName]);

  useEffect(() => {
    if (!needsGeneratedArt || !setArtHeroCid || setMeta?.series == null) return undefined;
    let cancelled = false;
    generateSetArt(`https://ipfs.dapperlabs.com/ipfs/${setArtHeroCid}`, setMeta?.series)
      .then((res) => { if (!cancelled) setHeaderArt({ cid: setArtHeroCid, url: res.url }); })
      .catch((err) => {
        console.warn("header set art generation failed:", err);
        if (!cancelled) setHeaderArt({ cid: setArtHeroCid, url: null });
      });
    return () => { cancelled = true; };
  }, [needsGeneratedArt, setArtHeroCid, setMeta?.series]);

  // Silhouette fallback for PLAYER CIDs the baked lookup has never seen
  // (editions minted after the last probe run, so a stale deploy still
  // offers the dynamic-photo rebuild). isSilhouette caches verdicts in
  // localStorage, so only genuinely new CIDs ever cost a fetch, once per
  // browser. Only positive verdicts are kept: everything else leaves the
  // row rendering exactly as it would without this.
  const silhouetteCandidates = useMemo(() => {
    if (!ipfsMedia || !(Number(setMeta?.series) >= 7)) return [];
    const list = [];
    ipfsRecords.forEach((rec) => {
      const cids = rec.cids || {};
      if (!cids.PLAYER || !cids.HERO) return;
      if (ipfsMedia.media[cids.PLAYER] !== undefined) return; // baked data answers
      if (ipfsMedia.media[cids.HERO] === 0) return; // hero dead: nothing to rebuild from
      list.push(cids.PLAYER);
    });
    return list;
  }, [ipfsMedia, ipfsRecords, setMeta?.series]);

  useEffect(() => {
    if (silhouetteCandidates.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      // Sequential on purpose: cached verdicts resolve instantly, and a
      // stale deploy should trickle its image fetches, not burst them
      for (const cid of silhouetteCandidates) {
        const verdict = await isSilhouette(cid, `https://ipfs.dapperlabs.com/ipfs/${cid}`);
        if (cancelled) return;
        if (verdict) setRuntimeSilhouettes((prev) => new Set(prev).add(cid));
      }
    })();
    return () => { cancelled = true; };
  }, [silhouetteCandidates]);

  // Ownership summary for the browsed account: what the context address
  // owns of THIS set, per variant (Standard + each parallel): moment
  // count, distinct-edition coverage, complete copies (minimum quantity
  // across every edition), the average serial of the best copy (lowest
  // owned serial per edition), and any special serials owned. Mismint
  // editions never count, same as the header stats.
  // Shared per-play lookup maps: the owned summary and the row builder both
  // need them, and each used to linear-scan the full arrays per edition
  const playByID = useMemo(() => new Map(plays.map((p) => [Number(p.playID), p])), [plays]);
  const ipfsByPlay = useMemo(() => new Map(ipfsRecords.map((r) => [Number(r.playID), r])), [ipfsRecords]);

  const ownedSetSummary = useMemo(() => {
    if (!owned?.index || editions.length === 0) return null;
    const statEds = editions.filter((ed) => !isMismintPlay(ed.playID));
    if (statEds.length === 0) return null;
    const series = setMeta?.series != null ? Number(setMeta.series) : null;
    const variants = [0, ...associatedSubIDs.map(Number)];
    // Serial facts are per play, not per variant: computed once instead of
    // once per parallel per edition
    const factsByPlay = new Map();
    statEds.forEach((ed) => {
      const raw = playByID.get(Number(ed.playID));
      factsByPlay.set(Number(ed.playID), raw ? playSerialFacts(applyPlayOverrides({ playID: ed.playID, ...raw })) : {});
    });
    let totalOwned = 0;
    const specialCounts = {};
    const perVariant = [];
    variants.forEach((sub) => {
      let ownedEditions = 0;
      let count = 0;
      let bestSum = 0;
      let copies = Infinity;
      let locked = 0;
      let lockedEditions = 0;
      let lockedSets = Infinity;
      statEds.forEach((ed) => {
        const key = `${Number(setID)}_${Number(ed.playID)}_${sub}`;
        const list = owned.index.serials.get(key) || [];
        count += list.length;
        copies = Math.min(copies, list.length);
        // Locked = in the locking registry, expired-but-not-unlocked included
        const lockedHere = lockMap ? (owned.index.ids.get(key) || []).filter((id) => lockMap.has(id)).length : 0;
        locked += lockedHere;
        lockedSets = Math.min(lockedSets, lockedHere);
        if (lockedHere > 0) lockedEditions++;
        if (list.length === 0) return;
        ownedEditions++;
        bestSum += Math.min(...list.map(Number));
        const pf = factsByPlay.get(Number(ed.playID)) || {};
        const runSize = runSizeFor(setID, sub, ed.momentCount);
        list.forEach((s) => serialKinds(Number(s), pf, runSize, series).forEach((k) => {
          specialCounts[k] = (specialCounts[k] || 0) + 1;
        }));
      });
      totalOwned += count;
      if (count > 0) {
        perVariant.push({
          sub,
          count,
          ownedEditions,
          totalEditions: statEds.length,
          completeCopies: copies === Infinity ? 0 : copies,
          avgBestSerial: Math.round(bestSum / ownedEditions),
          locked,
          lockedEditions,
          lockedSets: lockedSets === Infinity ? 0 : lockedSets
        });
      }
    });
    return { totalOwned, perVariant, specialCounts };
  }, [owned, editions, playByID, associatedSubIDs, setID, setMeta, lockMap]);

  // Columns definition (dynamically append IPFS columns)
  const columns = useMemo(() => {
    const baseCols = [
      { key: "editionID", text: "Edition ID", sortValue: (_val, rec) => rec.editionSortKey },
      // The interactive 3D cube gets its own column (a thumbnail will
      // join it later); icon cells centre under the heading
      {
        key: "cube",
        text: "Cube",
        align: "center",
        sortValue: (_val, rec) => (rec.hasCube ? 1 : 0),
        filterValue: (_val, rec) => (rec.hasCube ? 1 : 0),
        filterTitle: "1 = has an interactive cube (square video, or a player photo when the edition has none), 0 = none"
      },
      { key: "fullName", text: "Full Name" }
    ];

    if (hasSubeditions) {
      baseCols.push(
        collapseSubeditions ? {
          key: "subeditionName",
          text: "Subeditions",
          // Collapsed rows show how many subeditions they fold up, so numeric
          // filters compare against that count. Child rows of an expanded play
          // carry no count and are skipped by them.
          filterValue: (_val, rec) => rec.subeditionCount,
          sortValue: (_val, rec) => rec.subeditionCount,
          filterTitle: "Filter by how many subeditions a play has (e.g. >2). Uncheck \"Collapse subeditions\" to filter by subedition name or id instead."
        } : {
          key: "subeditionName",
          text: "Subedition",
          // The cell renders the subedition's name, so numeric filters would
          // otherwise have no number to compare. Aiming them at the id makes
          // ">0" mean every parallel and "0" mean the Standard rows.
          filterValue: (_val, rec) => rec.subeditionID,
          filterTitle: "Filter by name (e.g. Rare), or by subedition id: >0 for every parallel, 0 for Standard"
        }
      );
    }

    baseCols.push(
      {
        key: "totalMinted",
        text: supplyLabel(),
        // In account mode the fraction sorts and filters on the OWNED
        // numerator, per the app-wide rule, except % view sorts by the
        // percentage (also app-wide)
        sortValue: (_val, rec) => (accountMode
          ? (pctMode
            ? (rec.totalMintedRaw > 0 ? (rec.ownedMinted || 0) / rec.totalMintedRaw : 0)
            : (rec.ownedMinted || 0))
          : rec.totalMintedRaw),
        filterValue: (_val, rec) => (accountMode ? (rec.ownedMinted || 0) : rec.totalMintedRaw),
        headerControl: accountMode ? <OwnedPctToggle /> : undefined,
        align: "right"
      },
      { key: "retired", text: "Retired", sortValue: (_val, rec) => rec.retired_flag, align: "center" }
    );

    // Single IPFS column: a fixed four-line core block (placeholder lines
    // always, red X when a core file is missing), with any extras appended
    // underneath as "+"-prefixed lines. Sorting ascending puts incomplete
    // editions on top (extras break ties); filter "<4" isolates them.
    // Present when any edition has CIDs or the coverage model exists.
    const hasAnyCids = ipfsRecords.some((rec) => rec.cids && Object.keys(rec.cids).length > 0);
    if (hasAnyCids || ipfsCoverage) {
      baseCols.push({
        key: "ipfsCore",
        text: "IPFS Media",
        // Sort: live core files first, extras as the tiebreak. Filters see
        // the plain core count so "<4" works; undefined on mismints so
        // numeric filters skip them.
        sortValue: (_val, rec) => (rec.ipfsCoreCount === undefined ? undefined : rec.ipfsCoreCount * 100 + (rec.ipfsExtrasCount || 0)),
        filterValue: (_val, rec) => rec.ipfsCoreCount,
        filterTitle: "Filter by how many of the four core files exist (e.g. <4 for incomplete, 4 for complete)"
      });
    }

    return baseCols;
  }, [ipfsRecords, ipfsCoverage, hasSubeditions, collapseSubeditions, accountMode, pctMode]);

  // Debut index and mint clock over every play in the database, for the
  // badges under names
  const tsdIndex = useMemo(() => buildTsdIndex(plays), [plays]);
  const mintClock = useMemo(() => buildMintClock(plays), [plays]);

  // Transform editions to rows with subedition splits
  const tableRecords = useMemo(() => {
    const records = [];

    // Account context: owned moments per edition (all parallels combined)
    // and per mint run (edition + subedition), from the collection index
    const ownedByEdition = owned && owned.index ? owned.index.byEdition : null;
    const ownedSerials = owned && owned.index ? owned.index.serials : null;
    // `other` is the number Settings does not show behind a shown count,
    // for the hover swap; the two are equal when nothing was burned
    const mintedCell = (ownedCount, total, other = total) => (accountMode
      ? <OwnedFraction owned={ownedCount} total={Number(total) || 0} pct={pctMode} title={`${ownedCount.toLocaleString()} of ${(Number(total) || 0).toLocaleString()} moments owned`} />
      : <Supply shown={Number(total) || 0} other={Number(other) || 0} className="font-mono" />);

    // Live at the gateway = not on the known-dead list (unknown passes)
    const isLive = (cid) => cid && !(ipfsMedia && ipfsMedia.media[cid] === 0);

    // Subedition split facts are SET-wide, not per edition: child ids in
    // display order (Standard first, parallels ascending, matching how the
    // edition id reads) and the parallels' combined mint count
    const childSubIDs = [0, ...associatedSubIDs].map(Number).sort((a, b) => a - b);
    const parallelsMintSum = associatedSubIDs.reduce(
      (sum, subID) => sum + Number((subeditions[subID] || {}).mintCount || 0),
      0
    );

    editions.forEach((edition) => {
      const playID = edition.playID;

      // Look up play metadata from offline cache to populate FullName
      const matchingPlay = playByID.get(Number(playID));
      // The play's badges, plus this edition's own (reward sets) and its
      // narrated cut
      const badges = editionBadges(withCommentary(
        withTags(matchingPlay ? getCalculatedPlayTags(matchingPlay, null, tsdIndex, mintClock) : [], editionTags(setID, playID)),
        Boolean(commentaryFor(setID, playID))
      ), setID, playID);
      let playName = `Play #${playID}`;
      if (matchingPlay) {
        if (matchingPlay.FullName && matchingPlay.FullName.trim() !== "") {
          playName = matchingPlay.FullName.trim();
        } else if (matchingPlay.TeamAtMoment && matchingPlay.TeamAtMoment.trim() !== "") {
          playName = matchingPlay.TeamAtMoment.trim();
        } else {
          playName = "Team Moment";
        }
      }

      const retiredVal = edition.retired ? "✅" : "❌";
      const retiredFlag = edition.retired ? 1 : 0;

      // Look up matching IPFS details for this setID + playID
      const ipfsRecord = ipfsByPlay.get(Number(playID)) || {};
      const cids = ipfsRecord.cids || {};

      // Owned moments of this edition, all parallels combined
      const ownedOfEdition = ownedByEdition
        ? (ownedByEdition.get(`${Number(setID)}_${Number(playID)}`) || 0)
        : 0;

      // On-the-fly player rebuild (set art now generates automatically in
      // the page header): when the PLAYER image is only a silhouette
      // (2025-26 generation), rebuild the real colour player photo from
      // the hero. A full-bleed hero is a raw play photograph (baked flag
      // from the border census): no cube to extract from, and no rebuild
      // needed since the hero already IS the full photo, so no button.
      // The button owns its busy state (components/DynamicPhotoButton), so
      // a click no longer rebuilds this whole records table.
      const gatewayUrl = (cid) => `https://ipfs.dapperlabs.com/ipfs/${cid}`;
      const heroGatewayUrl = cids.HERO ? gatewayUrl(cids.HERO) : null;
      const playerInfo = cids.PLAYER && ipfsMedia ? getMediaInfo(cids.PLAYER) : null;
      const heroIsPhoto = Boolean(cids.HERO && ipfsMedia && getMediaInfo(cids.HERO)?.fullBleed);
      // Baked flag when the probe knows the CID; runtime verdict for the
      // post-probe editions the silhouetteCandidates effect resolved
      const silhouettePlayer = playerInfo ? playerInfo.silhouette : runtimeSilhouettes.has(cids.PLAYER);
      const canRebuildPlayer = Boolean(silhouettePlayer && isLive(cids.PLAYER) && isLive(cids.HERO) && Number(setMeta?.series) >= 7 && !heroIsPhoto);

      // 3D moment cube (components/MomentCube decides what fronts it); the
      // runtime silhouette verdict covers editions the probe has not seen
      const cubeFace = cubeFaceFor({ cids, ipfsMedia, series: setMeta?.series, silhouettePlayer });
      const cubeBtn = matchingPlay && cubeFace ? (
        <CubeTrigger
          thumb={cubeThumbFor(cids, ipfsMedia)}
          title={cubeFace.title}
          onOpen={async () => {
            const face = await resolveCubeFace(cubeFace);
            if (!face) return;
            setCubeOverlay({
              title: playName,
              config: buildCubeConfig(matchingPlay, getEditionTier(setID, playID), face)
            });
          }}
        />
      ) : null;
      const cubeCells = { cube: cubeBtn, hasCube: Boolean(cubeBtn) };

      // Rides on the PLAYER media line as a second bracket after the
      // "(Player)" label; extras purple marks it as an action, not a file
      const dynamicPhotoBtn = canRebuildPlayer ? (
        <DynamicPhotoButton
          heroUrl={heroGatewayUrl}
          playerUrl={`https://ipfs.dapperlabs.com/ipfs/${cids.PLAYER}`}
          playName={playName}
          onResult={setOverlayMedia}
        />
      ) : null;

      let ipfsCells;
      if (isMismintPlay(playID)) {
        // No counts: mismints are excluded from IPFS coverage, so numeric
        // filters skip them entirely
        ipfsCells = {
          ipfsCore: <span className="text-muted" title="Mismint edition: excluded from IPFS coverage">-</span>
        };
      } else {
        const counts = mediaCounts(cids, ipfsMedia);
        ipfsCells = {
          ipfsCore: (
            <MediaStack
              cids={cids}
              ipfsMedia={ipfsMedia}
              playerExtra={dynamicPhotoBtn}
              onOpen={(url, type, mediaType) => setOverlayMedia({ url, type, title: `${playName} - ${getMediaTypeLabel(mediaType)}` })}
            />
          ),
          ipfsCoreCount: counts.core,
          ipfsExtrasCount: counts.extras
        };
      }


      // Link target ladder: player page when a real name exists, else the
      // team page when the team resolves, else the play page (the shape
      // Plays and Calendar already use)
      let nameTarget = `/plays/${playID}`;
      if (matchingPlay) {
        if (matchingPlay.FullName && matchingPlay.FullName.trim() !== "") {
          nameTarget = playerPath(matchingPlay.FullName);
        } else if (matchingPlay.TeamAtMoment && matchingPlay.TeamAtMoment.trim() !== "") {
          const teamId = findTeamIdByName(matchingPlay.TeamAtMoment.trim());
          if (teamId) nameTarget = `/teams/${teamId}`;
        }
      }
      const nameLink = (
        <Link to={nameTarget} style={{ fontWeight: "600" }} className="player-detail-link font-hover-glow">
          {playName}
        </Link>
      );
      // Badges on their own line directly under the name; a parallel's row
      // shows the Autograph only when that parallel is signed
      const nameCellWith = (tags) => (
        <div className="name-cell">
          {nameLink}
          <Badges tags={tags} />
        </div>
      );
      const fullNameCell = nameCellWith(badges);

      // Split into multiple rows if subeditions exist
      if (hasSubeditions) {
        const compTotal = edition.momentCount;
        const compShown = supplyOf(compTotal, setID, playID);

        // Collapsed: one row per play standing in for all of its subeditions,
        // with the mint counts summed (which is the edition total) and the
        // subedition column reduced to a count. Standard counts as one.
        const isExpanded = expandedPlays.has(String(playID));
        if (collapseSubeditions) {
          const subCount = associatedSubIDs.length + 1;
          const collapsedKey = `${setID}_${playID}`;
          records.push({
            playOrder: edition.playOrder,
            editionID: (
              <span className="font-mono subedition-toggle" title={isExpanded ? "Collapse subeditions" : "Expand subeditions"}>
                <span className="subedition-caret">{isExpanded ? "▾" : "▸"}</span>
                {collapsedKey}
              </span>
            ),
            ...cubeCells,
            subeditionCount: subCount,
            subeditionName: (
              <span className="text-muted">
                {subCount} subeditions
              </span>
            ),
            retired: retiredVal,
            retired_flag: retiredFlag,
            fullName: fullNameCell,
            totalMinted: mintedCell(ownedOfEdition, compShown, otherSupplyOf(compTotal, setID, playID)),
            ownedMinted: ownedOfEdition,
            totalMintedRaw: Number(compShown) || 0,
            ...ipfsCells,
            id: `${playID}_group`,
            editionSortKey: editionSortKey(setID, playID),
            _groupId: String(playID),
            _groupOrder: 0,
            _clickable: true
          });

          if (!isExpanded) return;
        }

        childSubIDs.forEach((subID, childIdx) => {
          const isStandard = subID === 0;
          const subInfo = subeditions[subID] || { name: `Subedition ${subID}`, mintCount: 0 };
          const mintCount = isStandard ? Math.max(0, compTotal - parallelsMintSum) : subInfo.mintCount;
          const runShown = supplyOf(mintCount, setID, playID, subID);
          const subKey = `${setID}_${playID}_${subID}`;

          const ownedOfRun = ownedSerials
            ? (ownedSerials.get(`${Number(setID)}_${Number(playID)}_${subID}`) || []).length
            : 0;

          records.push({
            playOrder: edition.playOrder,
            editionID: <Link to={`/editions/${subKey}`} className="font-mono">{subKey}</Link>,
            // Parallels share the Standard edition's cube
            ...(isStandard ? cubeCells : {}),
            subeditionID: subID,
            subeditionName: (
              <Link to={`/editions/${subKey}`} className="text-muted font-hover-glow" style={{ textDecoration: "none" }}>
                {isStandard ? "Standard" : subInfo.name}
              </Link>
            ),
            retired: retiredVal,
            retired_flag: retiredFlag,
            fullName: nameCellWith(editionBadges(badges, setID, playID, subID)),
            totalMinted: mintedCell(ownedOfRun, runShown, otherSupplyOf(mintCount, setID, playID, subID)),
            ownedMinted: ownedOfRun,
            totalMintedRaw: Number(runShown) || 0,
            // Parallels carry no IPFS registrations of their own (the
            // resolver only holds subedition 0), so their rows stay quiet
            // instead of repeating the Standard edition's links
            ...(isStandard ? ipfsCells : {
              ipfsCore: <span className="text-muted" title="Shares the Standard edition's media">-</span>
            }),
            id: `${playID}_${subID}`,
            editionSortKey: editionSortKey(setID, playID, subID),
            ...(collapseSubeditions ? {
              _groupId: String(playID),
              _groupOrder: childIdx + 1,
              _rowClass: "subedition-child-row",
              _clickable: true
            } : {})
          });
        });
      } else {
        const standardKey = `${setID}_${playID}`;

        records.push({
          playOrder: edition.playOrder,
          editionID: <Link to={`/editions/${standardKey}`} className="font-mono">{standardKey}</Link>,
          ...cubeCells,
          retired: retiredVal,
          retired_flag: retiredFlag,
          fullName: fullNameCell,
          totalMinted: mintedCell(ownedOfEdition, supplyOf(edition.momentCount, setID, playID), otherSupplyOf(edition.momentCount, setID, playID)),
          ownedMinted: ownedOfEdition,
          totalMintedRaw: supplyOf(edition.momentCount, setID, playID),
          ...ipfsCells,
          id: playID,
          editionSortKey: editionSortKey(setID, playID)
        });
      }
    });

    return records;
  }, [editions, ipfsByPlay, subeditions, hasSubeditions, associatedSubIDs, playByID, tsdIndex, mintClock, setID, collapseSubeditions, expandedPlays, ipfsMedia, owned, accountMode, pctMode, setMeta?.series, runtimeSilhouettes]);

  // Editions missing at least one core file (a dead CID counts as
  // missing, same as the coverage bars); parallels carry no counts and
  // mismints are excluded, so neither can appear here
  const missingRows = useMemo(
    () => tableRecords.filter((r) => r.ipfsCoreCount !== undefined && r.ipfsCoreCount < CORE_MEDIA_FIELDS.length),
    [tableRecords]
  );
  const visibleRecords = ipfsView === "missing" ? missingRows : tableRecords;

  if (loadError && !loading) {
    return <LoadError message={loadError} onRetry={() => { setLoading(true); setLoadError(""); loadData(); }} />;
  }

  if (loading) {
    return (
      <Loader message={<>Loading Set details...</>} />
    );
  }

  if (!setMeta) {
    return (
      <div className="glass-panel text-center" style={{ padding: "40px" }}>
        <h3>⚠️ Set Not Found</h3>
        <p className="text-muted mt-8">Set ID #{setID} is not mapped in the local database.</p>
        <Link to="/sets" className="btn-primary mt-20">← Back to Sets</Link>
      </div>
    );
  }

  // Mismint editions (plays_exclude.json) stay visible in the table but
  // never count toward the header stats
  const statEditions = editions.filter((ed) => !isMismintPlay(ed.playID));
  const totalPlaysCount = statEditions.length;
  const totalMints = statEditions.reduce((sum, ed) => sum + supplyOf(ed.momentCount, setID, ed.playID), 0);
  const totalOther = statEditions.reduce((sum, ed) => sum + otherSupplyOf(ed.momentCount, setID, ed.playID), 0);
  const retiredCount = statEditions.filter(ed => ed.retired).length;
  const retiredPercentage = totalPlaysCount > 0 ? (retiredCount / totalPlaysCount) * 100 : 0;
  const retiredPctText = Number.isInteger(retiredPercentage) ? String(retiredPercentage) : retiredPercentage.toFixed(1);
  const setStatus = getSetStatus(setID);
  // Browsing as an account, the header's edition count becomes owned/total
  // (editions with at least one owned moment, any parallel), the way the
  // Minted column does; the owned banner then never repeats it
  const ownedEditionsAny = ownedIndex
    ? statEditions.filter((ed) => (ownedIndex.byEdition.get(`${Number(setID)}_${Number(ed.playID)}`) || 0) > 0).length
    : null;

  // Coverage banner: extras get their own headline score (share of the
  // extra files this set carries that are present; extras are bonus
  // renditions, never expected, so gaps are informational, not failures)
  const covExtraFields = ipfsCoverage ? ipfsCoverage.expectedFields.filter((f) => !CORE_MEDIA_FIELDS.includes(f)) : [];
  const covExtrasPct = ipfsCoverage && covExtraFields.length > 0 && ipfsCoverage.eligibleCount > 0
    ? (covExtraFields.reduce((sum, f) => sum + (ipfsCoverage.extras[f]?.present || 0), 0)
      / (covExtraFields.length * ipfsCoverage.eligibleCount)) * 100
    : null;
  const covRow = (f) => {
    const total = ipfsCoverage.eligibleCount;
    const present = total - (ipfsCoverage.missingByField[f] || 0);
    // Dead = registered on chain but the gateway serves nothing; drawn as
    // a red tail segment on the bar rather than a separate banner line
    const dead = ipfsCoverage.deadByField?.[f] || 0;
    const unregistered = total - present - dead;
    const isCore = CORE_MEDIA_FIELDS.includes(f);
    const full = present === total;
    const tip = `${present} of ${total} editions have this file`
      + (dead > 0 ? `, ${dead} dead at the IPFS gateway` : "")
      + (isCore && unregistered > 0 ? `, ${unregistered} never registered` : "");
    return (
      <div key={f} className="cov-row" title={tip}>
        <span className="cov-label">{getMediaTypeLabel(f)}</span>
        <span className="cov-bar">
          <span
            className={`cov-bar-fill ${isCore ? (full ? "cov-fill-ok" : "cov-fill-gap") : "cov-fill-extra"}`}
            style={{ width: `${total > 0 ? (present / total) * 100 : 0}%` }}
          />
          {dead > 0 && (
            <span className="cov-bar-fill cov-fill-dead" style={{ width: `${(dead / total) * 100}%` }} />
          )}
        </span>
        <span className="cov-frac">{present}/{total}</span>
      </div>
    );
  };

  return (
    <div className="set-detail-container">
      <div className="d-flex align-center gap-10" style={{ marginBottom: "20px" }}>
        <Link to="/sets" className="text-muted">← Back to Sets</Link>
      </div>

      {/* Header Summary */}
      <div className="glass-panel set-header">
        <div className="set-header-main">
          {/* Set artwork: the media host's 512 square when it has one,
              else extracted in the browser from an edition's hero with a
              cube render, else a stand-in drawn from the name. The frame
              is fixed-size so the header never shifts while art loads. */}
          <div className="set-art-frame">
            {(() => {
              if (setArtFile && !setArtThumbBroken) {
                const url = setArtThumbUrl(setArtFile);
                return (
                  <img
                    src={url}
                    alt={`${setMeta.setName} set art`}
                    title="Set artwork, derived from an edition's hero render"
                    onError={() => setBrokenSetArtFile(setArtFile)}
                    onClick={() => setOverlayMedia({ url, type: "image", title: `${setMeta.setName} - set art (derived from an edition's hero)` })}
                  />
                );
              }
              // Art for the CURRENT hero pick only; a stale generation
              // from the previous set must render as still generating
              const art = headerArt && headerArt.cid === setArtHeroCid ? headerArt : null;
              if (art?.url) {
                return (
                  <img
                    src={art.url}
                    alt={`${setMeta.setName} set art`}
                    title="Set artwork, derived on the fly in your browser from an edition's hero render"
                    onClick={() => setOverlayMedia({ url: art.url, type: "image", title: `${setMeta.setName} - set art (generated in your browser from an edition's hero)` })}
                  />
                );
              }
              const noSource = ipfsMedia && !setArtHeroCid;
              if (setArtFile !== undefined && (noSource || (art && !art.url))) {
                return <SetArtPlaceholder name={setMeta.setName} title="No set art exists on IPFS for this set: a stand-in drawn from the name" />;
              }
              return <span className="set-art-hint">⚙ generating...</span>;
            })()}
          </div>
          <div className="set-header-text">
            <div className="d-flex align-center flex-wrap gap-10">
              <span className="set-id-tag">Set #{setID}</span>
              <span className="set-id-tag" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent-nba)" }}>
                Series {setMeta.series}
              </span>
              {setMeta.locked ? (
                <span className="badge badge-danger">CLOSED 🔒</span>
              ) : (
                <span className="badge badge-success">OPEN 🔓</span>
              )}
            </div>
            <h1 className="set-title">{setMeta.setName}</h1>
            <div className="stat-strip">
              <div className="stat-item" title={accountMode ? "Editions with at least one owned moment, out of the set's editions" : undefined} style={accountMode ? { cursor: "help" } : undefined}>
                <span className="stat-label">Editions</span>
                <span className="stat-value">
                  {accountMode ? (
                    totalPlaysCount > 0 && ownedEditionsAny === totalPlaysCount ? (
                      <span className="owned-complete">{ownedEditionsAny}/{totalPlaysCount}<span className="owned-stat-check" title="Complete">✓</span></span>
                    ) : <>{ownedEditionsAny}/{totalPlaysCount}</>
                  ) : totalPlaysCount}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">{setStatus.burned ? "Minted, then burned" : <SupplyWord remaining="Remaining" minted="Minted" />}</span>
                <span className="stat-value" style={setStatus.burned ? { color: "var(--text-muted)", textDecoration: "line-through" } : undefined}>
                  {setStatus.burned ? totalMints.toLocaleString() : <Supply shown={totalMints} other={totalOther} />}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Retired</span>
                <span className="stat-value">{retiredCount}<small>{retiredPctText}%</small></span>
              </div>
            </div>
          </div>
        </div>

        {ownedSetSummary && (
          <div className="owned-set-banner mt-20">
            <div className="d-flex align-center justify-between flex-wrap gap-10">
              <h4>{ownedSetSummary.totalOwned.toLocaleString()} owned</h4>
              {ownedSetSummary.totalOwned > 0 && (
                <Link to={`/account/${owned.address}?set=${setID}`} style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                  Account table →
                </Link>
              )}
            </div>
            {/* The heading carries the total and the header's Editions
                stat carries owned/total, so a single-variant set states
                only what is new: complete sets, average serial, locks.
                A set with parallels is one table, a row per parallel and
                each heading once */}
            {ownedSetSummary.perVariant.length === 1 ? ownedSetSummary.perVariant.map((v) => (
              <OwnedStrip key={v.sub}>
                {v.completeCopies > 0 && (
                  <OwnedStat n={v.completeCopies} label="Complete sets" title="Whole sets assembled from what you own: the lowest count across the editions" />
                )}
                <OwnedStat n={`#${v.avgBestSerial.toLocaleString()}`} label="Avg serial" title="Average of your lowest serial per edition" />
                {v.locked > 0 && (
                  <>
                    <OwnedStat n={v.locked} label="Locked" title="Moments in the locking contract, expired locks not yet unlocked included" />
                    <OwnedStat n={`${v.lockedEditions}/${v.totalEditions}`} label="Locked editions" title="Editions with at least one locked moment" />
                    {v.lockedSets > 0 && <OwnedStat n={v.lockedSets} label="Locked sets" title="Whole sets made of locked moments only" />}
                  </>
                )}
              </OwnedStrip>
            )) : (() => {
              const anyLocked = ownedSetSummary.perVariant.some((v) => v.locked > 0);
              const anyLockedSets = ownedSetSummary.perVariant.some((v) => v.lockedSets > 0);
              return (
                <div className="owned-table-wrap">
                  <table className="owned-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Owned</th>
                        <th title="Editions owned in this parallel, out of the set's editions">Editions</th>
                        <th title="Whole sets assembled from what you own: the lowest count across the editions">Complete sets</th>
                        <th title="Average of your lowest serial per edition">Avg serial</th>
                        {anyLocked && <th title="Moments in the locking contract, expired locks not yet unlocked included">Locked</th>}
                        {anyLocked && <th title="Editions with at least one locked moment">Locked editions</th>}
                        {anyLockedSets && <th title="Whole sets made of locked moments only">Locked sets</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {ownedSetSummary.perVariant.map((v) => {
                        const variantName = v.sub === 0 ? "Standard" : (subeditions[v.sub]?.name || `Subedition ${v.sub}`);
                        const complete = v.ownedEditions === v.totalEditions;
                        return (
                          <tr key={v.sub}>
                            <th scope="row">{variantName}</th>
                            <td>{v.count.toLocaleString()}</td>
                            <td>
                              {complete
                                ? <span className="owned-complete">{v.ownedEditions}/{v.totalEditions}<span className="owned-stat-check" title="Complete">✓</span></span>
                                : <>{v.ownedEditions}/{v.totalEditions}</>}
                            </td>
                            <td>{v.completeCopies > 0 ? v.completeCopies.toLocaleString() : <span className="text-muted">·</span>}</td>
                            <td>#{v.avgBestSerial.toLocaleString()}</td>
                            {anyLocked && <td>{v.locked > 0 ? v.locked.toLocaleString() : <span className="text-muted">·</span>}</td>}
                            {anyLocked && <td>{v.locked > 0 ? `${v.lockedEditions}/${v.totalEditions}` : <span className="text-muted">·</span>}</td>}
                            {anyLockedSets && <td>{v.lockedSets > 0 ? v.lockedSets.toLocaleString() : <span className="text-muted">·</span>}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <OwnedSpecials specialCounts={ownedSetSummary.specialCounts} />
            {ownedSetSummary.totalOwned === 0 && (
              <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>None owned.</p>
            )}
          </div>
        )}

        {setStatus.burned && (
          <div className="set-status-banner mt-20">
            <h4>Burned set</h4>
            <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
              Top Shot destroyed every moment in this set on <strong>{setStatus.burned}</strong>: {totalMints.toLocaleString()} were
              minted and none survive. The contract never decrements its counts, so the chain still reports the original mints; this
              app leaves them out of every total. The media registered for these editions is still viewable below.
            </p>
          </div>
        )}

        {setStatus.mismint && (
          <div className="set-status-banner mt-20">
            <h4>Mismint set</h4>
            <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
              The contract created this set by mistake. It holds no editions and is hidden from the Sets page and every count.
            </p>
          </div>
        )}

        {hasSubeditions && (
          <div className="subedition-banner mt-20">
            <h4>Parallels: {associatedSubIDs.map(id => subeditions[id]?.name || `Subedition ${id}`).join(", ")}</h4>
            <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
              Standard is the edition's on-chain mints minus the parallels' mint counts.{isRemainingSupply() ? " Every count here is the remaining supply, minted minus burned." : ""}
            </p>
          </div>
        )}

        {/* IPFS media coverage: the core four scored as the headline,
            extras scored in their own group; explanations live in the
            group tooltips, per-type detail in each row's bar + tooltip */}
        {ipfsCoverage && ipfsCoverage.pct !== null && (
          <div className="ipfs-coverage-banner mt-20">
            <div className="d-flex flex-wrap" style={{ gap: "16px 44px" }}>
              <div className="cov-group" title="The four files registered for nearly every edition: Hero, Player, Video, Video Square. Score = share present across this set's editions; files dead at the IPFS gateway count as missing.">
                <div className="cov-group-head">
                  <h4>IPFS Core</h4>
                  <span className="cov-score" style={{ color: ipfsCoverage.missingCells === 0 ? "var(--status-success)" : "var(--status-mismint)" }}>
                    {formatCoveragePct(ipfsCoverage.pct)}%
                  </span>
                </div>
                {CORE_MEDIA_FIELDS.map(covRow)}
              </div>
              {covExtraFields.length > 0 && (
                <div className="cov-group" title="Bonus renditions beyond the standard four that some sets carry. Never expected on every edition, so gaps are informational, not failures.">
                  <div className="cov-group-head">
                    <h4>IPFS Extras</h4>
                    <span className="cov-score" style={{ color: "var(--primary-hover)" }}>{formatCoveragePct(covExtrasPct)}%</span>
                  </div>
                  {covExtraFields.map(covRow)}
                </div>
              )}
            </div>
            {/* Footnotes. The first is a quiet link that narrows the table
                below to the editions missing a core file and puts
                ?ipfs=missing in the address bar, so the page URL itself is
                the gap list to hand to Dapper. */}
            {(missingRows.length > 0 || ipfsCoverage.editionsNoMedia > 0 || ipfsCoverage.excludedMismints > 0) && (
              <div className="d-flex flex-wrap gap-15 mt-8" style={{ fontSize: "0.8rem" }}>
                {missingRows.length > 0 && (
                  <button
                    type="button"
                    className={`ipfs-missing-link${ipfsView === "missing" ? " active" : ""}`}
                    onClick={() => setIpfsView(ipfsView === "missing" ? null : "missing")}
                    title={ipfsView === "missing"
                      ? "The table below shows only these editions; click to show every edition again"
                      : "Filter the table below to editions missing at least one of the four core files (a file dead at the IPFS gateway counts as missing)"}
                  >
                    {ipfsView === "missing" ? "Show all" : `${missingRows.length} missing core files`}
                  </button>
                )}
                {ipfsCoverage.editionsNoMedia > 0 && (
                  <span style={{ color: "var(--status-danger)" }} title="No file of any kind is registered for these editions">
                    ⚠️ {ipfsCoverage.editionsNoMedia} {ipfsCoverage.editionsNoMedia === 1 ? "edition has" : "editions have"} no media
                  </span>
                )}
                {ipfsCoverage.excludedMismints > 0 && (
                  <span className="text-muted">{ipfsCoverage.excludedMismints} {ipfsCoverage.excludedMismints === 1 ? "mismint" : "mismints"} excluded</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sync coordinator progress bar, only while the page has no editions
          yet: unmounting it under a populated table would jump the page,
          and the navbar pill already shows sync status */}
      {syncState.isSyncing && editions.length === 0 && (
        <div className="glass-panel mt-20" style={{ background: "rgba(139, 92, 246, 0.05)", borderColor: "var(--primary)" }}>
          <div className="d-flex justify-between" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
            <span className="text-muted">Syncing from the Flow Blockchain: <strong>{syncState.stage}</strong></span>
            <span>{syncState.progressPercent}%</span>
          </div>
          <div className="sync-bar-container">
            <div className="sync-bar-fill" style={{ width: `${syncState.progressPercent}%` }}></div>
          </div>
        </div>
      )}

      {/* Main Datatable */}
      <div className="glass-panel table-panel mt-20">
        {hasSubeditions && (
          <div className="subedition-toggle-bar">
            <label className="subedition-toggle-label">
              <input
                type="checkbox"
                checked={collapseSubeditions}
                onChange={(e) => {
                  setCollapseSubeditions(e.target.checked);
                  setExpandedPlays(new Set());
                }}
              />
              <span>Collapse subeditions</span>
            </label>
            <span className="text-muted" style={{ fontSize: "0.8rem" }}>
              {collapseSubeditions
                ? "One row per play. Click a row to expand its subeditions, or uncheck to expand all."
                : `Every subedition listed separately (${associatedSubIDs.length + 1} rows per play).`}
            </span>
          </div>
        )}
        <DataTable
          onRowClick={(rec) => {
            if (!rec._groupId) return;
            setExpandedPlays((prev) => {
              const next = new Set(prev);
              if (next.has(rec._groupId)) next.delete(rec._groupId);
              else next.add(rec._groupId);
              return next;
            });
          }}
          columns={columns}
          records={visibleRecords}
          defaultSortColumn="editionID"
          defaultSortOrder="asc"
        />
      </div>

      {/* Media Preview Overlay (videos with custom controls, plus images) */}
      <MediaOverlay media={overlayMedia} onClose={() => setOverlayMedia(null)} />

      {/* 3D moment cube overlay (the 🧊 button on each row) */}
      <CubeOverlay cube={cubeOverlay} onClose={() => setCubeOverlay(null)} />

      <style>{`
        .subedition-toggle-bar {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 14px;
          padding-bottom: 16px;
          margin-bottom: 16px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .subedition-toggle-label {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        }
        .subedition-toggle-label input {
          cursor: pointer;
          accent-color: var(--primary);
        }
        .subedition-toggle {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
        }
        /* Stacked IPFS cells: one line per media file, fixed core order */
        .subedition-caret {
          display: inline-block;
          width: 14px;
          color: var(--primary-hover);
        }
        .subedition-child-row td:first-child {
          padding-left: 26px;
        }
        .subedition-child-row td {
          background: rgba(255,255,255,0.015);
        }
        .set-header {
          padding: 30px;
        }
        .set-header-main {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 20px 28px;
        }
        .set-header-text {
          flex: 1 1 320px;
          min-width: 0;
        }
        .set-id-tag {
          background: rgba(139, 92, 246, 0.12);
          color: var(--primary-hover);
          font-family: var(--font-mono);
          font-size: 0.85rem;
          padding: 4px 10px;
          border-radius: 6px;
          font-weight: 600;
        }
        .set-title {
          font-size: 2.2rem;
          margin: 10px 0 0;
        }
        /* Phones: tighter header so the title, stats and chips breathe */
        @media (max-width: 600px) {
          .set-header {
            padding: 18px;
          }
          .set-title {
            font-size: 1.5rem;
          }
        }
        .subedition-banner {
          background: rgba(139, 92, 246, 0.04);
          border: 1px solid rgba(139, 92, 246, 0.15);
          border-radius: 8px;
          padding: 16px;
        }
        .subedition-banner h4 {
          color: var(--primary-hover);
        }
        .set-status-banner {
          background: rgba(239, 68, 68, 0.05);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 8px;
          padding: 16px;
        }
        .set-status-banner h4 {
          color: var(--status-danger);
        }
        .ipfs-coverage-banner {
          background: rgba(59, 130, 246, 0.04);
          border: 1px solid rgba(59, 130, 246, 0.15);
          border-radius: 8px;
          padding: 16px;
        }
        .ipfs-coverage-banner h4 {
          color: var(--accent-nba);
        }
        /* A footnote that happens to be a filter: plain text, dotted
           underline, no button chrome */
        .ipfs-missing-link {
          background: none;
          border: none;
          padding: 0;
          font: inherit;
          color: var(--text-muted);
          text-decoration: underline dotted;
          text-underline-offset: 3px;
          cursor: pointer;
        }
        .ipfs-missing-link:hover,
        .ipfs-missing-link.active {
          color: var(--status-mismint);
        }
        /* Coverage groups: one per class of media (core / extras), each
           with a headline score and per-type bar rows */
        .cov-group {
          flex: 0 1 340px;
          min-width: 240px;
        }
        .cov-group-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 6px;
          cursor: help;
        }
        .cov-score {
          font-family: var(--font-mono);
          font-weight: 700;
          font-size: 1rem;
        }
        .cov-row {
          display: grid;
          grid-template-columns: 10em 1fr 4.5em;
          align-items: center;
          gap: 10px;
          font-size: 0.8rem;
          margin-top: 4px;
        }
        .cov-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cov-bar {
          display: flex;
          height: 6px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.07);
          overflow: hidden;
        }
        .cov-bar-fill {
          display: block;
          height: 100%;
        }
        .cov-fill-ok { background: var(--status-success); }
        .cov-fill-gap { background: var(--status-mismint); }
        .cov-fill-extra { background: rgba(167, 139, 250, 0.75); }
        .cov-fill-dead { background: rgba(239, 68, 68, 0.8); }
        .cov-frac {
          font-family: var(--font-mono);
          color: var(--text-muted);
          text-align: right;
          white-space: nowrap;
        }
        /* Header set artwork: fixed frame so the header never shifts
           while the art generates (or when there is none) */
        .set-art-frame {
          width: 170px;
          height: 170px;
          flex: none;
          /* The stand-in sizes its text in cqw units against this box */
          container-type: inline-size;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .set-art-frame img {
          width: 100%;
          height: 100%;
          display: block;
          cursor: zoom-in;
        }
        .set-art-hint {
          color: var(--text-muted);
          font-size: 0.72rem;
        }
        @media (max-width: 600px) {
          .set-art-frame {
            width: 120px;
            height: 120px;
          }
        }
      `}</style>
    </div>
  );
}
