import { useEffect, useRef, useState } from "react";
import { buildCubeConfig, resolveCubeFace } from "../services/cube.service";

/**
 * The cube trigger: a 96x96 hero thumbnail when derived media is on (the
 * one 512 file, browser scaled; docs/MEDIA-PIPELINE.md), the 🧊 glyph when it
 * is off or the thumb 404s. Same button, same overlay either way. onOpen
 * may be async (a player photo rebuilt from the hero fetches a multi-MB
 * file first); the button shows the wait and ignores clicks meanwhile.
 */
export function CubeTrigger({ thumb, onOpen, title }) {
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const showThumb = Boolean(thumb) && !broken;
  const open = (e) => {
    e.stopPropagation();
    if (busy) return;
    const r = onOpen();
    if (r && typeof r.then === "function") {
      setBusy(true);
      r.catch(() => {}).then(() => setBusy(false));
    }
  };
  return (
    <button
      className={`cube-btn${showThumb ? " cube-btn-thumb" : ""}`}
      title={busy ? "Rebuilding the player photo from the hero..." : title}
      onClick={open}
    >
      {showThumb ? (
        <img src={thumb} width="96" height="96" loading="lazy" alt="" onError={() => setBroken(true)} />
      ) : "🧊"}
      {busy && <span className="cube-busy">⏳</span>}
    </button>
  );
}

/**
 * The cube inline on a page (the edition page's media card): a square box
 * the width of its column hosting the MediaCube library, which idles
 * spinning and plays the front video as it passes. A "reconstruct" face
 * (player photo rebuilt from the hero) resolves before the mount. The
 * instance is destroyed on unmount or when the face changes, so callers
 * must pass a stable face object (memoised), not one built per render.
 */
export function MomentCubeView({ face, play, tier, title }) {
  const boxRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  useEffect(() => {
    if (!face || !play || !boxRef.current) return undefined;
    let instance = null;
    let cancelled = false;
    setStatus("loading");
    Promise.all([import("mediacube"), resolveCubeFace(face)])
      .then(([{ default: MediaCube }, resolved]) => {
        if (cancelled || !boxRef.current) return;
        if (!resolved) { setStatus("error"); return; }
        instance = new MediaCube(boxRef.current, buildCubeConfig(play, tier, resolved));
        setStatus("ready");
      })
      .catch((err) => {
        console.error("Failed to load the cube:", err);
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      if (instance) instance.destroy();
    };
  }, [face, play, tier]);
  return (
    <div className="cube-inline">
      <div ref={boxRef} className="cube-inline-box" title={title || "Drag to spin"} />
      {status === "loading" && <span className="cube-inline-note text-muted">Loading the cube...</span>}
      {status === "error" && <span className="cube-inline-note" style={{ color: "var(--status-danger)" }}>Could not load the cube.</span>}
    </div>
  );
}

