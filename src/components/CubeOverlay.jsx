import { useEffect, useRef, useState } from "react";

/**
 * Full-screen overlay hosting a MediaCube (the interactive 3D moment cube).
 * cube: { title, config } or null (hidden). The mediacube library loads on
 * first open (dynamic import), so it costs the initial bundle nothing; the
 * instance is destroyed whenever the overlay closes or swaps cubes.
 */
export function CubeOverlay({ cube, onClose }) {
  const boxRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!cube) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cube, onClose]);

  useEffect(() => {
    if (!cube || !boxRef.current) return undefined;
    let instance = null;
    let cancelled = false;
    setError("");
    import("mediacube")
      .then(({ default: MediaCube }) => {
        if (cancelled || !boxRef.current) return;
        instance = new MediaCube(boxRef.current, cube.config);
      })
      .catch((err) => {
        console.error("Failed to load the cube library:", err);
        if (!cancelled) setError("Could not load the cube viewer.");
      });
    return () => {
      cancelled = true;
      if (instance) instance.destroy();
    };
  }, [cube]);

  if (!cube) return null;

  return (
    <div className="cube-overlay" onClick={onClose}>
      <div className="cube-overlay-content" onClick={(e) => e.stopPropagation()}>
        <button className="cube-close-btn" onClick={onClose} title="Close (Esc)">&times;</button>
        {cube.title && <div className="cube-overlay-title">{cube.title}</div>}
        {error ? (
          <div className="cube-overlay-error">{error}</div>
        ) : (
          <div ref={boxRef} className="cube-overlay-box" title="Drag to spin" />
        )}
        <div className="cube-overlay-hint text-muted">Drag to spin</div>
      </div>

      <style>{`
        .cube-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(8px);
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: cubeFadeIn 0.25s ease-out;
        }
        .cube-overlay-content {
          position: relative;
          background: rgba(20, 20, 25, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 10px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 0 30px rgba(139, 92, 246, 0.25);
          max-width: 90vw;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          animation: cubeScaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .cube-overlay-title {
          color: #fff;
          font-size: 0.85rem;
          font-weight: 600;
          padding: 2px 4px 8px;
          text-align: center;
        }
        .cube-overlay-box {
          width: min(78vmin, 640px);
          height: min(78vmin, 640px);
          touch-action: none;
        }
        /* Emoji inside the cube must render with the app's self-hosted
           emoji subset, same as everywhere else. HTML layers (the core
           emoji, text faces) inherit the app stack; the card template's
           SVG text declares its own system stack, which on Windows sends
           emoji to Segoe instead, so the app emoji font is prepended
           there. Letters pass through it untouched (it holds only emoji
           glyphs), so card typography is unchanged. */
        .cube-overlay-box .mediacube-scene {
          font-family: var(--font-sans);
        }
        .cube-overlay-box .mediacube-face svg text {
          font-family: 'TopShot Emoji', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
        }
        .cube-overlay-hint {
          font-size: 0.7rem;
          padding-top: 4px;
        }
        .cube-overlay-error {
          color: var(--status-danger);
          padding: 40px;
        }
        .cube-close-btn {
          position: absolute;
          top: -15px;
          right: -15px;
          background: var(--primary);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #fff;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          font-size: 1.25rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
          transition: var(--transition-smooth);
          z-index: 10;
        }
        .cube-close-btn:hover {
          background: var(--primary-hover);
          transform: scale(1.1);
        }
        @keyframes cubeFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes cubeScaleUp {
          from { transform: scale(0.9); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
