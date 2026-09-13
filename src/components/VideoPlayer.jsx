import { useState, useEffect, useRef, useCallback } from "react";

const SPEEDS = [0.25, 0.5, 0.75, 1];

const formatTime = (secs) => {
  if (!Number.isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

// Space must keep working as a keystroke inside editable controls
const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
};

/**
 * Video element with the app's own control bar: play/pause, repeat,
 * slow-motion speeds, volume, a seek bar and a direct file link. Shared by
 * the media overlay and the edition page player so both behave the same.
 * Control styles live in index.css under .media-*.
 *
 * autoPlay: start as soon as the file loads (a src change reloads, so a
 *           newly picked clip starts too)
 * hotkeys:  Space toggles playback anywhere on the page, except while typing
 * syncGroup: a Set shared by companion players (the edition page's video
 *           and its commentary cut). Playing any member starts the others
 *           from wherever they are; pausing, seeking, speed and volume stay
 *           per player.
 */
export function VideoPlayer({ src, autoPlay = false, hotkeys = false, videoClassName = "", onError, syncGroup }) {
  const videoRef = useRef(null);
  // Play state follows the element's own events, so a blocked autoplay
  // still shows the play button
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Reset per-clip state when the element starts loading a new file (volume
  // persists); an event handler rather than an effect on src, so it also
  // covers the very first load
  const handleLoadStart = () => {
    setIsLooping(false);
    setSpeed(1);
    setCurrentTime(0);
    setDuration(0);
  };

  // Push state onto the element (also needed after src changes reload playback)
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.playbackRate = speed;
    vid.loop = isLooping;
    vid.volume = volume;
    vid.muted = isMuted;
  }, [speed, isLooping, volume, isMuted, src]);

  useEffect(() => {
    if (!syncGroup) return undefined;
    const vid = videoRef.current;
    if (!vid) return undefined;
    syncGroup.add(vid);
    return () => { syncGroup.delete(vid); };
  }, [syncGroup]);

  // This player started: start the rest of its group too. A member that is
  // already playing gets no event, so the chain stops there.
  const handlePlay = () => {
    setIsPlaying(true);
    if (!syncGroup) return;
    syncGroup.forEach((other) => {
      if (other !== videoRef.current && other.paused) other.play().catch(() => { /* autoplay policy */ });
    });
  };

  const togglePlay = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play().catch(() => { /* blocked autoplay policy; the button stays on play */ });
    } else {
      vid.pause();
    }
  }, []);

  useEffect(() => {
    if (!hotkeys) return undefined;
    const onKeyDown = (e) => {
      if (e.key === " " && !isTypingTarget(e.target)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkeys, togglePlay]);

  const handleSeek = (e) => {
    const vid = videoRef.current;
    const t = Number(e.target.value);
    if (vid) vid.currentTime = t;
    setCurrentTime(t);
  };

  const handleVolume = (e) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v > 0 && isMuted) setIsMuted(false);
  };

  return (
    <div className="video-player">
      <video
        ref={videoRef}
        src={src}
        autoPlay={autoPlay}
        playsInline
        onClick={togglePlay}
        onLoadStart={handleLoadStart}
        onError={onError}
        onPlay={handlePlay}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.target.duration)}
        className={`video-player-video ${videoClassName}`}
      />

      {/* Progress bar */}
      <div className="media-controls-row media-progress-row">
        <span className="media-time font-mono">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="media-seek-bar"
          min="0"
          max={duration || 0}
          step="0.05"
          value={Math.min(currentTime, duration || 0)}
          onChange={handleSeek}
          title="Seek"
        />
        <span className="media-time font-mono">{formatTime(duration)}</span>
      </div>

      {/* Buttons: play/pause, repeat, speeds, volume */}
      <div className="media-controls-row media-buttons-row">
        <button className="media-btn" onClick={togglePlay} title={isPlaying ? "Pause (Space)" : "Play (Space)"}>
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          className={`media-btn ${isLooping ? "media-btn-active" : ""}`}
          onClick={() => setIsLooping((l) => !l)}
          title={isLooping ? "Repeat is on" : "Repeat is off"}
        >
          🔁
        </button>

        <div className="media-speed-group" title="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`media-btn media-speed-btn ${speed === s ? "media-btn-active" : ""}`}
              onClick={() => setSpeed(s)}
            >
              {s === 1 ? "1x" : `${s * 4}/4`}
            </button>
          ))}
        </div>

        <div className="media-volume-group">
          <button
            className="media-btn"
            onClick={() => setIsMuted((m) => !m)}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            className="media-volume-bar"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolume}
            title="Volume"
          />
        </div>

        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="media-btn media-open-link"
          title="Open direct IPFS file link"
        >
          Open ↗
        </a>
      </div>
    </div>
  );
}
