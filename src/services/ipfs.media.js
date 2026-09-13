// Per-CID media metadata from data/ipfs_media.json (distilled from the
// IPFS probe run, scripts/probe-missing.mjs). The file is
// ~5MB, so it is dynamic-imported on first use and never rides in the
// main bundle. CIDs are content-addressed: entries never go stale.
//
// Entry shapes (type first):
//   image: ["jpg"|"png"|"mpo", width, height, bytes|null, author?, camera?, photoDate?, silhouette?, fullBleed?]
//   video: ["mp4", width, height, bytes|null, durationSeconds, videoKbps|null, audioKbps (0 = silent)]
//   dead:  0 (registered on chain, but the gateway serves no media)
// silhouette (index 7): 1 when the image is a colorless (black/white/
// transparent only) player silhouette, mostly the S8 b/w cutout style;
// written by scripts/mark-image-flags.mjs from the colour + border
// censuses.
// fullBleed (index 8): 1 when the image has no uniform border/padding on
// at least one side; a full-bleed HERO is a raw play photograph with no
// cube render in it, so nothing can be extracted from it; written by
// scripts/mark-image-flags.mjs from the border census.

let loadPromise = null;
let state = null; // { media: object, probedAt: string }

export function loadIpfsMedia() {
  if (!loadPromise) {
    loadPromise = import("../../data/ipfs_media.json").then((mod) => {
      const data = mod.default || mod;
      const probedAt = (String(data._meta?.source || "").match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;
      state = { media: data.media || {}, probedAt };
      return state;
    }).catch((err) => {
      console.warn("Failed to load ipfs_media.json:", err);
      loadPromise = null; // allow a retry on next call
      throw err;
    });
  }
  return loadPromise;
}

export function getIpfsMediaState() {
  return state;
}

// Videos: {kind:"video", width, height, bytes, duration, videoKbps, audioKbps}
// Images: {kind:"image", format, width, height, bytes, author, camera, shot, silhouette, fullBleed}
export function getMediaInfo(cid) {
  if (!state) return null;
  const e = state.media[cid];
  if (!Array.isArray(e)) return null;
  if (e[0] === "mp4") {
    return { kind: "video", width: e[1], height: e[2], bytes: e[3], duration: e[4], videoKbps: e[5], audioKbps: e[6] || 0 };
  }
  return { kind: "image", format: e[0] || null, width: e[1], height: e[2], bytes: e[3], author: e[4] || null, camera: e[5] || null, shot: e[6] || null, silhouette: e[7] === 1, fullBleed: e[8] === 1 };
}

function fmtBytes(bytes) {
  if (bytes == null) return null;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Two compact lines for table cells: "JPG · 2880x2880" over "342 KB", or
// "MP4 · 1080x1920" over "36s · 30 MB" (~ marks a bitrate-estimated size).
// Null when the lookup has not loaded or the CID is unknown/dead.
export function mediaCellLines(cid) {
  const info = getMediaInfo(cid);
  if (!info) return null;
  if (info.kind === "video") {
    const bytes = info.bytes != null
      ? fmtBytes(info.bytes)
      : (info.videoKbps ? `~${fmtBytes(info.duration * (info.videoKbps + info.audioKbps) * 125)}` : null);
    // Size first, duration after, so image and video lines read alike
    return {
      top: `MP4 · ${info.width}x${info.height}`,
      bottom: `${bytes ? `${bytes} · ` : ""}${Math.round(info.duration)}s`
    };
  }
  return {
    top: `${(info.format || "img").toUpperCase()} · ${info.width}x${info.height}`,
    bottom: fmtBytes(info.bytes) || ""
  };
}

// One-line description for tooltips: "1080x1920 · 36s · 30.2 MB · audio ·
// confirmed at the gateway 2026-08-29". Estimates size from bitrates when
// the probe did not capture it.
export function describeMedia(cid) {
  if (!state) return null;
  if (state.media[cid] === 0) {
    return `Registered on chain, but the IPFS gateway serves no content for this CID (checked ${state.probedAt})`;
  }
  const info = getMediaInfo(cid);
  if (!info) return null;
  const parts = [`${info.width}x${info.height}`];
  if (info.kind === "video") {
    parts.push(`${Math.round(info.duration)}s`);
    const bytes = info.bytes != null
      ? fmtBytes(info.bytes)
      : (info.videoKbps ? `~${fmtBytes(info.duration * (info.videoKbps + info.audioKbps) * 125)}` : null);
    if (bytes) parts.push(bytes);
    parts.push(info.audioKbps > 0 ? "audio" : "silent");
  } else {
    if (info.format) parts.push(info.format.toUpperCase());
    const bytes = fmtBytes(info.bytes);
    if (bytes) parts.push(bytes);
    // Photographer credit and shoot details, from EXIF where Dapper left it in
    if (info.author) parts.push(`photo: ${info.author}`);
    if (info.shot) parts.push(`shot ${info.shot}${info.camera ? ` on ${info.camera}` : ""}`);
    else if (info.camera) parts.push(`shot on ${info.camera}`);
  }
  if (state.probedAt) parts.push(`confirmed at the gateway ${state.probedAt}`);
  return parts.join(" · ");
}
