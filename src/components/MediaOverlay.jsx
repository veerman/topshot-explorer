import { useEffect } from "react";
import { VideoPlayer } from "./VideoPlayer";

/**
 * Full-screen overlay for IPFS media previews.
 * media: { url, type: "video" | "image", title? } or null (hidden).
 * Videos use the shared VideoPlayer (play/pause, repeat, slow-mo speeds,
 * volume, seek bar); images render with the same chrome.
 */
export function MediaOverlay({ media, onClose }) {
  // Escape closes; Space (video only) is handled by the player's hotkeys
  useEffect(() => {
    if (!media) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [media, onClose]);

  if (!media) return null;

  const isVideo = media.type === "video";

  return (
    <div className="media-overlay" onClick={onClose}>
      <div className="media-overlay-content" onClick={(e) => e.stopPropagation()}>
        <button className="media-close-btn" onClick={onClose} title="Close (Esc)">&times;</button>

        {media.title && <div className="media-overlay-title">{media.title}</div>}

        {isVideo ? (
          <VideoPlayer src={media.url} autoPlay hotkeys videoClassName="media-overlay-video" />
        ) : (
          <>
            <img src={media.url} alt={media.title || "IPFS media"} className="media-overlay-image" />
            <div className="media-controls-row media-buttons-row">
              <a
                href={media.url}
                target="_blank"
                rel="noopener noreferrer"
                className="media-btn media-open-link"
                title="Open direct IPFS file link"
              >
                Open original ↗
              </a>
            </div>
          </>
        )}
      </div>

      <style>{`
        .media-overlay {
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
          animation: mediaFadeIn 0.25s ease-out;
        }
        .media-overlay-content {
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
          align-items: stretch;
          animation: mediaScaleUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .media-overlay-title {
          color: #fff;
          font-size: 0.85rem;
          font-weight: 600;
          padding: 2px 4px 8px;
          text-align: center;
        }
        .media-close-btn {
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
        .media-close-btn:hover {
          background: var(--primary-hover);
          transform: scale(1.1);
        }
        .media-overlay-video {
          max-height: calc(90vh - 120px);
          border-radius: 8px;
          outline: none;
          cursor: pointer;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
        }
        .media-overlay-image {
          max-width: 100%;
          max-height: calc(90vh - 80px);
          border-radius: 8px;
          object-fit: contain;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
        }
        @keyframes mediaFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes mediaScaleUp {
          from { transform: scale(0.9); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @media (max-width: 600px) {
          .media-overlay-content {
            max-width: 96vw;
          }
        }
      `}</style>
    </div>
  );
}
