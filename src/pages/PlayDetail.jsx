import { playSigned, signedSubs } from "../services/autograph.service";
import { EditorialSection, ProfileSection, BiographySection, AutographSection, SupplementSection } from "../components/PlayInfoSections";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchPlayBatch, getSetsOverview, subeditionLabel } from "../services/fcl.service";
import { getRecord, getAllPlaysDB, getAllSetsDB, getAllTeamsDB } from "../services/db.service";
import { isMismintPlay } from "../services/overrides.service";
import playsAdditions from "../../data/additions/plays.json";
import { resolveVenue, getCalculatedPlayTags, compilePlayMetadata, parseMomentDate, playRewardEditions, badgeDef } from "../services/overrides.service";
import { buildTeamNameMap, getLeagueBadge, renderTeamLink as renderTeamLinkShared, getTierBadgeClass, scrubSentinels, buildMatchupSides, renderMatchupCell, formatDateISO, buildSeriesSeasonMap, seasonHintForPlay, getSeasonFallback, renderSeasonChip, playerPath } from "../utils/display.utils";

export function PlayDetail() {
  const { playID } = useParams();
  const [playMeta, setPlayMeta] = useState(null);
  const [allPlays, setAllPlays] = useState([]);
  const [matchingSets, setMatchingSets] = useState([]);

  const supplementData = useMemo(() => {
    if (!playMeta || !allPlays || allPlays.length === 0) return null;
    const pID = String(playID);
    const staticAdditions = playsAdditions[pID] || {};
    const calculatedPlayTags = getCalculatedPlayTags(playMeta, allPlays);
    // Edition-level badges (rewards) ride along naming their edition,
    // since they belong to one set of the play, not to the play itself
    const setName = (sid) => (matchingSets.find((s) => Number(s.id) === sid) || {}).setName || `Set #${sid}`;
    const editionTagsNamed = playRewardEditions(pID).flatMap(({ setID, tags }) => tags.map((t) => `${t}: ${setName(setID)} (${setID}_${pID})`));
    return {
      ...staticAdditions,
      tags: [...calculatedPlayTags, ...editionTagsNamed]
    };
  }, [playID, playMeta, allPlays, matchingSets]);
  const [allSets, setAllSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [teamNameMap, setTeamNameMap] = useState({});

  // Load team name to NBA ID map for team profile links
  useEffect(() => {
    const loadTeams = async () => {
      try {
        const allTeams = await getAllTeamsDB();
        setTeamNameMap(buildTeamNameMap(allTeams));
      } catch (err) {
        console.error("Failed to load team list for detail links:", err);
      }
    };
    loadTeams();
  }, []);

  const renderTeamLink = (teamName, isHighlight = false, emojiStar = "") =>
    renderTeamLinkShared(teamName, teamNameMap, {
      isHighlight,
      emojiStar,
      resolveHistoricalName: true,
      dateOfMoment: playMeta?.DateOfMoment
    });

  // Guards against a stale async load (fast navigation between plays)
  // overwriting the newer play's state
  const loadSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++loadSeqRef.current;
    const isStale = () => seq !== loadSeqRef.current;

    const loadPlayData = async () => {
      // Reset previous play's data so a failed load never shows the prior
      // record under the new URL
      setLoading(true);
      setError(null);
      setPlayMeta(null);
      setMatchingSets([]);

      try {
        // 1. Attempt to fetch from IndexedDB offline plays store
        let metadata = null;
        try {
          metadata = await getRecord("plays", Number(playID));
          if (!metadata) {
            metadata = await getRecord("plays", String(playID));
          }
          const list = await getAllPlaysDB();
          if (isStale()) return;
          setAllPlays(list);
        } catch (e) {
          console.error("Failed to read from IndexedDB plays cache:", e);
        }

        // 2. Fetch directly on-chain if not found in cache, running the raw
        // metadata through the same overrides/normalization pipeline the
        // sync coordinator applies
        if (!metadata) {
          const batch = await fetchPlayBatch([playID]);
          if (batch && batch[0] && batch[0].metadata) {
            metadata = compilePlayMetadata(playID, batch[0].metadata);
          }
        }
        if (isStale()) return;

        if (!metadata) {
          setError(`Play ID #${playID} metadata could not be fetched on-chain.`);
          setLoading(false);
          return;
        }

        setPlayMeta(scrubSentinels(metadata));

        // 3. Find sets this play appears in (offline-first from IndexedDB,
        // live chain query only when the local sets store is empty)
        let setsList = [];
        try {
          setsList = await getAllSetsDB();
        } catch (e) {
          console.warn("Failed reading sets from IndexedDB:", e);
        }
        if (!setsList || setsList.length === 0) {
          setsList = await getSetsOverview();
        }
        if (isStale()) return;
        setAllSets(setsList);
        const appearances = setsList.filter((set) =>
          (set.playIDs || []).some((id) => String(id) === String(playID))
        );
        setMatchingSets(appearances);
      } catch (err) {
        if (isStale()) return;
        console.error("Error loading play detail:", err);
        setError("An error occurred connecting to the Flow blockchain.");
      } finally {
        if (!isStale()) setLoading(false);
      }
    };

    loadPlayData();
  }, [playID]);

  const isMismint = isMismintPlay(playID);

  // Season fallback for undated plays: shown as a chip, never as a date
  const seasonFallback = useMemo(() => {
    if (!playMeta || playMeta.DateOfMoment) return null;
    const mapping = {};
    allSets.forEach((set) => (set.playIDs || []).forEach((pid) => {
      (mapping[pid] = mapping[pid] || []).push({ series: set.series });
    }));
    const seriesSeasonMap = buildSeriesSeasonMap(allPlays, mapping);
    return getSeasonFallback(playMeta, seasonHintForPlay(playMeta, matchingSets, seriesSeasonMap));
  }, [playMeta, allPlays, allSets, matchingSets]);

  if (loading) {
    return (
      <Loader message={<>Loading metadata for Play ID #{playID}...</>} />
    );
  }

  if (error) {
    return (
      <LoadError title="⚠️ Fetch Error" message={error}>
        <Link to="/plays" className="btn-primary mt-20">← Back to Plays</Link>
      </LoadError>
    );
  }



  const rawHomeTeam = playMeta.HomeTeamName;
  const rawTeamAtMoment = playMeta.TeamAtMoment;

  const homeTeamId = rawHomeTeam ? teamNameMap[rawHomeTeam.trim().toLowerCase()] : null;
  const homeTeamDetails = homeTeamId ? resolveVenue(homeTeamId, playMeta.DateOfMoment) : null;
  const teamId = rawTeamAtMoment ? teamNameMap[rawTeamAtMoment.trim().toLowerCase()] : null;
  const teamDetails = teamId ? resolveVenue(teamId, playMeta.DateOfMoment) : null;
  const arenaDetails = homeTeamDetails || teamDetails;

  // Generate Set Links cell
  const setsCell = matchingSets.length > 0 ? (
    <div className="d-flex flex-wrap gap-8">
      {matchingSets.map((s) => {
        // Straight to this play's edition in the set (the collapsed view when
        // the set has parallels), not the set's full listing. A reward
        // edition carries its badge glyph: the badge is the edition's
        const reward = (playRewardEditions(playID).find((r) => r.setID === Number(s.id)) || {}).tags;
        return (
          <Link key={s.id} to={`/editions/${s.id}_${playID}`} className="set-link" style={{ fontSize: "0.8rem" }} title={`${s.setName} (Series ${s.series})${reward ? `; ${reward.join(", ")}` : ""}`}>
            #{s.id} {s.setName}
            {reward && <span className="set-link-mark">{reward.map((t) => (badgeDef(t) || {}).emoji || "").join("")}</span>}
          </Link>
        );
      })}
    </div>
  ) : (
    <span className="text-muted">-</span>
  );

  const autographDate = playMeta.PlayerAutographDate || playMeta.Date;
  const autographSigner = playMeta.PlayerAutographSigner || playMeta.Signer;
  // The autograph is a fact of an edition's parallel (data/autographs.json);
  // the play page names the signed editions, and shows nothing when none is
  const signedEditions = matchingSets.flatMap((s) => {
    const subs = signedSubs(s.id, playID);
    if (!subs) return [];
    const one = subs.length === 1 && subs[0] !== 0 ? `_${subs[0]}` : "";
    return [(
      <Link key={s.id} to={`/editions/${s.id}_${playID}${one}`} className="set-link" style={{ fontSize: "0.8rem" }}>
        #{s.id} {s.setName}{subs.length === 1 && subs[0] === 0 ? "" : ` (${subs.map((sub) => subeditionLabel(sub)).join(", ")})`}
      </Link>
    )];
  });
  const autographSigned = playSigned(playID) && signedEditions.length > 0;

  // PlayCategory and PlayType are frequently the same string ("3 Pointer"),
  // so collapse them rather than printing the value twice.
  const playTypeLabel = [...new Set(
    [playMeta.PlayCategory, playMeta.PlayType]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  )].join(" • ");

  const headlineVal = playMeta.headline || playMeta.Headline || playMeta.OverrideHeadline || "";
  const descriptionVal = playMeta.description || playMeta.Description || playMeta.Tagline || "";
  // A team moment is titled with its team's name (linked to the team page)
  const playerName = playMeta.FullName && playMeta.FullName.trim() !== "" ? playMeta.FullName.trim() : "";
  const isTeamMoment = !playerName;
  const teamMomentName = playMeta.TeamAtMoment && playMeta.TeamAtMoment.trim() !== "" ? playMeta.TeamAtMoment.trim() : "";
  const displayName = playerName || teamMomentName || "Team Moment";

  return (
    <div className="play-detail-container">
      <div className="d-flex align-center gap-10" style={{ marginBottom: "20px" }}>
        <Link to="/plays" className="text-muted">← Back to Plays</Link>
      </div>

      {/* Header Panel */}
      <div className={`glass-panel detail-header ${isMismint ? "border-mismint" : ""}`}>
        <div className="d-flex align-center justify-between flex-wrap gap-10">
          <div>
            <div className="d-flex align-center gap-10 flex-wrap">
              <span className="play-id-tag">Play #{playID}</span>
              {supplementData?.tier && (
                <span className={`badge ${getTierBadgeClass(supplementData.tier)}`} style={{ textTransform: "uppercase" }}>
                  {supplementData.tier}
                </span>
              )}
              {getLeagueBadge(playMeta.TeamAtMoment)}
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
              {!isTeamMoment && <>{playTypeLabel && " • "}{renderTeamLink(playMeta.TeamAtMoment)}</>}
            </p>
          </div>
        </div>

        {/* Sets sit in the header: this page is mostly used as a jumping-off
            point to them, so they should not be buried in the panels below. */}
        <div className="header-sets-row">
          <span className="header-sets-label">
            {matchingSets.length === 1 ? "Set" : "Sets"}
          </span>
          <div className="header-sets-links">{setsCell}</div>
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

      {/* Game panel. Play ID, player name, type and sets all live in the
          header above, so this carries only what the header does not. */}
      <div className="glass-panel core-summary-panel mt-20">
        <h3>Game</h3>
        <div className="summary-item matchup-summary-item matchup-summary-wide mt-20">
          <span className="summary-label">Matchup</span>
          <span className="summary-value">
            {renderMatchupCell(buildMatchupSides(playMeta, teamNameMap, {
              resolveHistoricalName: true,
              dateOfMoment: playMeta.DateOfMoment
            }))}
          </span>
        </div>
        <div className="summary-grid summary-grid-aligned mt-12" style={{ "--rows": 1 }}>
            <div className="summary-item">
              <span className="summary-label">Date</span>
              <span className="summary-value">
                {(() => {
                  if (!playMeta.DateOfMoment) {
                    return seasonFallback ? renderSeasonChip(seasonFallback) : "-";
                  }
                  const dateMatch = String(playMeta.DateOfMoment).match(/^(\d{4})-(\d{2})-(\d{2})/);
                  const dObj = parseMomentDate(playMeta.DateOfMoment);
                  const label = dObj ? formatDateISO(dObj) : playMeta.DateOfMoment;
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
              <span className="summary-value font-mono">{playMeta.NbaSeason || "-"}</span>
            </div>
        </div>
      </div>

      {/* The shared groups (components/PlayInfoSections): editorial across
          the width, profile and biography side by side, the autograph only
          when an edition is signed, the off-chain supplement last */}
      <div className="detail-sections-grid">
        <EditorialSection headline={headlineVal} description={descriptionVal} arena={arenaDetails} dateOfMoment={playMeta.DateOfMoment} />
        <ProfileSection play={playMeta} />
        <BiographySection play={playMeta} renderTeamLink={renderTeamLink} />
        <AutographSection
          status={autographSigned ? <span className="badge badge-success">Printed Autograph</span> : null}
          signedOn={autographSigned ? <span className="d-flex flex-wrap gap-6 justify-end">{signedEditions}</span> : null}
          signer={autographSigner}
          date={autographDate}
        />
        <SupplementSection data={supplementData} />
      </div>

      <style>{`
        .play-detail-container {
          max-width: 1100px;
          margin: 0 auto;
          width: 100%;
        }
        .header-sets-row {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 18px;
          padding-top: 16px;
          border-top: 1px solid rgba(255,255,255,0.06);
        }
        .header-sets-label {
          color: var(--text-muted);
          font-size: 0.8rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }
        .header-sets-links .set-link {
          font-size: 0.9rem;
          padding: 5px 10px;
        }
      `}</style>
    </div>
  );
}
