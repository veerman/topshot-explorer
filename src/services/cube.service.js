// The 3D moment cube's logic, shared by every editions table (set page,
// collection page): which media fronts the cube for an edition, the hero
// thumbnail for its trigger, and the MediaCube config themed with the
// player's team. The trigger cell is components/MomentCube, the overlay
// components/CubeOverlay.
import teamsAdditions from "../../data/additions/teams.json";
import { getMediaInfo } from "./ipfs.media";
import { reconstructPlayer } from "./ipfs.generate";
import { heroThumbUrl } from "./media.service";

// The cube's score face wants short team codes. The first three letters of
// the name read right for most franchises (TORonto, BOSton, MIAmi); the map
// covers the ones where that misreads or collides.
const TEAM_CODE_OVERRIDES = {
  "los angeles lakers": "LAL",
  "los angeles clippers": "LAC",
  "la clippers": "LAC",
  "los angeles sparks": "LAS",
  "las vegas aces": "LVA",
  "golden state warriors": "GSW",
  "oklahoma city thunder": "OKC",
  "new york knicks": "NYK",
  "new york liberty": "NYL",
  "new orleans pelicans": "NOP",
  "new orleans hornets": "NOH",
  "new jersey nets": "NJN",
  "san antonio spurs": "SAS",
  "phoenix suns": "PHX",
  "brooklyn nets": "BKN"
};
const teamCode = (name) => {
  const clean = String(name || "").trim();
  if (!clean) return "";
  return TEAM_CODE_OVERRIDES[clean.toLowerCase()] || clean.slice(0, 3).toUpperCase();
};

const CUBE_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const cubeDate = (dateOfMoment) => {
  const m = String(dateOfMoment || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${CUBE_MONTHS[Number(m[2]) - 1] || ""} ${Number(m[3])} '${m[1].slice(2)}`;
};

const CUBE_TIERS = new Set(["common", "rare", "fandom", "legendary", "ultimate"]);

/**
 * Video trim for the cube face, like the reference cube: 1s off the
 * front (intro fade) and 6.8s off the back (slow-mo outro/fade tail),
 * scaled back so at least ~6 seconds of play always remain. Negative
 * endTime counts from the clip's end (mediacube semantics). Unprobed
 * clips get a gentle 1s / -2s trim; the library clamps both against the
 * real duration at load.
 */
function cubeVideoTrim(durSecs) {
  if (!Number.isFinite(durSecs) || durSecs <= 0) return { startTime: 1, endTime: -2 };
  const startTime = durSecs >= 8 ? 1 : 0;
  let endTrim = 6.8;
  if (durSecs - startTime - endTrim < 6) endTrim = Math.max(0, durSecs - startTime - 6);
  return { startTime, endTime: endTrim > 0 ? -endTrim : 0 };
}

/**
 * MediaCube config for one edition: the square video on the front (or the
 * player photo when the edition has no square video; no text overlay on
 * that side, just the tier frame), play category + game date, the final
 * score, and the jersey number, all themed with the player's team colour
 * and emoji from teams.json.
 */
export function buildCubeConfig(play, tier, face) {
  const team = teamsAdditions[String(play.TeamAtMomentNBAID)] || {};
  const color = team.color || "#8b5cf6";
  const emoji = team.emoji || "🏀";
  const t = String(tier || "").toLowerCase();
  const cubeTier = CUBE_TIERS.has(t) ? t : "common";
  const card = { tier: cubeTier, colorCube: color, colorFrame: color };

  // Glow escalates with the tier: flat cubes by default,
  // legendary breathes, ultimate gets a quiet sweeping shine instead
  const glow =
    cubeTier === "legendary"
      ? { cubeGlowSize: "8px", glowSpread: "3px", livingGlow: { intensity: 2, spread: 1, speed: 1.75 } }
      : cubeTier === "ultimate"
        ? { cubeGlowSize: "0px", livingGlow: false, shine: { opacity: 0.05, angle: 90, speed: 4 } }
        : { cubeGlowSize: "0px" };

  const config = {
    // The idle spin is the loading indicator: the cube keeps turning
    // until the clip can play, then turns onto it
    settings: { colorCubeGlow: color, loadingPlaceholder: { videoText: "▶" }, waitForVideo: true, arriveMs: 300, ...glow },
    core: { text: emoji, style: `color: ${color}; font-size: 45%; text-shadow: 0 0 0.04em ${color}, 0 0 0.08em ${color};` },
    side_1: [
      // IPFS gateway URLs carry no file extension, so the kind is explicit
      face.type === "video"
        ? { type: "video", src: face.src, style: "width: 78%; height: 78%;", ...cubeVideoTrim(face.duration) }
        : { type: "image", src: face.src, style: "width: 78%; height: 78%;" },
      { ...card }
    ],
    side_2: {
      ...card,
      layout: "center-emoji",
      text: {
        "tpl-line1": String(play.PlayCategory || play.PlayType || "").toUpperCase(),
        "tpl-line2": "",
        "tpl-emoji": emoji,
        "tpl-line3": cubeDate(play.DateOfMoment)
      }
    }
  };

  const home = parseInt(play.HomeTeamScore);
  const away = parseInt(play.AwayTeamScore);
  config.side_3 = Number.isFinite(home) && Number.isFinite(away)
    ? {
        ...card,
        layout: "score",
        text: {
          "tpl-home-score": String(home),
          "tpl-away-score": String(away),
          "tpl-home-team": teamCode(play.HomeTeamName),
          "tpl-away-team": teamCode(play.AwayTeamName),
          "tpl-footer": "FINAL SCORE"
        }
      }
    : { ...card };

  const jersey = String(play.JerseyNumber || "").trim();
  config.side_4 = jersey
    ? [
        { type: "text", text: jersey, style: `color: ${color}; font-size: 62%; font-weight: 900; font-family: Impact, "Arial Black", sans-serif; text-shadow: 0 0 0.03em ${color};` },
        { ...card }
      ]
    : { ...card };

  return config;
}

export const gatewayUrl = (cid) => `https://ipfs.dapperlabs.com/ipfs/${cid}`;

/** Live at the gateway = not on the known-dead list (unknown passes) */
export const isLiveCid = (cid, ipfsMedia) => Boolean(cid) && !(ipfsMedia && ipfsMedia.media[cid] === 0);

/**
 * Which media fronts the cube for an edition, or null when nothing can:
 * the square video when the edition has a live one; otherwise the player
 * photo, in order of preference the official PLAYER image (when it is a
 * real photo, not a silhouette), one rebuilt from the hero (series 7+,
 * hero not itself a photo), or a hero that is itself a raw photo. The
 * image fallbacks wait for the media lookup so a silhouette is never
 * mistaken for a photo. `silhouettePlayer` overrides the baked flag when
 * the caller has a runtime verdict (the set page probes new editions).
 */
export function cubeFaceFor({ cids, ipfsMedia, series, silhouettePlayer }) {
  if (!cids) return null;
  const isLive = (cid) => isLiveCid(cid, ipfsMedia);
  const heroGatewayUrl = cids.HERO ? gatewayUrl(cids.HERO) : null;
  const playerInfo = cids.PLAYER && ipfsMedia ? getMediaInfo(cids.PLAYER) : null;
  const heroIsPhoto = Boolean(cids.HERO && ipfsMedia && getMediaInfo(cids.HERO)?.fullBleed);
  const silhouette = silhouettePlayer !== undefined ? silhouettePlayer : Boolean(playerInfo && playerInfo.silhouette);
  const canRebuildPlayer = Boolean(silhouette && isLive(cids.PLAYER) && isLive(cids.HERO) && Number(series) >= 7 && !heroIsPhoto);

  const cubeVideoCid = isLive(cids.VIDEO_SQUARE) ? cids.VIDEO_SQUARE : null;
  if (cubeVideoCid) {
    return { type: "video", src: gatewayUrl(cubeVideoCid), duration: getMediaInfo(cubeVideoCid)?.duration, title: "Open the 3D moment cube" };
  }
  if (ipfsMedia && cids.PLAYER && isLive(cids.PLAYER) && !silhouette) {
    return { type: "image", src: gatewayUrl(cids.PLAYER), title: "Open the 3D moment cube (no square video: the player photo fronts it)" };
  }
  if (canRebuildPlayer) {
    return { type: "reconstruct", heroUrl: heroGatewayUrl, playerUrl: gatewayUrl(cids.PLAYER), title: "Open the 3D moment cube (no square video: a player photo rebuilt from the hero fronts it)" };
  }
  if (ipfsMedia && heroIsPhoto && isLive(cids.HERO)) {
    return { type: "image", src: heroGatewayUrl, title: "Open the 3D moment cube (no square video: the hero photo fronts it)" };
  }
  return null;
}

/** The hero thumbnail for the trigger, when derived media is on and the hero is live */
export const cubeThumbFor = (cids, ipfsMedia) => (cids && isLiveCid(cids.HERO, ipfsMedia) ? heroThumbUrl(cids.HERO) : null);

/**
 * A face ready for buildCubeConfig: a "reconstruct" face first rebuilds
 * the player photo from the hero (multi-MB fetch), falling back to the
 * hero itself when the rebuild says the hero is already a photo. Returns
 * null when nothing usable came out.
 */
export async function resolveCubeFace(face) {
  if (!face || face.type !== "reconstruct") return face;
  try {
    const res = await reconstructPlayer(face.heroUrl, face.playerUrl);
    return { type: "image", src: res.url };
  } catch (err) {
    if (!err?.photoHero) {
      console.warn("cube player photo rebuild failed:", err);
      return null;
    }
    return { type: "image", src: face.heroUrl };
  }
}

