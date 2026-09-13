import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { getRecord, getAllIPFSDB, getAllSetsDB, getAllTeamsDB, getAllPlaysDB } from "../services/db.service";
import { buildIdentityContext } from "../services/identity.service";
import { useDbData } from "../hooks/useDbData";
import { useIpfsMedia } from "../hooks/useIpfsMedia";
import { getMediaInfo } from "../services/ipfs.media";
import { getMediaTypeLabel } from "../services/ipfs.analysis";
import { gatewayUrl, isLiveCid } from "../services/cube.service";
import { buildEditionList, useEditionPicker, editionSubtitle } from "../components/EditionPicker";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { scrubSentinels, formatDateISO, buildTeamNameMap, buildMatchupSides, renderMatchupCell } from "../utils/display.utils";
import { parseMomentDate } from "../services/overrides.service";

// Video frame annotator (no nav link; open /annotate).
//
// Deterministic frame addressing: share links carry the exact seek time
// (t), and every frame step targets the frame MIDPOINT (frame + 0.5)/fps,
// so the same link shows the same frame in any browser. The frame rate is
// never asked for or shared: it is measured silently from playback
// presentation timestamps (requestVideoFrameCallback) and only used for
// stepping and the informational frame number; 30 is assumed until the
// first measurement.
//
// Two modes. A link with a video url opens as a VIEWER: just the frame
// with its shapes, dim and comment (plus a selection-only toggle and a
// button into the editor). Without url params the page is the EDITOR.
//
// Link safety: the video url is accepted only with an http(s) protocol,
// the comment is length-capped with control characters stripped, and all
// link text renders as plain text nodes (never markup), so a crafted
// link cannot inject anything into the page.
//
// Extraction (save button) needs a CORS-readable video; the IPFS gateways
// send Access-Control-Allow-Origin: *, so moment videos work. The inline
// previews merely DISPLAY pixels (no readback), so they work everywhere.

const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const COMMENT_MAX = 500;

const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
};

const formatTime = (secs) => {
  if (!Number.isFinite(secs)) return "0:00.000";
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
};

const safeVideoUrl = (u) => {
  try {
    const p = new URL(String(u || ""));
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : "";
  } catch {
    return "";
  }
};

const cleanComment = (c) =>
  // eslint-disable-next-line no-control-regex
  String(c || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, COMMENT_MAX);

const parseShapes = (str) => {
  const out = [];
  for (const part of String(str || "").split(";")) {
    const m = part.match(/^([re])(\d+),(\d+),(\d+),(\d+)$/);
    if (m) out.push({ kind: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
  }
  return out;
};
const serializeShapes = (shapes) =>
  shapes.map((s) => `${s.kind}${s.x},${s.y},${s.w},${s.h}`).join(";");

// Pull an IPFS CID out of a gateway url (path style /ipfs/<cid>)
const cidOfUrl = (u) => {
  const m = String(u || "").match(/\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,})/);
  return m ? m[1] : null;
};

const shapePath = (ctx, s, ox = 0, oy = 0) => {
  ctx.beginPath();
  if (s.kind === "e") ctx.ellipse(s.x - ox + s.w / 2, s.y - oy + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(s.x - ox, s.y - oy, s.w, s.h);
};

// Clip a shape's region out of the video onto a canvas; the preview and
// the saved PNG share this so what you save is structurally what you saw
const drawCrop = (canvas, vid, s) => {
  canvas.width = s.w;
  canvas.height = s.h;
  const ctx = canvas.getContext("2d");
  if (s.kind === "e") { shapePath(ctx, s, s.x, s.y); ctx.clip(); }
  ctx.drawImage(vid, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
  return ctx;
};

export function Annotate() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const sharedUrl = safeVideoUrl(params.get("v"));
  const [mode, setMode] = useState(() => (sharedUrl ? "view" : "edit"));
  const [videoSrc, setVideoSrc] = useState(sharedUrl);
  const [isLocal, setIsLocal] = useState(false);
  const [urlInput, setUrlInput] = useState(sharedUrl);
  const [shapes, setShapes] = useState(() => parseShapes(params.get("s")));
  const [dim, setDim] = useState(() => params.get("d") === "1");
  const [comment, setComment] = useState(() => cleanComment(params.get("c")));
  const [tool, setTool] = useState("r");
  const [tempShape, setTempShape] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState(null);
  const [fps, setFps] = useState(30);
  const [fpsMeasured, setFpsMeasured] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  // The instant the link pointed at (?t=), read once for the three
  // consumers below
  const linkTime = params.get("t") != null ? Number(params.get("t")) : null;
  // The frame the annotation work is anchored to. Only deliberate
  // navigation (stepping, the seek bar, loading, the Shared frame button)
  // moves it; play/pause never does, so the selection previews hold still.
  const [anchorTime, setAnchorTime] = useState(() => linkTime ?? 0);
  const [context, setContext] = useState(null); // { play, sets: [{setID, playID, setName, series}], mediaKind }
  // The second way in: pick an edition, then one of its videos
  const [pickOpen, setPickOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const previewRefs = useRef({});
  const measuredForRef = useRef(null); // src the fps was measured on
  const pendingSeekRef = useRef(linkTime);
  const contextSeqRef = useRef(0);
  const wasBelowSharedRef = useRef(false);
  // The link's instant again, for the viewer's "Shared frame" button and
  // the play-until-back-here loop
  const [sharedTime] = useState(linkTime);

  const frameOf = (t) => Math.floor(t * fps + 1e-4);
  // "Same frame" within the frame duration; the one comparison three
  // sites used to each write out as Math.abs(a - b) against 0.6/fps
  const sameFrame = useCallback((a, b) => Math.abs(a - b) < 0.6 / fps, [fps]);

  const togglePlay = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) vid.play().catch(() => {});
    else vid.pause();
  }, []);

  const stepFrame = useCallback((delta) => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.pause();
    // frameOf keeps the step and the displayed frame number in lockstep
    const f = Math.max(0, Math.floor(vid.currentTime * fps + 1e-4) + delta);
    const t = (f + 0.5) / fps;
    vid.currentTime = t;
    setAnchorTime(t);
  }, [fps]);

  // Measure the frame rate once per source from presentation timestamps.
  // Runs on a DETACHED muted clone of the video (served from HTTP cache),
  // so the visible player never plays or moves; falls back to the 30
  // default when unsupported or blocked.
  const measureFps = useCallback((src) => {
    if (!src || measuredForRef.current === src) return;
    const probe = document.createElement("video");
    if (!probe.requestVideoFrameCallback) return;
    measuredForRef.current = src;
    probe.muted = true;
    probe.playsInline = true;
    probe.src = src;
    const times = [];
    let done = false;
    const cleanup = () => {
      done = true;
      probe.pause();
      probe.removeAttribute("src");
      probe.load();
    };
    const finish = () => {
      cleanup();
      const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0).sort((a, b) => a - b);
      if (!deltas.length) { measuredForRef.current = null; return; }
      const measured = 1 / deltas[Math.floor(deltas.length / 2)];
      const snapped = RATES.find((r) => Math.abs(r - measured) / r < 0.03);
      setFps(snapped || Number(measured.toFixed(3)));
      setFpsMeasured(true);
    };
    const tick = (_, meta) => {
      if (done) return;
      times.push(meta.mediaTime);
      if (times.length < 13) probe.requestVideoFrameCallback(tick);
      else finish();
    };
    probe.requestVideoFrameCallback(tick);
    probe.play().catch(() => { measuredForRef.current = null; cleanup(); });
    setTimeout(() => { if (!done) finish(); }, 5000);
  }, []);

  // When the video is an IPFS gateway link to a known moment, show what
  // it is: the play (player, team, date, score) and the set(s) it appears
  // in, resolved from the local database by CID. Silently absent when the
  // CID is unknown or the database has not synced yet.
  useEffect(() => {
    const seq = ++contextSeqRef.current;
    const src = videoSrc;
    const cid = !isLocal && cidOfUrl(src);
    if (!cid) return;
    (async () => {
      try {
        const ipfsRecords = await getAllIPFSDB();
        const matches = [];
        let mediaKind = null;
        for (const rec of ipfsRecords) {
          for (const [kind, c] of Object.entries(rec.cids || {})) {
            if (c === cid) { matches.push(rec); mediaKind = kind; break; }
          }
        }
        if (!matches.length || seq !== contextSeqRef.current) return;
        const playID = Number(matches[0].playID);
        let play = await getRecord("plays", playID);
        if (!play) play = await getRecord("plays", String(playID));
        const allSets = await getAllSetsDB();
        const allTeams = await getAllTeamsDB().catch(() => []);
        if (seq !== contextSeqRef.current) return;
        const sets = matches.map((m) => {
          const s = allSets.find((x) => Number(x.id) === Number(m.setID));
          return { setID: Number(m.setID), playID: Number(m.playID), setName: s?.setName || `Set ${m.setID}`, series: s?.series };
        });
        const scrubbed = play ? scrubSentinels(play) : null;
        const matchup = scrubbed ? buildMatchupSides(scrubbed, buildTeamNameMap(allTeams)) : null;
        setContext({ src, play: scrubbed, matchup, sets, mediaKind });
      } catch {
        /* context is best-effort; the annotator works without it */
      }
    })();
  }, [videoSrc, isLocal]);
  // Stale context (from a previously loaded video) is filtered at render
  // time instead of being cleared in the effect
  const ctx = context && context.src === videoSrc && !isLocal ? context : null;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft" || e.key === ",") { e.preventDefault(); stepFrame(-1); }
      else if (e.key === "ArrowRight" || e.key === ".") { e.preventDefault(); stepFrame(1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, stepFrame]);

  // Overlay: shapes and the dim spotlight
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoSize) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = tempShape ? [...shapes, tempShape] : shapes;
    if (dim && all.length) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "destination-out";
      for (const s of all) { shapePath(ctx, s); ctx.fill(); }
      ctx.globalCompositeOperation = "source-over";
    }
    for (const s of all) {
      shapePath(ctx, s);
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.stroke();
      ctx.lineWidth = Math.max(1, canvas.width / 800);
      ctx.strokeStyle = "#a78bfa";
      ctx.stroke();
    }
  }, [shapes, tempShape, dim, videoSize, mode]);

  // Previews of each selection (display only, works without CORS). They
  // are STATIC: drawn only while paused ON the anchored frame, so playing
  // (and pausing anywhere else) never changes their content.
  useEffect(() => {
    if (isPlaying) return;
    const vid = videoRef.current;
    if (!vid || !videoSize || vid.readyState < 2) return;
    if (!sameFrame(vid.currentTime, anchorTime)) return;
    shapes.forEach((s, i) => {
      const canvas = previewRefs.current[i];
      if (!canvas) return;
      drawCrop(canvas, vid, s);
    });
  }, [shapes, videoSize, currentTime, mode, isPlaying, anchorTime, fps, sameFrame]);

  const toVideoCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    // Clamp so a drag that leaves the video stops at its edge
    return {
      x: Math.min(canvas.width, Math.max(0, Math.round((e.clientX - rect.left) * (canvas.width / rect.width)))),
      y: Math.min(canvas.height, Math.max(0, Math.round((e.clientY - rect.top) * (canvas.height / rect.height))))
    };
  };

  const onPointerDown = (e) => {
    if (mode !== "edit" || !videoSize) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = toVideoCoords(e);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const p = toVideoCoords(e);
    const o = dragRef.current;
    setTempShape({
      kind: tool,
      x: Math.min(o.x, p.x), y: Math.min(o.y, p.y),
      w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y)
    });
  };
  const onPointerUp = () => {
    dragRef.current = null;
    setTempShape((t) => {
      if (t && t.w >= 4 && t.h >= 4) {
        setShapes((s) => [...s, t]);
        // Drawing is deliberate: the annotation now belongs to this frame
        const vid = videoRef.current;
        if (vid) setAnchorTime(vid.currentTime);
      }
      return null;
    });
  };

  const loadVideoUrl = (raw) => {
    const url = safeVideoUrl(String(raw || "").trim());
    if (!url) { setMsg("only http(s) video links are accepted"); return; }
    setIsLocal(false);
    setShapes([]);
    setAnchorTime(0);
    setVideoSrc(url);
  };
  const loadUrl = () => loadVideoUrl(urlInput);
  const pickVideo = (url) => {
    setUrlInput(url);
    setPickOpen(false);
    loadVideoUrl(url);
  };
  const loadFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setIsLocal(true);
    setShapes([]);
    setAnchorTime(0);
    setUrlInput("");
    setVideoSrc(URL.createObjectURL(file));
  };

  const extractShape = (s) => {
    const vid = videoRef.current;
    if (!vid || !videoSize) return;
    // Save always captures the ANCHORED frame the preview shows; snap
    // back to it first if playback wandered off
    if (!sameFrame(vid.currentTime, anchorTime)) {
      vid.pause();
      vid.addEventListener("seeked", () => extractShape(s), { once: true });
      vid.currentTime = anchorTime;
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      drawCrop(canvas, vid, s);
      canvas.toBlob((blob) => {
        if (!blob) { setMsg("extraction failed (video not CORS-readable)"); return; }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `frame${frameOf(anchorTime)}_${s.x},${s.y}_${s.w}x${s.h}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }, "image/png");
    } catch {
      setMsg("extraction blocked: the video host does not allow pixel reads (CORS)");
    }
  };

  const copyLink = async () => {
    if (isLocal || !videoSrc) { setMsg("links need a video URL, local files cannot be shared"); return; }
    const p = new URLSearchParams();
    p.set("v", videoSrc);
    // The link points at the ANCHORED frame (what the shapes and previews
    // describe), not wherever playback happens to sit
    p.set("t", anchorTime.toFixed(4));
    if (shapes.length) p.set("s", serializeShapes(shapes));
    if (dim) p.set("d", "1");
    if (comment.trim()) p.set("c", cleanComment(comment.trim()));
    const link = `${window.location.origin}/annotate?${p.toString()}`;
    try {
      await navigator.clipboard.writeText(link);
      setMsg("link copied");
    } catch {
      setMsg(link);
    }
  };

  const isView = mode === "view";
  // Annotations belong to the shared frame: hide them during playback,
  // and in the viewer whenever the position is off the shared frame
  const onSharedFrame = sharedTime == null || sameFrame(currentTime, sharedTime);
  const overlayHidden = isPlaying || (isView && !onSharedFrame);

  return (
    <div className="annotate-page">
      {!isView && (
        <>
          <h1>Frame Annotator</h1>
          <div className="text-muted annotate-hint">
            Load a video by link, or pick an edition and one of its videos. Step to a frame (arrow keys or , .), drag shapes on it, share the exact view by link.
          </div>
        </>
      )}

      <div className="glass-panel annotate-panel">
        {!isView && (
          <div className="annotate-row">
            <input
              type="text"
              className="annotate-url"
              placeholder="Video URL (any http(s) link; IPFS gateway links work)"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") loadUrl(); }}
            />
            <button className="media-btn" onClick={loadUrl}>Load</button>
            <label className="media-btn annotate-file-btn">
              Local file
              <input type="file" accept="video/*" onChange={loadFile} hidden />
            </label>
            <button type="button" className={`media-btn${pickOpen ? " is-on" : ""}`} onClick={() => setPickOpen((o) => !o)} aria-expanded={pickOpen}>
              {pickOpen ? "✓ Pick an edition" : "Pick an edition"}
            </button>
          </div>
        )}
        {!isView && pickOpen && <EditionVideos onPick={pickVideo} />}

        {videoSrc && (
          <>
            {/* Viewer: frame and selection crops sit side by side, centred
                on each other, wrapping under only when they cannot fit */}
            <div className="annotate-stage">
              {/* The inner wrapper shrink-wraps the video, so the overlay
                  canvas covers exactly the picture (never letterbox bars)
                  and pointer coordinates map 1:1 to video pixels */}
              <div className={`annotate-stage-inner ${frameReady ? "" : "annotate-stage-loading"}`}>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  crossOrigin={isLocal ? undefined : "anonymous"}
                  playsInline
                  preload="auto"
                  loop={isView}
                  onLoadStart={() => setFrameReady(false)}
                  onPlay={(e) => {
                    setIsPlaying(true);
                    wasBelowSharedRef.current = sharedTime != null && e.target.currentTime < sharedTime - 0.02;
                  }}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    const vid = e.target;
                    const t = vid.currentTime;
                    setCurrentTime(t);
                    // Viewer playback loops until it comes back around to
                    // the shared frame, then stops exactly on it
                    if (isView && sharedTime != null && !vid.paused) {
                      const below = wasBelowSharedRef.current;
                      wasBelowSharedRef.current = t < sharedTime - 0.02;
                      if (below && t >= sharedTime) {
                        vid.pause();
                        vid.currentTime = sharedTime;
                      }
                    }
                  }}
                  onSeeked={(e) => { setCurrentTime(e.target.currentTime); setFrameReady(true); }}
                  onLoadedMetadata={(e) => {
                    const vid = e.target;
                    setDuration(vid.duration);
                    setVideoSize({ w: vid.videoWidth, h: vid.videoHeight });
                    if (pendingSeekRef.current != null && Math.abs(vid.currentTime - pendingSeekRef.current) > 1e-6) {
                      // Reveal happens on the seeked event
                      vid.currentTime = pendingSeekRef.current;
                      pendingSeekRef.current = null;
                    } else {
                      // No seek needed (a same-position seek fires no
                      // seeked event), show the frame now
                      pendingSeekRef.current = null;
                      setFrameReady(true);
                    }
                    measureFps(vid.currentSrc);
                  }}
                />
                {videoSize && (
                  <canvas
                    ref={canvasRef}
                    width={videoSize.w}
                    height={videoSize.h}
                    className={`annotate-overlay ${isView ? "annotate-overlay-view" : ""} ${overlayHidden ? "annotate-overlay-off" : ""}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                  />
                )}
              </div>
              {shapes.length > 0 && (
                <div className="annotate-side">
                  {shapes.map((s, i) => (
                    <div key={i} className="annotate-side-item">
                      <canvas ref={(el) => { previewRefs.current[i] = el; }} className="annotate-preview-canvas" />
                      {!isView && (
                        <div className="annotate-side-caption">
                          <span className="font-mono">{s.kind === "e" ? "◯" : "▭"} {s.x},{s.y} {s.w}x{s.h}</span>
                          <button className="annotate-shape-btn" onClick={() => extractShape(s)} title="Download this region of the current frame as png">save</button>
                          <button className="annotate-shape-btn" onClick={() => setShapes(shapes.filter((_, j) => j !== i))} title="Remove">x</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isView && comment && <div className="annotate-comment-view">{comment}</div>}

            {isView && (
              <div className="media-controls-row media-buttons-row annotate-controls">
                <button className="media-btn" onClick={togglePlay} title={isPlaying ? "Pause (Space)" : "Play the full clip for context (Space)"}>
                  {isPlaying ? "⏸" : "▶"}
                </button>
                {sharedTime != null && (
                  <button
                    className="media-btn"
                    onClick={() => {
                      const vid = videoRef.current;
                      if (!vid) return;
                      vid.pause();
                      vid.currentTime = sharedTime;
                      setAnchorTime(sharedTime);
                    }}
                    title="Return to the frame this link points at"
                  >
                    Shared frame
                  </button>
                )}
                <span className="media-time font-mono" title={fpsMeasured ? `at the measured ${fps} fps` : "at an assumed 30 fps"}>
                  {formatTime(currentTime)} · frame {frameOf(currentTime)}
                </span>
                <span className="annotate-sep" />
                <button className="media-btn" onClick={() => setMode("edit")} title="Open the full editor">
                  Edit
                </button>
              </div>
            )}

            {!isView && (
              <>
                <div className="media-controls-row media-progress-row">
                  <span className="media-time font-mono">{formatTime(currentTime)}</span>
                  <input
                    type="range"
                    className="media-seek-bar"
                    min="0"
                    max={duration || 0}
                    step={1 / fps}
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(e) => {
                      const t = Number(e.target.value);
                      const vid = videoRef.current;
                      if (vid) vid.currentTime = t;
                      setAnchorTime(t);
                    }}
                    title="Seek"
                  />
                  <span className="media-time font-mono">{formatTime(duration)}</span>
                </div>

                <div className="media-controls-row media-buttons-row annotate-controls">
                  <button className="media-btn" onClick={togglePlay} title={isPlaying ? "Pause (Space)" : "Play (Space)"}>
                    {isPlaying ? "⏸" : "▶"}
                  </button>
                  <button className="media-btn" onClick={() => stepFrame(-1)} title="Left arrow or ,">Prev frame</button>
                  <button className="media-btn" onClick={() => stepFrame(1)} title="Right arrow or .">Next frame</button>
                  <span
                    className="media-time font-mono"
                    title={fpsMeasured ? `at the measured ${fps} fps` : "at an assumed 30 fps until playback is measured"}
                  >
                    frame {frameOf(currentTime)}
                  </span>

                  <span className="annotate-sep" />
                  <button className={`media-btn ${tool === "r" ? "media-btn-active" : ""}`} onClick={() => setTool("r")} title="Draw rectangles">▭</button>
                  <button className={`media-btn ${tool === "e" ? "media-btn-active" : ""}`} onClick={() => setTool("e")} title="Draw ellipses">◯</button>
                  <button className={`media-btn ${dim ? "media-btn-active" : ""}`} onClick={() => setDim((d) => !d)} title="Darken everything outside the shapes">dim</button>
                  {shapes.length > 0 && (
                    <button className="media-btn" onClick={() => setShapes([])} title="Remove all shapes">clear</button>
                  )}
                  <span className="annotate-sep" />
                  <button className="media-btn" onClick={copyLink} title="Copy a link reproducing this exact frame, shapes and comment">Copy link</button>
                </div>

                <div className="annotate-row">
                  <input
                    type="text"
                    className="annotate-url"
                    placeholder="Comment (rides along in the link)"
                    maxLength={COMMENT_MAX}
                    value={comment}
                    onChange={(e) => setComment(cleanComment(e.target.value))}
                  />
                </div>

              </>
            )}
          </>
        )}

        {msg && <div className="annotate-msg text-muted">{msg}</div>}

        {ctx && (
          <div className="annotate-context">
            {ctx.play && (
              <div className="annotate-context-col">
                <Link to={`/plays/${ctx.sets[0].playID}`} className="annotate-context-player">
                  {ctx.play.FullName || `Play #${ctx.sets[0].playID}`}
                </Link>
                {ctx.play.TeamAtMoment && <div>{String(ctx.play.TeamAtMoment).trim()}</div>}
                <div className="text-muted">
                  {[
                    ctx.play.PlayCategory,
                    ctx.play.DateOfMoment && (formatDateISO(parseMomentDate(ctx.play.DateOfMoment)) || String(ctx.play.DateOfMoment).slice(0, 10))
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
            )}
            {ctx.matchup && <div className="annotate-context-col">{renderMatchupCell(ctx.matchup)}</div>}
            <div className="annotate-context-col annotate-context-sets">
              {ctx.sets.map((s) => (
                <span key={`${s.setID}_${s.playID}`}>
                  <Link to={`/sets/${s.setID}`}>{s.setName}</Link>
                  {s.series != null && <span className="text-muted"> S{s.series}</span>}
                  {" "}
                  <Link to={`/editions/${s.setID}_${s.playID}`} className="text-muted">edition</Link>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .annotate-page h1 { margin-bottom: 4px; }
        .annotate-hint { margin-bottom: 14px; }
        .annotate-panel { padding: 14px; }
        .annotate-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
        .annotate-row:first-child { margin-top: 0; }
        .annotate-pick {
          display: grid;
          gap: 12px;
          margin: 12px 0 16px;
        }
        .annotate-pick-body {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(240px, 340px);
          gap: 12px;
          align-items: start;
        }
        @media (max-width: 760px) {
          .annotate-pick-body { grid-template-columns: 1fr; }
        }
        .annotate-pick .edition-picker-list {
          max-height: 50vh;
        }
        .annotate-videos {
          padding: 12px 14px;
        }
        .annotate-videos h3 {
          margin: 0 0 2px;
          font-size: 1rem;
        }
        .annotate-videos-sub {
          font-size: 0.8rem;
          margin: 0 0 10px;
        }
        .annotate-video-btn {
          display: block;
          width: 100%;
          text-align: left;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          padding: 8px 10px;
          margin: 0 0 6px;
          color: #fff;
          font: inherit;
          cursor: pointer;
        }
        .annotate-video-btn:hover {
          border-color: var(--primary);
        }
        .annotate-video-btn .text-muted {
          display: block;
          font-size: 0.78rem;
        }
        .media-btn.is-on {
          border-color: var(--primary);
        }
        .annotate-url {
          flex: 1 1 240px;
          min-width: 0;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 6px;
          color: var(--text-primary);
          padding: 8px 10px;
          font-size: 0.85rem;
        }
        .annotate-file-btn { display: inline-flex; align-items: center; }
        .annotate-stage {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          align-items: center;
          gap: 18px;
          margin-top: 12px;
        }
        .annotate-stage:first-child { margin-top: 0; }
        .annotate-stage-inner {
          position: relative;
          line-height: 0;
          transition: opacity 0.2s ease;
        }
        .annotate-stage-loading { opacity: 0; }
        .annotate-stage video {
          display: block;
          max-width: 100%;
          max-height: 70vh;
          width: auto;
          height: auto;
          border-radius: 8px;
          background: #000;
        }
        .annotate-overlay {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          cursor: crosshair;
          touch-action: none;
        }
        .annotate-overlay-view { cursor: default; pointer-events: none; }
        .annotate-overlay-off { opacity: 0; pointer-events: none; transition: opacity 0.15s ease; }
        .annotate-controls { flex-wrap: wrap; }
        .annotate-sep { width: 10px; }
        .annotate-comment-view {
          margin-top: 12px;
          padding: 10px 12px;
          background: rgba(139, 92, 246, 0.08);
          border-left: 3px solid var(--primary);
          border-radius: 6px;
          font-size: 0.9rem;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .annotate-side {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 14px;
        }
        .annotate-side-item { display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .annotate-side-caption {
          display: flex;
          gap: 8px;
          align-items: center;
          font-size: 0.75rem;
          line-height: 1;
          color: var(--text-muted);
        }
        .annotate-preview-canvas {
          max-width: min(100%, 40vw);
          max-height: 60vh;
          border-radius: 8px;
          background: #000;
        }
        .annotate-shape-btn {
          background: none;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: var(--text-muted);
          font-size: 0.7rem;
          padding: 1px 6px;
          cursor: pointer;
        }
        .annotate-shape-btn:hover { color: #fff; border-color: rgba(255, 255, 255, 0.5); }
        .annotate-msg { margin-top: 10px; font-size: 0.8rem; word-break: break-all; }
        .annotate-context {
          margin-top: 12px;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          font-size: 0.9rem;
          display: flex;
          flex-wrap: wrap;
          gap: 10px 40px;
          align-items: center;
        }
        .annotate-context-col { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
        .annotate-context-player { font-weight: 700; font-size: 1.05rem; }
        .annotate-context-sets { font-size: 0.85rem; }
      `}</style>
    </div>
  );
}

const VIDEO_KINDS = ["VIDEO", "VIDEO_SQUARE", "VIDEO_TALL", "VIDEO_VERTICAL"];
// "1080x1080 · 8s · audio" once the media lookup has loaded; nothing before
const videoLine = (cid) => {
  const i = getMediaInfo(cid);
  return i && i.kind === "video" ? `${i.width}x${i.height} · ${Math.round(i.duration)}s · ${i.audioKbps > 0 ? "audio" : "silent"}` : "";
};
const loadPick = async () => {
  const [plays, sets, ipfs] = await Promise.all([getAllPlaysDB(), getAllSetsDB(), getAllIPFSDB()]);
  return { plays, sets, ipfs };
};

/**
 * Pick an edition (the same facet picker as Cube Lab, editions with at
 * least one registered video), then one of its videos; the gateway link
 * for that video is handed back as if it had been pasted.
 */
function EditionVideos({ onPick }) {
  const { data, loading, loadError, retry } = useDbData(loadPick, "Could not read the editions from the local database.");
  const ipfsMedia = useIpfsMedia();
  const names = useMemo(() => (data ? buildIdentityContext(data.plays, data.sets) : null), [data]);
  const editions = useMemo(() => {
    if (!data || !names) return [];
    return buildEditionList(data.ipfs, names).filter((e) => VIDEO_KINDS.some((k) => e.cids && e.cids[k]));
  }, [data, names]);
  const picker = useEditionPicker(editions);
  const e = picker.selected;
  const videos = e ? VIDEO_KINDS.filter((k) => e.cids[k] && isLiveCid(e.cids[k], ipfsMedia)) : [];

  if (loadError) return <div className="annotate-pick"><LoadError message={loadError} onRetry={retry} /></div>;
  if (loading || !data) return <div className="annotate-pick"><Loader message="Loading editions..." /></div>;
  return (
    <div className="annotate-pick">
      {picker.filters}
      <div className="annotate-pick-body">
        {picker.list}
        <div className="glass-panel annotate-videos">
          {e ? (
            <>
              <h3>{e.player || "Team moment"}</h3>
              <p className="text-muted annotate-videos-sub">{editionSubtitle(e)} · <span className="font-mono">{e.key}</span></p>
              {videos.map((k) => (
                <button type="button" key={k} className="annotate-video-btn" onClick={() => onPick(gatewayUrl(e.cids[k]))}>
                  {getMediaTypeLabel(k).replace(/^\S+\s+/, "")}
                  <span className="text-muted">{videoLine(e.cids[k])}</span>
                </button>
              ))}
              {videos.length === 0 && <p className="text-muted" style={{ margin: 0 }}>No video the gateway still serves for this edition.</p>}
            </>
          ) : <p className="text-muted" style={{ margin: 0 }}>Pick an edition from the list.</p>}
        </div>
      </div>
    </div>
  );
}
