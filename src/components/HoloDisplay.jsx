import { useEffect, useRef, useState } from "react";

/**
 * Source display for a four-sided hologram pyramid (the acrylic pyramids
 * sold for phones and tablets): the moment on the four sides of a black
 * 3x3 grid, each panel rotated to face its pyramid side and mirrored so
 * the reflection reads the right way round, the centre and corners
 * black. Lay the pyramid on the screen, point up, and the four
 * reflections meet as one floating object. Two modes:
 *
 * - video: the clip four times, in sync, looping on the cube's trim.
 * - cube: four MediaCube instances of the same config showing the same
 *   thing at the same time, like the video. One cube is the master (idle
 *   spin, snap to the video face, play); the other three are followers
 *   whose orientation is copied from the master every frame and whose
 *   videos are kept on the master's clock. Nothing is integrated on the
 *   followers, so they cannot drift.
 *
 * In cube mode the strip along the top, between the close button and
 * the mode buttons, is a touch pad for spinning the cube: a horizontal
 * drag there is forwarded to the master cube as pointer events with the
 * vertical coordinate frozen, so it turns exactly as a drag on the cube
 * would (same speed, same fling, same snap) but only about the vertical
 * axis, and without a finger over the panel the pyramid is sitting on.
 *
 * Full screen while open; Esc or the corner button closes it. The screen
 * is kept awake where the browser allows it.
 */
const SIDES = [
  { key: "n", row: 1, col: 2, rotate: 180 },
  { key: "w", row: 2, col: 1, rotate: 90 },
  { key: "e", row: 2, col: 3, rotate: 270 },
  { key: "s", row: 3, col: 2, rotate: 0 }
];
const MASTER = 3; // the south panel, unrotated, the one a finger can reach
const PAD_POINTER_ID = -1; // never a real pointer; see padForward

/** The cube's trim: 1 s off the front, 6.8 s off the tail, at least 6 s kept */
function loopWindow(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const start = duration >= 8 ? 1 : 0;
  let endTrim = 6.8;
  if (duration - start - endTrim < 6) endTrim = Math.max(0, duration - start - 6);
  return { start, end: duration - endTrim };
}

export function HoloDisplay({ src, cubeConfig, title, mode, onMode, onClose }) {
  const rootRef = useRef(null);
  const videosRef = useRef([]);
  const cubeBoxesRef = useRef([]);
  const [cubeError, setCubeError] = useState("");
  const cubeMode = mode === "cube" && Boolean(cubeConfig);
  const padDrag = useRef(null); // { y, id } while a pad drag is in flight

  // The pad forwards its drag to the master cube's own pointer handlers.
  // A made-up pointer id keeps the cube's setPointerCapture from stealing
  // the real pointer (it throws and is ignored); the pad captures it itself.
  const padForward = (type, e) => {
    const target = cubeBoxesRef.current[MASTER];
    const d = padDrag.current;
    if (!target || !d) return;
    target.dispatchEvent(new PointerEvent(type, {
      clientX: e.clientX, clientY: d.y, pointerId: PAD_POINTER_ID, pointerType: e.pointerType, button: 0, isPrimary: true
    }));
  };
  const onPadDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    padDrag.current = { y: e.clientY, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    padForward("pointerdown", e);
    e.preventDefault();
  };
  const onPadMove = (e) => { if (padDrag.current && padDrag.current.id === e.pointerId) padForward("pointermove", e); };
  const onPadUp = (e) => {
    if (!padDrag.current || padDrag.current.id !== e.pointerId) return;
    padForward("pointerup", e);
    padDrag.current = null;
  };

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Full screen and a wake lock while open; both are best effort
  useEffect(() => {
    const el = rootRef.current;
    let lock = null;
    if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request("screen").then((l) => { lock = l; }).catch(() => {});
    }
    return () => {
      if (lock) lock.release().catch(() => {});
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Video mode: the first video is the clock; it loops on the trim window
  // and the other three follow it
  useEffect(() => {
    if (cubeMode) return undefined;
    const vids = videosRef.current.filter(Boolean);
    const master = vids[0];
    if (!master) return undefined;
    const tick = () => {
      const w = loopWindow(master.duration);
      if (w && (master.currentTime < w.start || master.currentTime >= w.end)) master.currentTime = w.start;
      for (const v of vids.slice(1)) {
        if (Math.abs(v.currentTime - master.currentTime) > 0.2) v.currentTime = master.currentTime;
        if (master.paused !== v.paused) { if (master.paused) v.pause(); else v.play().catch(() => {}); }
      }
    };
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [src, cubeMode]);

  // Cube mode: four instances, one orientation
  useEffect(() => {
    if (!cubeMode) return undefined;
    let cancelled = false;
    let cubes = [];
    let rafId = 0;
    let syncId = 0;
    import("mediacube")
      .then(({ default: MediaCube }) => {
        if (cancelled) return;
        setCubeError("");
        const boxes = cubeBoxesRef.current;
        if (boxes.some((b) => !b)) return;
        cubes = SIDES.map((side, i) => {
          const isMaster = i === MASTER;
          // Followers neither spin nor snap on their own, and skip the
          // loading tile (the master's poster logic covers the wait)
          const settings = isMaster
            ? { ...cubeConfig.settings }
            : { ...cubeConfig.settings, idleSpinSpeed: 0, loadingPlaceholder: false };
          return new MediaCube(boxes[i], { ...cubeConfig, settings });
        });
        const master = cubes[MASTER];

        // Orientation: copied every frame, after the followers' own loops
        // have painted (frame callbacks run in registration order)
        const paint = () => {
          if (cancelled) return;
          cubes.forEach((c, i) => {
            if (i === MASTER || c.destroyed) return;
            c.rotX = master.rotX;
            c.rotY = master.rotY;
            c.applyTransform();
          });
          rafId = requestAnimationFrame(paint);
        };
        rafId = requestAnimationFrame(paint);

        // Playback: whatever video the master plays, the followers play the
        // same face's video on the master's clock; when it finishes, so do they
        const sync = () => {
          if (cancelled) return;
          const mv = master.currentVideo;
          const idx = mv ? master.videoRegistry.indexOf(mv) : -1;
          cubes.forEach((c, i) => {
            if (i === MASTER || c.destroyed) return;
            const fv = idx >= 0 ? c.videoRegistry[idx] : null;
            if (fv && c.currentVideo !== fv) c.playVideo(fv);
            else if (!fv && c.currentVideo) c.finishVideo(c.currentVideo);
            // Only once the master's clip is really rolling: while it is
            // still seeking, a pause here would abort the follower's own
            // play() and the library logs the interruption
            if (fv && mv && !mv.el.seeking && mv.el.readyState >= 3) {
              if (Math.abs(fv.el.currentTime - mv.el.currentTime) > 0.2) fv.el.currentTime = mv.el.currentTime;
              if (mv.el.paused !== fv.el.paused) { if (mv.el.paused) fv.el.pause(); else fv.el.play().catch(() => {}); }
            }
          });
        };
        syncId = setInterval(sync, 200);
      })
      .catch((err) => {
        console.error("Failed to load the cube library:", err);
        if (!cancelled) setCubeError("Could not load the cube library.");
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearInterval(syncId);
      cubes.forEach((c) => { if (!c.destroyed) c.destroy(); });
    };
  }, [cubeMode, cubeConfig]);

  return (
    <div ref={rootRef} className="holo" role="dialog" aria-label={`Hologram source display${title ? `: ${title}` : ""}`}>
      <div className="holo-grid">
        {SIDES.map((s, i) => (
          <div key={s.key} className="holo-cell" style={{ gridRow: s.row, gridColumn: s.col }}>
            {cubeMode ? (
              <div
                className={`holo-cube${i === MASTER ? "" : " holo-follower"}`}
                style={{ transform: `rotate(${s.rotate}deg) scaleX(-1)` }}
                ref={(el) => { cubeBoxesRef.current[i] = el; }}
              />
            ) : (
              <video
                ref={(el) => { videosRef.current[i] = el; }}
                className="holo-video"
                style={{ transform: `rotate(${s.rotate}deg) rotateY(180deg)` }}
                src={src}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
              />
            )}
          </div>
        ))}
      </div>
      {cubeError && <p className="holo-error">{cubeError}</p>}

      <div className="holo-bar">
        <button type="button" className="holo-close" onClick={onClose} title="Close (Esc)">✕</button>
        {cubeMode ? (
          <div
            className="holo-pad"
            role="slider"
            aria-label="Spin the cube: drag left or right"
            aria-valuetext="cube rotation"
            tabIndex={-1}
            onPointerDown={onPadDown}
            onPointerMove={onPadMove}
            onPointerUp={onPadUp}
            onPointerCancel={onPadUp}
          >
            <span aria-hidden="true">◂ drag to spin ▸</span>
          </div>
        ) : (
          <div className="holo-pad-space" />
        )}
        <div className="holo-modes">
          <button type="button" className={`holo-mode${!cubeMode ? " is-on" : ""}`} onClick={() => onMode("video")} aria-pressed={!cubeMode}>Video</button>
          <button type="button" className={`holo-mode${cubeMode ? " is-on" : ""}`} onClick={() => onMode("cube")} disabled={!cubeConfig} aria-pressed={cubeMode}>Cube</button>
        </div>
      </div>

      <style>{`
        .holo {
          position: fixed;
          inset: 0;
          z-index: 100000;
          background: #000;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: default;
        }
        .holo-grid {
          width: min(100vw, 100vh);
          height: min(100vw, 100vh);
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          grid-template-rows: repeat(3, 1fr);
        }
        .holo-cell {
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .holo-video {
          width: 80%;
          height: 80%;
          object-fit: contain;
          display: block;
        }
        .holo-cube {
          width: 100%;
          height: 100%;
          touch-action: none;
        }
        .holo-follower {
          pointer-events: none;
        }
        .holo-cube .mediacube-scene {
          font-family: var(--font-sans);
        }
        .holo-cube .mediacube-face svg text {
          font-family: 'TopShot Emoji', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
        }
        .holo-error {
          position: absolute;
          top: 50%;
          left: 0;
          right: 0;
          text-align: center;
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.85rem;
        }
        .holo-bar {
          position: absolute;
          top: 10px;
          left: 10px;
          right: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        /* The touch pad: a dashed track the width of the free space. Low
           profile until a finger is on it, then the outline fills in */
        .holo-pad, .holo-pad-space {
          flex: 1;
          min-width: 0;
          height: 32px;
        }
        .holo-pad {
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 16px;
          border: 1px dashed rgba(255, 255, 255, 0.25);
          color: rgba(255, 255, 255, 0.4);
          font-size: 0.72rem;
          letter-spacing: 0.5px;
          white-space: nowrap;
          overflow: hidden;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          cursor: ew-resize;
        }
        .holo-pad:active {
          border-style: solid;
          border-color: rgba(255, 255, 255, 0.6);
          color: rgba(255, 255, 255, 0.8);
        }
        .holo-close {
          flex: none;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(0, 0, 0, 0.6);
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.9rem;
          cursor: pointer;
        }
        .holo-close:hover {
          color: #fff;
        }
        .holo-modes {
          flex: none;
          display: flex;
          gap: 6px;
        }
        .holo-mode {
          height: 32px;
          padding: 0 12px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(0, 0, 0, 0.6);
          color: rgba(255, 255, 255, 0.6);
          font: inherit;
          font-size: 0.78rem;
          cursor: pointer;
        }
        /* The active mode: filled outline plus a check, not colour alone */
        .holo-mode.is-on {
          color: #fff;
          border-color: #fff;
        }
        .holo-mode.is-on::before {
          content: "✓ ";
        }
        .holo-mode:disabled {
          opacity: 0.4;
          cursor: default;
        }
      `}</style>
    </div>
  );
}
