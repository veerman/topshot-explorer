// IPFS media coverage analysis.
//
// Coverage model (2026-09-01, replaces the inferred series-peer baseline):
// Dapper's de facto standard, visible across the whole dataset, is FOUR
// core files per edition: HERO, PLAYER, VIDEO, VIDEO_SQUARE. Whenever an
// edition has any media at all, it has those four 95%+ of the time, so the
// headline percentage scores the core four only: "share of the standard
// four media files present". Everything else (VIDEO_TALL, VIDEO_VERTICAL,
// IMAGE_PLAYER) is treated as EXTRAS: never expected, surfaced separately,
// because expecting seven assets on every edition is not a standard Dapper
// ever held. A CID registered on chain but dead at the gateway
// (data/ipfs_dead.json, from the 2026-08-29 probe) counts as missing.
// Mismint editions (plays_exclude.json) are excluded entirely.
import playsExclude from "../../data/plays_exclude.json";
import ipfsDead from "../../data/ipfs_dead.json";

const mismintPlayIDs = new Set(playsExclude.map(String));
const DEAD_CIDS = new Set(ipfsDead);

export function isMismintPlay(playID) {
  return mismintPlayIDs.has(String(playID));
}

// Registered on chain but the gateway serves no content (static list from
// the probe run; the full per-CID lookup lives in ipfs.media.js)
export function isDeadMediaCid(cid) {
  return DEAD_CIDS.has(cid);
}

// The de facto Dapper standard: two images + two videos
export const CORE_MEDIA_FIELDS = ["HERO", "PLAYER", "VIDEO", "VIDEO_SQUARE"];

export const MEDIA_TYPE_PRIORITY = [
  "HERO",
  "PLAYER",
  "IMAGE_PLAYER",
  "VIDEO",
  "VIDEO_SQUARE",
  "VIDEO_TALL",
  "VIDEO_VERTICAL"
];

// Extras labels describe what the files actually are (per the probe
// analysis in docs/IPFS-ANALYSIS.md); the old "Video LQ"/"Video HQ"/"Player HQ"
// names were guesses the data contradicts
export const MEDIA_TYPE_LABELS = {
  "HERO": "🖼️ Hero",
  "PLAYER": "🖼️ Player",
  "IMAGE_PLAYER": "🖼️ Player Source",
  "VIDEO": "🎥 Video",
  "VIDEO_SQUARE": "🎥 Video Square",
  "VIDEO_TALL": "🎥 Video Tall",
  "VIDEO_VERTICAL": "🎥 Video Vertical"
};

export function getMediaTypeLabel(mediaType) {
  const upper = String(mediaType).toUpperCase();
  return MEDIA_TYPE_LABELS[upper] || `IPFS ${upper}`;
}

// Known types first in canonical order, unknown ones alphabetically after
export function sortMediaTypes(types) {
  return [...types].sort((a, b) => {
    const idxA = MEDIA_TYPE_PRIORITY.indexOf(String(a).toUpperCase());
    const idxB = MEDIA_TYPE_PRIORITY.indexOf(String(b).toUpperCase());
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return String(a).localeCompare(String(b));
  });
}

const aliveCid = (cid) => Boolean(cid) && !DEAD_CIDS.has(cid);

/**
 * Coverage for a single set. eligiblePlayIDs is the set's full edition play
 * list (mismints are filtered out here); setIpfsRecords are that set's rows
 * from the ipfs store.
 *
 * Returns { pct (core-four headline), corePresent, coreTotal,
 * eligibleCount, expectedFields (core + extras this set carries, for table
 * columns and chips), missingByField (over expectedFields), missingCells
 * (core only), extras {field: {present, total}}, extrasCount, deadCells,
 * editionsNoMedia, excludedMismints }.
 */
export function computeSetCoverage(eligiblePlayIDs, setIpfsRecords) {
  const cidsByPlay = new Map();
  (setIpfsRecords || []).forEach((rec) => {
    cidsByPlay.set(String(Number(rec.playID)), rec.cids || {});
  });

  const allPlayIDs = (eligiblePlayIDs || []).map((p) => String(Number(p)));
  const eligible = allPlayIDs.filter((p) => !mismintPlayIDs.has(p));

  // Extras = any non-core field alive on at least one of this set's editions
  const extrasSeen = new Set();
  eligible.forEach((p) => {
    const cids = cidsByPlay.get(p);
    if (!cids) return;
    Object.keys(cids).forEach((f) => {
      if (!CORE_MEDIA_FIELDS.includes(f) && aliveCid(cids[f])) extrasSeen.add(f);
    });
  });

  const expectedFields = [...CORE_MEDIA_FIELDS, ...sortMediaTypes(Array.from(extrasSeen))];
  const missingByField = {};
  const deadByField = {};
  expectedFields.forEach((f) => { missingByField[f] = 0; deadByField[f] = 0; });
  const extras = {};
  extrasSeen.forEach((f) => { extras[f] = { present: 0, total: eligible.length }; });

  let corePresent = 0;
  let deadCells = 0;
  let editionsNoMedia = 0;

  eligible.forEach((p) => {
    const cids = cidsByPlay.get(p) || {};
    let presentForEdition = 0;
    expectedFields.forEach((f) => {
      const cid = cids[f];
      if (aliveCid(cid)) {
        presentForEdition++;
        if (CORE_MEDIA_FIELDS.includes(f)) corePresent++;
        else extras[f].present++;
      } else {
        missingByField[f]++;
        if (cid) { deadCells++; deadByField[f]++; }
      }
    });
    if (presentForEdition === 0) editionsNoMedia++;
  });

  const coreTotal = eligible.length * CORE_MEDIA_FIELDS.length;
  return {
    pct: eligible.length > 0 ? (corePresent / coreTotal) * 100 : null,
    corePresent,
    coreTotal,
    eligibleCount: eligible.length,
    expectedFields,
    missingByField,
    deadByField,
    missingCells: coreTotal - corePresent,
    extras,
    extrasCount: extrasSeen.size,
    deadCells,
    editionsNoMedia,
    excludedMismints: allPlayIDs.length - eligible.length
  };
}

/**
 * Coverage for every set at once (Sets page). Returns Map<setID(number),
 * coverage>. An empty ipfs store returns an empty map, so an unsynced
 * database renders "-" instead of scoring every set 0%.
 */
export function computeIpfsCoverageForSets(sets, ipfsRecords) {
  const coverageBySet = new Map();
  if (!ipfsRecords || ipfsRecords.length === 0) return coverageBySet;

  const recordsBySet = new Map();
  ipfsRecords.forEach((rec) => {
    const sid = Number(rec.setID);
    if (!recordsBySet.has(sid)) recordsBySet.set(sid, []);
    recordsBySet.get(sid).push(rec);
  });

  (sets || []).forEach((set) => {
    const sid = Number(set.id);
    coverageBySet.set(sid, computeSetCoverage(
      set.playIDs || [],
      recordsBySet.get(sid) || []
    ));
  });
  return coverageBySet;
}

// Formats a percentage without ever rounding a partial value up to "100"
export function formatCoveragePct(pct) {
  if (pct === null || pct === undefined) return "-";
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= 100) return "100";
  const floored = Math.floor(clamped * 10) / 10;
  return floored % 1 === 0 ? floored.toFixed(0) : floored.toFixed(1);
}

// Plain-text summary used as a hover tooltip on the Sets page IPFS column
export function buildCoverageTooltip(coverage) {
  if (!coverage || coverage.pct === null) {
    return "No IPFS media synced for this set yet";
  }
  const lines = [];
  if (coverage.missingCells === 0) {
    lines.push(`All core media present (Hero, Player, Video, Video Square x ${coverage.eligibleCount} editions)`);
  } else {
    lines.push(`Core media (Hero, Player, Video, Video Square): missing ${coverage.missingCells} of ${coverage.coreTotal} files:`);
    CORE_MEDIA_FIELDS.forEach((f) => {
      const missing = coverage.missingByField[f] || 0;
      if (missing > 0) lines.push(`  ${getMediaTypeLabel(f)}: ${missing} missing`);
    });
  }
  const extraFields = Object.keys(coverage.extras || {});
  if (extraFields.length > 0) {
    const parts = sortMediaTypes(extraFields).map((f) => `${getMediaTypeLabel(f)} ${coverage.extras[f].present}/${coverage.extras[f].total}`);
    lines.push(`Extras: ${parts.join(", ")}`);
  }
  if (coverage.deadCells > 0) {
    lines.push(`${coverage.deadCells} registered file(s) are missing at the IPFS gateway`);
  }
  if (coverage.editionsNoMedia > 0) {
    lines.push(`${coverage.editionsNoMedia} edition(s) have no IPFS media at all`);
  }
  if (coverage.excludedMismints > 0) {
    lines.push(`(${coverage.excludedMismints} mismint edition(s) excluded)`);
  }
  return lines.join("\n");
}

/** Live core files of an edition, and live extras, for sorting and filters */
export function mediaCounts(cids, ipfsMedia) {
  const all = cids || {};
  const isLive = (cid) => cid && !(ipfsMedia && ipfsMedia.media[cid] === 0);
  const extras = sortMediaTypes(Object.keys(all)).filter((t) => !CORE_MEDIA_FIELDS.includes(t) && all[t]);
  return {
    core: CORE_MEDIA_FIELDS.filter((f) => isLive(all[f])).length,
    extras: extras.filter((t) => isLive(all[t])).length
  };
}
