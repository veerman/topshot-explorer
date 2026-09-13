import { isSigned, signedSubs, editionBadges } from "../services/autograph.service";
import { Badges } from "../components/Badges";
import { CubeOverlay } from "../components/CubeOverlay";
import { MomentCubeView } from "../components/MomentCube";
import { buildCubeConfig, cubeFaceFor, resolveCubeFace, gatewayUrl, isLiveCid } from "../services/cube.service";
import { useAccountCollection } from "../hooks/useAccountCollection";
import { toQuery } from "../utils/query";
import { runSizeFor } from "../utils/serials.utils";
import { parallelGroup } from "../services/parallel.groups";
import { MediaStack } from "../components/MediaStack";
import { EditorialSection, ProfileSection, BiographySection, AutographSection, SupplementSection } from "../components/PlayInfoSections";
import { Loader } from "../components/Loader";
import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { getRecord, getSetEditionsDB, getSetIPFSDB, getAllTeamsDB, getAllPlaysDB, getAllSetsDB } from "../services/db.service";
import { getSubeditions as getSubeditionsService, getSetsOverview, subeditionLabel } from "../services/fcl.service";
import { remainingOf } from "../services/supply.service";
import { Supply, SupplyWord } from "../components/Supply";
import { getSeriesInfo, resolveVenue, getCalculatedPlayTags, parseMomentDate, isMismintPlay, editionTags, withTags } from "../services/overrides.service";
import { getMediaTypeLabel } from "../services/ipfs.analysis";
import { LoadError } from "../components/LoadError";
import { buildTeamNameMap, getLeagueBadge, getLeagueName, renderTeamLink as renderTeamLinkShared, getTierBadgeClass, scrubSentinels, buildMatchupSides, renderMatchupCell, formatDateISO, buildSeriesSeasonMap, seasonHintForPlay, getSeasonFallback, renderSeasonChip, playerPath } from "../utils/display.utils";
import setsParallels from "../../data/sets_parallels.json";
import playsAdditions from "../../data/additions/plays.json";
import setsAdditions from "../../data/additions/sets.json";
import { getSetStatus, getEditionTier } from "../services/set.status";
import editionsAdditions from "../../data/additions/editions.json";
import { MediaOverlay } from "../components/MediaOverlay";
import { VideoPlayer } from "../components/VideoPlayer";
import { useIpfsMedia } from "../hooks/useIpfsMedia";
import { commentaryFor, withCommentary } from "../services/commentary.service";

export function EditionDetail() {
  const { editionKey } = useParams(); // format: setID_playID_subeditionID
  const [setMeta, setSetMeta] = useState(null);
  const [matchingPlay, setMatchingPlay] = useState(null);
  const [allPlays, setAllPlays] = useState([]);
  const [matchingEdition, setMatchingEdition] = useState(null);
  const [ipfsRecord, setIpfsRecord] = useState(null);
  const [subeditions, setSubeditions] = useState({});
  const [teamNameMap, setTeamNameMap] = useState({});
  const [matchingSets, setMatchingSets] = useState([]);
  const [allSets, setAllSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeVideo, setActiveVideo] = useState(null);
  // The default clip waits for a click; a clip the visitor picks starts at once
  const [autoPlayPicked, setAutoPlayPicked] = useState(false);
  // The src the featured player last failed to load (the hotlinked
  // commentary cut can vanish at Dapper's end; IPFS files have their own
  // dead-CID handling). Compared against activeVideo, so a src change
  // clears it without an effect.
  const [failedVideo, setFailedVideo] = useState(null);
  const [overlayMedia, setOverlayMedia] = useState(null);
  const [cubeOverlay, setCubeOverlay] = useState(null);
  // The media card shows one thing at a time: the cube (default when there
  // is one) or the video; picking a clip from the assets list switches
  const [mediaMode, setMediaMode] = useState("cube");
  // Lazy per-CID media metadata (dimensions, duration, size, dead CIDs)
  const ipfsMedia = useIpfsMedia();
  // The account in context, if any: header chips and badges then lead into
  // that collection instead of the catalogue
  const owned = useAccountCollection();
  const cids = useMemo(() => (ipfsRecord && ipfsRecord.cids) || {}, [ipfsRecord]);
  // Stable across renders: the inline cube remounts when this changes
  const cubeFace = useMemo(
    () => (matchingPlay ? cubeFaceFor({ cids, ipfsMedia, series: setMeta ? setMeta.series : undefined }) : null),
    [matchingPlay, cids, ipfsMedia, setMeta]
  );

  // 1. Parse Edition Composite Key
  const keyParams = useMemo(() => {
    if (!editionKey) return null;
    const parts = editionKey.split("_");
    if (parts.length < 2) return null;
    return {
      setID: Number(parts[0]),
      playID: Number(parts[1]),
      subeditionID: parts[2] !== undefined ? Number(parts[2]) : 0,
      // A suffix-less key is the whole edition: on a set with parallels it
      // shows the collapsed view (all parallels combined) instead of Standard
      hasExplicitSub: parts[2] !== undefined
    };
  }, [editionKey]);

  const supplementData = useMemo(() => {
    if (!keyParams) return null;
    const { setID, playID } = keyParams;
    const sID = String(setID);
    const pID = String(playID);
    const eID = `${sID}_${pID}`;

    const sData = setsAdditions[sID] || {};
    const pData = playsAdditions[pID] || {};
    const eData = editionsAdditions[eID] || {};

    // Spread precedence IS the resolution order (edition over play over
    // set); tags merge separately below
    const merged = { ...sData, ...pData, ...eData };
    delete merged.tags;

    const sTags = sData.tags || [];
    const pTags = (matchingPlay && allPlays && allPlays.length > 0)
      ? getCalculatedPlayTags(matchingPlay, allPlays)
      : (pData.tags || []);
    const eTags = eData.tags || [];
    const mergedTags = Array.from(new Set([...sTags, ...pTags, ...eTags]));
    if (mergedTags.length > 0) {
      merged.tags = mergedTags;
    }

    return merged;
  }, [keyParams, matchingPlay, allPlays]);

  // Guards against a stale async load (fast navigation between editions)
  // overwriting the newer edition's state
  const loadSeqRef = useRef(0);
  const hasLoadedRef = useRef(false);

  // 2. Load all details offline from IndexedDB
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    const isStale = () => seq !== loadSeqRef.current;

    const loadDetails = async () => {
      // First load: show the spinner and start from a clean slate. Later
      // navigations (e.g. the parallels toggler) keep the current content on
      // screen and swap it in place once the new data is ready, so switching
      // editions feels instant instead of like a page reload.
      if (!hasLoadedRef.current) {
        setLoading(true);
        setError(null);
        setSetMeta(null);
        setMatchingPlay(null);
        setMatchingEdition(null);
        setIpfsRecord(null);
        setMatchingSets([]);
      } else {
        setError(null);
      }

      if (!keyParams) {
        setError("Invalid edition key specified.");
        setLoading(false);
        return;
      }

      try {
        const { setID, playID } = keyParams;

        // Offline reads in parallel
        const [dbSet, dbPlay, allPlaysList, setEditions, setIPFS, allTeams, setsListRaw] = await Promise.all([
          getRecord("sets", setID),
          getRecord("plays", playID),
          getAllPlaysDB(),
          getSetEditionsDB(setID),
          getSetIPFSDB(setID),
          getAllTeamsDB(),
          getAllSetsDB()
        ]);
        if (isStale()) return;

        if (!dbSet) {
          setError(`Set ID #${setID} not found in database.`);
          setLoading(false);
          return;
        }
        setSetMeta(dbSet);

        if (dbPlay) {
          setMatchingPlay(scrubSentinels(dbPlay));
        } else {
          setMatchingPlay(null);
        }

        setAllPlays(allPlaysList);
        setMatchingEdition(setEditions.find(ed => Number(ed.playID) === Number(playID)));
        setIpfsRecord(setIPFS.find(rec => Number(rec.playID) === Number(playID)));
        setTeamNameMap(buildTeamNameMap(allTeams));

        // Find sets this play appears in (offline-first from IndexedDB,
        // live chain query only when the local sets store is empty)
        let setsList = setsListRaw;
        if (!setsList || setsList.length === 0) {
          setsList = await getSetsOverview();
          if (isStale()) return;
        }
        setAllSets(setsList);
        const appearances = setsList.filter((set) =>
          (set.playIDs || []).some((id) => String(id) === String(playID))
        );
        setMatchingSets(appearances);
        hasLoadedRef.current = true;

        // Live chain call: must not take the offline data down with it
        try {
          const subs = await getSubeditionsService();
          if (!isStale()) setSubeditions(subs);
        } catch (subErr) {
          console.warn("Failed to load subeditions from chain (offline?). Parallel counts unavailable:", subErr);
        }

      } catch (err) {
        if (isStale()) return;
        console.error("Failed to load edition detail offline:", err);
        setError("An error occurred loading the edition details from the local database.");
      } finally {
        if (!isStale()) setLoading(false);
      }
    };

    loadDetails();
  }, [keyParams]);

  // Set the default video once IPFS record loads
  useEffect(() => {
    let vidToSet = null;
    if (ipfsRecord && ipfsRecord.cids) {
      // Find priority video; never pick a CID the gateway is known to
      // serve nothing for
      const VIDEO_PRIORITY = ["VIDEO", "VIDEO_VERTICAL", "VIDEO_TALL", "VIDEO_SQUARE"];
      const isDead = (cid) => Boolean(ipfsMedia && ipfsMedia.media[cid] === 0);
      const foundKey = VIDEO_PRIORITY.find((type) => ipfsRecord.cids[type] && !isDead(ipfsRecord.cids[type]))
        // If no priority video, check any video type
        || Object.keys(ipfsRecord.cids).find((key) => key.toLowerCase().startsWith("video") && !isDead(ipfsRecord.cids[key]));
      if (foundKey) vidToSet = `https://ipfs.dapperlabs.com/ipfs/${ipfsRecord.cids[foundKey]}`;
    }
    // Settle like a fetch would, never mid-render
    Promise.resolve().then(() => setActiveVideo(vidToSet));
  }, [ipfsRecord, ipfsMedia]);

  // Narrated cut of THIS edition from the original nbatopshot.com
  // (data/commentary.json, hotlinked from Dapper's own hosting)
  const commentary = useMemo(() => {
    const [cSet, cPlay] = String(editionKey || "").split("_");
    return commentaryFor(cSet, cPlay);
  }, [editionKey]);
  const commentaryPlaying = Boolean(commentary && activeVideo === commentary.video);
  const videoFailed = Boolean(activeVideo) && failedVideo === activeVideo;

  // 3. Helper to build team links (historical name resolved for the game date)
  const renderTeamLink = (teamName, isHighlight = false, emojiStar = "") =>
    renderTeamLinkShared(teamName, teamNameMap, {
      isHighlight,
      emojiStar,
      resolveHistoricalName: true,
      dateOfMoment: matchingPlay?.DateOfMoment
    });

  // Season fallback for undated plays: shown as a chip, never as a date
  const seasonFallback = useMemo(() => {
    if (!matchingPlay || matchingPlay.DateOfMoment) return null;
    const mapping = {};
    allSets.forEach((set) => (set.playIDs || []).forEach((pid) => {
      (mapping[pid] = mapping[pid] || []).push({ series: set.series });
    }));
    const seriesSeasonMap = buildSeriesSeasonMap(allPlays, mapping);
    return getSeasonFallback(matchingPlay, seasonHintForPlay(matchingPlay, matchingSets, seriesSeasonMap));
  }, [matchingPlay, allPlays, allSets, matchingSets]);

  if (loading) {
    return (
      <Loader message={<>Loading edition details from database...</>} />
    );
  }

  if (error || !keyParams || !setMeta) {
    return (
      <LoadError message={error || "An invalid key format was parsed."}>
        <Link to="/sets" className="btn-primary mt-20" style={{ display: "inline-flex" }}>← Back to Sets</Link>
      </LoadError>
    );
  }

  const { setID, playID, subeditionID, hasExplicitSub } = keyParams;
  const isMismint = isMismintPlay(playID);

  const rawHomeTeam = matchingPlay?.HomeTeamName;
  const rawTeamAtMoment = matchingPlay?.TeamAtMoment;

  const homeTeamId = rawHomeTeam ? teamNameMap[rawHomeTeam.trim().toLowerCase()] : null;
  const homeTeamDetails = homeTeamId && matchingPlay ? resolveVenue(homeTeamId, matchingPlay.DateOfMoment) : null;
  const teamId = rawTeamAtMoment ? teamNameMap[rawTeamAtMoment.trim().toLowerCase()] : null;
  const teamDetails = teamId && matchingPlay ? resolveVenue(teamId, matchingPlay.DateOfMoment) : null;
  const arenaDetails = homeTeamDetails || teamDetails;

  const subInfo = subeditions[subeditionID] || { name: subeditionLabel(subeditionID), mintCount: 0 };
  const subeditionName = subInfo.name;

  // Compile other subeditions for the quick toggler
  const associatedSubIDs = setsParallels[String(setID)] || [];
  const hasSubeditions = associatedSubIDs.length > 0;

  // Resolve Mint metrics
  const compTotal = matchingEdition ? matchingEdition.momentCount : 0;
  let subSum = 0;
  associatedSubIDs.forEach((subID) => {
    const info = subeditions[subID] || { mintCount: 0 };
    subSum += info.mintCount;
  });

  const isCollapsedView = hasSubeditions && !hasExplicitSub;
  const specificMintCount = isCollapsedView
    ? compTotal
    : subeditionID === 0
      ? (hasSubeditions ? Math.max(0, compTotal - subSum) : compTotal)
      : (subeditions[subeditionID]?.mintCount || 0);

  // The remaining supply of this run (or of the whole edition in the
  // collapsed view); Supply shows it or the mint count first per Settings
  const remainingMintCount = remainingOf(specificMintCount, setID, playID, isCollapsedView ? null : subeditionID);

  const isRetired = matchingEdition ? matchingEdition.retired : false;
  const seriesInfo = setMeta ? getSeriesInfo(setMeta.series) : null;
  const seriesName = seriesInfo ? seriesInfo.name : `Series ${setMeta?.series}`;

  // The badges of this edition (or parallel): the play's, the edition's
  // own reward badge, the narrated cut, the autograph only where signed
  const badgesHere = matchingPlay
    ? editionBadges(withCommentary(withTags(getCalculatedPlayTags(matchingPlay, allPlays), editionTags(setID, playID)), Boolean(commentary)), setID, playID, isCollapsedView ? null : subeditionID)
    : [];
  // No live video: the hero (or the player image) stands in for the player
  const thumbType = ["HERO", "PLAYER"].find((t) => isLiveCid(cids[t], ipfsMedia));
  const thumbUrl = thumbType ? gatewayUrl(cids[thumbType]) : null;
  const tierHere = getEditionTier(setID, playID);
  // The cube full screen, from the inline view's button
  const openCube = async () => {
    const face = await resolveCubeFace(cubeFace);
    if (!face) return;
    setCubeOverlay({ title: displayName, config: buildCubeConfig(matchingPlay, tierHere, face) });
  };
  const showCube = mediaMode === "cube" && Boolean(cubeFace);

  // Where the header chips and badges lead: into the collection in
  // context (the account page's facets), or with no account, into the
  // catalogue (sets by series, tier or parallel size; plays by league or
  // badge). Standard has no catalogue facet, so it links only in account
  // mode; the collapsed all-parallels chip never does.
  const collectionLink = (params) => `/account/${owned.address}?${toQuery(new URLSearchParams(params))}`;
  const leagueHere = matchingPlay ? getLeagueName(matchingPlay.TeamAtMoment) : null;
  const parallelRun = matchingEdition && !isCollapsedView ? runSizeFor(setID, subeditionID, matchingEdition.momentCount) : 0;
  const chipTo = {
    set: owned ? collectionLink({ set: String(setID) }) : `/sets/${setID}`,
    series: owned ? collectionLink({ series: String(setMeta?.series) }) : `/sets?series=${setMeta?.series}`,
    parallel: isCollapsedView ? null
      : owned ? collectionLink({ sub: String(subeditionID) })
        : subeditionID !== 0 && parallelRun > 0 ? `/sets?parallel=${encodeURIComponent(parallelGroup(parallelRun))}` : null,
    tier: tierHere ? (owned ? collectionLink({ tier: tierHere }) : `/sets?tier=${encodeURIComponent(tierHere)}`) : null,
    league: leagueHere ? (owned ? collectionLink({ league: leagueHere }) : `/plays?league=${leagueHere.toLowerCase()}`) : null
  };
  const badgeTo = (tag) => (owned ? collectionLink({ badge: tag }) : `/plays?badge=${encodeURIComponent(tag)}`);
  const chipHint = owned ? "click to see yours" : "click to see them all";

  // PlayCategory and PlayType are frequently the same string ("3 Pointer"),
  // so collapse them rather than printing the value twice.
  const playTypeLabel = [...new Set(
    [matchingPlay?.PlayCategory, matchingPlay?.PlayType]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  )].join(" • ");

  // The header and the Set & Parallel Context panel both already name this
  // set, so the overview lists only the OTHER sets carrying the same play
  // (the links cell renders from this same list, so they cannot disagree)
  const otherSets = matchingSets.filter((s) => String(s.id) !== String(setID));
  const setsCell = otherSets.length > 0 ? (
    <div className="d-flex flex-wrap gap-8">
      {otherSets.map((s) => (
        <Link key={s.id} to={`/editions/${s.id}_${playID}`} className="set-link" style={{ fontSize: "0.8rem" }} title={`${s.setName} (Series ${s.series})`}>
          #{s.id} {s.setName}
        </Link>
      ))}
    </div>
  ) : (
    <span className="text-muted">-</span>
  );

  // A team moment is titled with its team's name (linked to the team page)
  const playerName = matchingPlay?.FullName && matchingPlay.FullName.trim() !== "" ? matchingPlay.FullName.trim() : "";
  const isTeamMoment = !playerName;
  const teamMomentName = matchingPlay?.TeamAtMoment && matchingPlay.TeamAtMoment.trim() !== "" ? matchingPlay.TeamAtMoment.trim() : "";
  const displayName = playerName || teamMomentName || "Team Moment";
  const autographDate = matchingPlay?.PlayerAutographDate || matchingPlay?.Date;
  const autographSigner = matchingPlay?.PlayerAutographSigner || matchingPlay?.Signer;
  // The signature is a fact of one parallel (data/autographs.json); the
  // chain flags the play, so a flagged play can be unsigned on this parallel
  const signedHere = isSigned(setID, playID, isCollapsedView ? null : subeditionID);
  const signedParallels = (signedSubs(setID, playID) || []).map((sub) => (sub === 0 ? "Standard" : (subeditions[sub]?.name || subeditionLabel(sub))));

  const headlineVal = matchingPlay?.headline || matchingPlay?.Headline || matchingPlay?.OverrideHeadline || "";
  const descriptionVal = matchingPlay?.description || matchingPlay?.Description || matchingPlay?.Tagline || "";



  return (
    <div className="edition-detail-container">
      {/* Back to Parent Set navigation */}
      <div className="d-flex align-center justify-between" style={{ marginBottom: "20px" }}>
        <Link to={`/sets/${setID}`} className="text-muted hover-glow-nav" style={{ textDecoration: "none", fontSize: "0.95rem" }}>
          ← Back to Set: <span style={{ color: "var(--primary-hover)", fontWeight: "500" }}>{setMeta.setName}</span>
        </Link>
        <Link to={`/plays/${playID}`} className="text-muted hover-glow-nav" style={{ textDecoration: "none", fontSize: "0.95rem" }}>
          View Play #{playID} details →
        </Link>
      </div>

      {/* Header Panel */}
      <div className={`glass-panel detail-header ${isMismint ? "border-mismint" : ""}`}>
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <div className="d-flex align-center gap-10 flex-wrap">
              <Link to={chipTo.set} className="play-id-tag play-id-link" title={owned ? "This set; click to see yours" : "Opens the set"}>Set #{setID}</Link>
              <Link to={chipTo.series} className="play-id-tag play-id-link" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent-nba)" }} title={`This series; ${chipHint}`}>
                {seriesName}
              </Link>
              {isCollapsedView ? (
                <span className="badge badge-standard" title="The whole edition: the standard run and every parallel combined; pick one below to narrow the page">Standard + {associatedSubIDs.length} {associatedSubIDs.length === 1 ? "parallel" : "parallels"}</span>
              ) : chipTo.parallel ? (
                <Link to={chipTo.parallel} className={`badge ${subeditionID === 0 ? "badge-standard" : "badge-parallel"} badge-link`} title={`This parallel; ${chipHint}`}>
                  {subeditionID === 0 ? "Standard Edition" : `${subeditionName} Parallel`}
                </Link>
              ) : subeditionID === 0 ? (
                <span className="badge badge-standard">Standard Edition</span>
              ) : (
                <span className="badge badge-parallel">{subeditionName} Parallel</span>
              )}
              {supplementData?.tier && (chipTo.tier ? (
                <Link to={chipTo.tier} className={`badge ${getTierBadgeClass(supplementData.tier)} badge-link`} style={{ textTransform: "uppercase" }} title={`This tier; ${chipHint}`}>
                  {supplementData.tier}
                </Link>
              ) : (
                <span className={`badge ${getTierBadgeClass(supplementData.tier)}`} style={{ textTransform: "uppercase" }}>
                  {supplementData.tier}
                </span>
              ))}
              {getSetStatus(setID).burned && (
                <span className="badge badge-danger" title={`Every moment in this set was burned by Top Shot on ${getSetStatus(setID).burned}`} style={{ cursor: "help" }}>
                  Burned
                </span>
              )}
              {matchingPlay && getLeagueBadge(matchingPlay.TeamAtMoment, chipTo.league)}
              {isMismint && <span className="badge badge-warning">Mismint ⚠️</span>}
            </div>
            <h1 className="player-title">
              {!isTeamMoment ? (
                <Link to={playerPath(displayName)} className="player-detail-link font-hover-glow" style={{ color: "#fff", textDecoration: "none" }}>
                  {displayName}
                </Link>
              ) : (
                <span style={{ color: "#fff" }}>{renderTeamLink(displayName, false) || displayName}</span>
              )}
            </h1>
            <p className="text-muted player-subtitle">
              {playTypeLabel}
              {/* The team is already the title on a team moment; repeating it
                  here would say the same thing twice */}
              {!isTeamMoment && <>{playTypeLabel && " • "}{matchingPlay ? renderTeamLink(matchingPlay.TeamAtMoment) : ""}</>}
            </p>
            {badgesHere.length > 0 && <div className="mt-12"><Badges tags={badgesHere} linkOf={badgeTo} /></div>}
          </div>
        </div>

        {isMismint && (
          <div className="mismint-warning-box">
            <h4>⚠️ Contract Mismint Warning</h4>
            <p>
              This play ID is flagged in <code>data/plays_exclude.json</code> as having misminted/incorrect 
              metadata on-chain. Details shown here may contain typos or errors present in the smart contract.
            </p>
          </div>
        )}
      </div>

      {/* Side-by-Side Dashboard Layout */}
      <div className="edition-dashboard-layout">
        {/* Left Column: Media Player & Assets */}
        <div className="dashboard-column">
          {/* Prominent Media Player Card */}
          <div className="glass-panel prominent-media-card">
            <div className="media-head">
              <h3 className="media-section-title">Featured Highlights</h3>
              {cubeFace && (activeVideo || thumbUrl) && (
                <div className="media-mode-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={showCube} className={`media-mode-tab${showCube ? " active" : ""}`} onClick={() => setMediaMode("cube")}>3D cube</button>
                  <button type="button" role="tab" aria-selected={!showCube} className={`media-mode-tab${!showCube ? " active" : ""}`} onClick={() => { setAutoPlayPicked(true); setMediaMode("video"); }}>{activeVideo ? "Video" : "Image"}</button>
                </div>
              )}
            </div>
            {showCube ? (
              <div className="mt-15 media-body">
                <MomentCubeView face={cubeFace} play={matchingPlay} tier={tierHere} title="Drag to spin" />
                <div className="cube-inline-actions">
                  <button type="button" className="cube-inline-expand" onClick={openCube} title="Open the cube full screen">Full screen ⤢</button>
                </div>
              </div>
            ) : activeVideo ? (
              <div className="video-wrapper mt-15">
                <VideoPlayer src={activeVideo} autoPlay={autoPlayPicked} hotkeys videoClassName="embedded-video-player" onError={() => setFailedVideo(activeVideo)} />
                {commentaryPlaying && (
                  <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>
                    {videoFailed
                      ? "This commentary is no longer hosted by Dapper Labs."
                      : `Commentary narrated by ${commentary.narrator}. Hosted by Dapper Labs, not on chain.`}
                  </p>
                )}
              </div>
            ) : thumbUrl ? (
              <div className="video-wrapper mt-15">
                <img
                  src={thumbUrl}
                  alt=""
                  className="media-thumb-fallback"
                  title="No video on IPFS for this edition; click to view the image"
                  onClick={() => setOverlayMedia({ url: thumbUrl, type: "image", title: getMediaTypeLabel(thumbType) })}
                />
              </div>
            ) : (
              <div className="video-fallback-box mt-15">
                <span style={{ fontSize: "3rem" }}>🎥</span>
                <p className="text-muted mt-8" style={{ fontSize: "0.9rem" }}>No IPFS media for this edition.</p>
              </div>
            )}
          </div>

          {/* Media Assets: the same lines the set page rows show */}
          <div className="glass-panel mt-20 toggler-panel">
            <h3>Media Assets</h3>
            {ipfsRecord && ipfsRecord.cids ? (
              <div className="mt-15">
                <MediaStack
                  cids={cids}
                  ipfsMedia={ipfsMedia}
                  activeUrl={activeVideo}
                  onOpen={(url, type, mediaType) => {
                    if (type === "video") { setAutoPlayPicked(true); setActiveVideo(url); setMediaMode("video"); return; }
                    setOverlayMedia({ url, type, title: getMediaTypeLabel(mediaType) });
                  }}
                  extraLines={commentary ? [(
                    <a
                      key="commentary"
                      className={`ipfs-line${commentaryPlaying ? " is-active" : ""}`}
                      href={commentary.video}
                      onClick={(e) => { e.preventDefault(); setAutoPlayPicked(true); setActiveVideo(commentary.video); setMediaMode("video"); }}
                      title="A narrated cut of this moment from the original nbatopshot.com, served from Dapper Labs' own hosting, not on chain"
                    >
                      🎙 Commentary by {commentary.narrator} <span className="ipfs-line-label">(Dapper Labs hosted)</span>
                    </a>
                  )] : undefined}
                />
              </div>
            ) : (
              <p className="text-muted mt-8" style={{ fontSize: "0.85rem" }}>No IPFS media registered for this edition.</p>
            )}
          </div>
        </div>

        {/* Right Column: Overview & Context */}
        <div className="dashboard-column">
          {/* Play Overview Panel: one grid, rows shared across both columns */}
          <div className="glass-panel core-summary-panel">
            <h3>Play Overview</h3>
            {/* The matchup first and across the panel, so neither team name wraps */}
            <div className="summary-item matchup-summary-item matchup-summary-wide mt-20">
              <span className="summary-label">Matchup</span>
              <span className="summary-value">
                {matchingPlay ? renderMatchupCell(buildMatchupSides(matchingPlay, teamNameMap, {
                  resolveHistoricalName: true,
                  dateOfMoment: matchingPlay.DateOfMoment
                })) : "-"}
              </span>
            </div>
            <div className="summary-grid summary-grid-aligned mt-12" style={{ "--rows": otherSets.length > 0 ? 4 : 2 }}>
              <div className="summary-item">
                <span className="summary-label">Play ID</span>
                <span className="summary-value font-mono"><Link to={`/plays/${playID}`} className="font-hover-glow" style={{ color: "#fff", textDecoration: "none" }}>#{playID}</Link></span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Category</span>
                <span className="summary-value">{playTypeLabel || "-"}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Date</span>
                <span className="summary-value">
                  {(() => {
                    if (!matchingPlay?.DateOfMoment) {
                      return seasonFallback ? renderSeasonChip(seasonFallback) : "-";
                    }
                    const dateMatch = String(matchingPlay.DateOfMoment).match(/^(\d{4})-(\d{2})-(\d{2})/);
                    const dObj = parseMomentDate(matchingPlay.DateOfMoment);
                    const label = dObj ? formatDateISO(dObj) : matchingPlay.DateOfMoment;
                    return dateMatch ? (
                      <Link to={`/calendar/${dateMatch[2]}-${dateMatch[3]}`} className="date-calendar-link">
                        {label}
                      </Link>
                    ) : label;
                  })()}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Season</span>
                <span className="summary-value font-mono">{matchingPlay?.NbaSeason || "-"}</span>
              </div>
              {otherSets.length > 0 && (
                <div className="summary-item summary-item-tall">
                  <span className="summary-label">Also In</span>
                  <span className="summary-value">{setsCell}</span>
                </div>
              )}
            </div>
          </div>

          {/* Set & Parallel Context Block */}
          <div className="glass-panel mt-20 toggler-panel">
            <h3 className="section-title-accent">Set & Parallel Context</h3>
            <div className="summary-grid summary-grid-aligned mt-20" style={{ "--rows": 3 }}>
              <div className="summary-item">
                <span className="summary-label">Set</span>
                <span className="summary-value">
                  <Link to={`/sets/${setID}`} className="font-hover-glow" style={{ color: "var(--primary-hover)", fontWeight: "600", textDecoration: "none" }}>
                    {setMeta.setName}
                  </Link>
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Series</span>
                <span className="summary-value text-accent font-mono" style={{ fontSize: "0.9rem" }}>{seriesName}</span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Set Status</span>
                <span className="summary-value">
                  {setMeta.locked ? <span className="badge badge-retired">Closed</span> : <span className="badge badge-active">Open</span>}
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label"><SupplyWord remaining="Remaining" minted="Mint Size" /></span>
                <span className="summary-value font-mono" style={{ color: "var(--primary-hover)", fontWeight: "600" }}>
                  <Supply remaining={remainingMintCount} minted={specificMintCount} />
                </span>
              </div>
              <div className="summary-item">
                <span className="summary-label">Edition</span>
                <span className="summary-value">
                  {isRetired ? <span className="badge badge-retired">Retired 🔒</span> : <span className="badge badge-active">Minting 🔓</span>}
                </span>
              </div>
            </div>

            {hasSubeditions && (
              <div className="mt-20">
                <h4 style={{ fontSize: "0.95rem", color: "#fff", fontWeight: "600" }}>Parallels</h4>
                <div className="d-flex flex-wrap gap-10 mt-15">
                  <Link
                    to={`/editions/${setID}_${playID}`}
                    className={`toggler-pill ${isCollapsedView ? "active" : ""}`}
                  >
                    All
                  </Link>
                  <Link
                    to={`/editions/${setID}_${playID}_0`}
                    className={`toggler-pill ${!isCollapsedView && subeditionID === 0 ? "active" : ""}`}
                  >
                    Standard
                  </Link>
                  {associatedSubIDs.map((subID) => {
                    const info = subeditions[subID] || { name: `Subedition ${subID}` };
                    return (
                      <Link
                        key={subID}
                        to={`/editions/${setID}_${playID}_${subID}`}
                        className={`toggler-pill ${subeditionID === Number(subID) ? "active" : ""}`}
                      >
                        {info.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The shared groups (components/PlayInfoSections): editorial across
          the width, profile and biography side by side, the autograph only
          where a parallel is signed, the off-chain supplement last */}
      <div className="detail-sections-grid">
        <EditorialSection headline={headlineVal} description={descriptionVal} arena={arenaDetails} dateOfMoment={matchingPlay?.DateOfMoment} />
        <ProfileSection play={matchingPlay} />
        <BiographySection play={matchingPlay} renderTeamLink={matchingPlay ? renderTeamLink : null} />
        <AutographSection
          status={signedHere
            ? <span className="badge badge-success">Printed Autograph</span>
            : signedParallels.length > 0 ? <span className="text-muted">Not on this parallel</span> : null}
          signedOn={signedParallels.length > 0 ? signedParallels.join(", ") : null}
          signer={autographSigner}
          date={autographDate}
        />
        <SupplementSection data={supplementData} />
      </div>

      {/* Media Preview Overlay (videos with custom controls, plus images) */}
      <MediaOverlay media={overlayMedia} onClose={() => setOverlayMedia(null)} />
      <CubeOverlay cube={cubeOverlay} onClose={() => setCubeOverlay(null)} />

      <style>{`
        .edition-detail-container {
          max-width: 1100px;
          margin: 0 auto;
          width: 100%;
        }
        .edition-dashboard-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          margin-top: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .edition-dashboard-layout {
            grid-template-columns: 1fr;
            gap: 20px;
          }
        }
        .dashboard-column {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .hover-glow-nav {
          transition: var(--transition-smooth);
        }
        .hover-glow-nav:hover {
          color: #fff !important;
          text-shadow: 0 0 8px rgba(255, 255, 255, 0.4);
        }
        .prominent-media-card {
          padding: 24px;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .media-section-title {
          width: 100%;
          text-align: left;
          font-size: 1.2rem;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          padding-bottom: 10px;
        }
        /* The card's heading row: title left, the cube/video switch right */
        .media-head {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          padding-bottom: 10px;
        }
        .media-head .media-section-title {
          width: auto;
          margin: 0;
          border-bottom: none;
          padding-bottom: 0;
        }
        .media-mode-tabs {
          display: flex;
          gap: 6px;
        }
        .media-mode-tab {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          padding: 5px 12px;
          border-radius: 8px;
          font-size: 0.8rem;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
        }
        .media-mode-tab:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
        }
        .media-mode-tab.active {
          background: rgba(139, 92, 246, 0.15);
          border-color: rgba(139, 92, 246, 0.5);
          color: #fff;
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        /* The card centres its children and shrink-wraps them; the cube
           needs the full column to size its square against */
        .media-body {
          width: 100%;
        }
        .cube-inline-actions {
          display: flex;
          justify-content: center;
          margin-top: 8px;
        }
        .cube-inline-expand {
          background: none;
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: var(--text-muted);
          border-radius: 8px;
          padding: 4px 10px;
          font-size: 0.78rem;
          font-family: inherit;
          cursor: pointer;
        }
        .cube-inline-expand:hover {
          color: #fff;
          border-color: rgba(139, 92, 246, 0.5);
        }
        .video-wrapper {
          width: 100%;
          max-width: 360px;
          position: relative;
          border-radius: 12px;
          overflow: hidden;
          background: #000;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7), 0 0 20px rgba(139, 92, 246, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.1);
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .video-wrapper:hover {
          transform: translateY(-4px);
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.8), 0 0 30px rgba(139, 92, 246, 0.3);
          border-color: rgba(139, 92, 246, 0.3);
        }
        .embedded-video-player {
          width: 100%;
          display: block;
          outline: none;
          max-height: 520px;
        }
        .media-thumb-fallback {
          display: block;
          width: 100%;
          cursor: pointer;
        }
        .media-cube-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 12px;
          width: 100%;
          max-width: 360px;
        }
        .video-fallback-box {
          width: 100%;
          max-width: 360px;
          height: 200px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border: 2px dashed rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          background: rgba(0, 0, 0, 0.2);
        }
        .section-title-accent {
          font-size: 1.2rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          padding-bottom: 10px;
        }
        .toggler-panel {
          padding: 24px;
        }
        .toggler-pill {
          display: inline-block;
          padding: 8px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-muted);
          border-radius: 20px;
          font-size: 0.85rem;
          font-weight: 500;
          text-decoration: none;
          transition: all 0.2s ease;
        }
        .toggler-pill:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
          border-color: rgba(255, 255, 255, 0.2);
        }
        .toggler-pill.active {
          background: rgba(139, 92, 246, 0.15);
          border-color: var(--primary);
          color: var(--primary-hover);
          box-shadow: 0 0 12px rgba(139, 92, 246, 0.25);
        }
        .badge-standard {
          background: rgba(59, 130, 246, 0.1);
          color: #60a5fa;
          border: 1px solid rgba(59, 130, 246, 0.2);
        }
        .badge-parallel {
          background: rgba(139, 92, 246, 0.1);
          color: var(--primary-hover);
          border: 1px solid rgba(139, 92, 246, 0.2);
        }
        .ipfs-assets-table-container {
          overflow-x: auto;
          width: 100%;
        }
        .ipfs-assets-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
        }
        .ipfs-assets-table th,
        .ipfs-assets-table td {
          padding: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          vertical-align: middle;
        }
        .ipfs-assets-table th {
          font-size: 0.85rem;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          font-weight: 600;
        }
        .active-playing-row {
          background: rgba(139, 92, 246, 0.05);
        }
        .ipfs-link-anchor {
          color: var(--primary-hover);
          text-decoration: none;
          transition: var(--transition-smooth);
        }
        .ipfs-link-anchor:hover {
          color: var(--primary);
          text-decoration: underline;
        }
        .btn-action-small {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 500;
          cursor: pointer;
          transition: var(--transition-smooth);
        }
        .btn-action-small:hover:not(.disabled) {
          background: rgba(139, 92, 246, 0.15);
          border-color: var(--primary);
          color: var(--primary-hover);
          box-shadow: 0 0 10px rgba(139, 92, 246, 0.2);
        }
        .btn-action-small.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .py-20 {
          padding-top: 20px;
          padding-bottom: 20px;
        }
        .ml-8 {
          margin-left: 8px;
        }
      `}</style>
    </div>
  );
}

