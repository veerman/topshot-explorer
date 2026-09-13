import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAllPlaysDB, getAllSetsDB, getAllIPFSDB } from "../services/db.service";
import { buildIdentityContext } from "../services/identity.service";
import { buildCubeConfig, cubeFaceFor, gatewayUrl, isLiveCid, resolveCubeFace } from "../services/cube.service";
import { getMediaInfo } from "../services/ipfs.media";
import { useIpfsMedia } from "../hooks/useIpfsMedia";
import { useDbData } from "../hooks/useDbData";
import { buildEditionList, useEditionPicker } from "../components/EditionPicker";
import { toQuery } from "../utils/query";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { HoloDisplay } from "../components/HoloDisplay";

/**
 * Cube Lab: filter down to one edition and it becomes the 3D moment cube,
 * in the page rather than an overlay, with the mediacube settings as live
 * controls. The cube config is the same buildCubeConfig every editions
 * table uses, so what looks right here looks right everywhere; "Copy
 * config" hands the JSON to anyone building their own cube.
 */

// The library's settings, one control each (its own defaults; the demo
// page's ranges). Colour has no default of its own: the team colour is.
const CONTROLS = [
  { key: "glow", label: "Glow size", type: "range", min: 0, max: 40, step: 1, def: 16, unit: "px" },
  { key: "spread", label: "Glow spread", type: "range", min: 0, max: 20, step: 1, def: 0, unit: "px" },
  { key: "living", label: "Living glow", type: "check", def: false },
  { key: "intensity", label: "Intensity", type: "range", min: 1, max: 3, step: 0.1, def: 1.5, unit: "x", group: "living" },
  { key: "pulse", label: "Pulse spread", type: "range", min: 0, max: 40, step: 1, def: 12, unit: "px", group: "living" },
  { key: "glowspeed", label: "Pulse speed", type: "range", min: 0.25, max: 5, step: 0.25, def: 1.5, unit: "s", group: "living" },
  { key: "shine", label: "Shine", type: "check", def: false },
  { key: "shineop", label: "Shine opacity", type: "range", min: 0, max: 1, step: 0.05, def: 0.5, unit: "", group: "shine" },
  { key: "angle", label: "Shine angle", type: "range", min: 0, max: 360, step: 1, def: 45, unit: "°", group: "shine" },
  { key: "shinespeed", label: "Shine speed", type: "range", min: 0.5, max: 10, step: 0.5, def: 3, unit: "s", group: "shine" },
  { key: "fill", label: "Face fill", type: "range", min: 0, max: 0.9, step: 0.05, def: 0, unit: "" },
  { key: "spinop", label: "Spin opacity", type: "range", min: 0.2, max: 1, step: 0.05, def: 0.85, unit: "" },
  { key: "spin", label: "Idle spin", type: "range", min: -3, max: 3, step: 0.25, def: -1, unit: "°/f" },
  { key: "loadph", label: "Loading placeholder", type: "check", def: true }
];
const CONTROL_DEFAULTS = Object.fromEntries(CONTROLS.map((c) => [c.key, c.def]));
const TIERS = ["common", "fandom", "rare", "legendary", "ultimate"];

/** The library settings object for the control state (every key, so the
 *  readout is a complete recipe) */
function settingsFromControls(s, color) {
  return {
    cubeGlowSize: `${s.glow}px`,
    glowSpread: `${s.spread}px`,
    colorCubeGlow: color,
    livingGlow: s.living ? { intensity: s.intensity, spread: s.pulse, speed: s.glowspeed } : false,
    shine: s.shine ? { opacity: s.shineop, angle: s.angle, speed: s.shinespeed } : false,
    faceFill: s.fill > 0 ? `rgba(0, 0, 0, ${s.fill})` : "transparent",
    spinOpacity: String(s.spinop),
    idleSpinSpeed: s.spin,
    loadingPlaceholder: s.loadph ? { videoText: "▶" } : false
  };
}

const loadLab = async () => {
  const [plays, sets, ipfs] = await Promise.all([getAllPlaysDB(), getAllSetsDB(), getAllIPFSDB()]);
  return { plays, sets, ipfs };
};

export function CubeLab() {
  const { data, loading, loadError, retry } = useDbData(loadLab, "Could not read the editions from the local database.");
  const ipfsMedia = useIpfsMedia();
  // Facts per edition, the same compile every editions table uses
  const names = useMemo(() => (data ? buildIdentityContext(data.plays, data.sets) : null), [data]);

  // Every edition with registered media, newest play first
  const editions = useMemo(() => (data && names ? buildEditionList(data.ipfs, names) : []), [data, names]);

  // The facet row and the list (components/EditionPicker, shared with the
  // Frame Annotator); the cube follows the selection, or the first match
  // so the stage is never empty. Facets and edition ride in the URL.
  const picker = useEditionPicker(editions);
  const selected = picker.selected;

  return (
    <div className="cube-lab">
      <div className="glass-panel info-banner">
        <h2>Cube Lab</h2>
        <p className="text-muted mt-8" style={{ fontSize: "0.95rem" }}>
          Filter down to an edition and it becomes the 3D moment cube. The controls change the cube live, and the
          config is yours to copy.
        </p>
      </div>

      {loadError && <div className="mt-20"><LoadError message={loadError} onRetry={retry} /></div>}
      {loading && !loadError && <div className="mt-20"><Loader message="Loading editions..." /></div>}

      {data && (
        <>
          <div className="mt-20">{picker.filters}</div>

          <div className="cube-lab-body mt-20">
            <div className="glass-panel cube-lab-stage-panel">
              {selected
                ? <Stage key={selected.key} edition={selected} ipfsMedia={ipfsMedia} />
                : <p className="text-muted" style={{ margin: 0 }}>No edition matches those filters.</p>}
            </div>
            {picker.list}
          </div>
        </>
      )}

      <style>{`
        .cube-lab-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #fff;
          border-radius: 8px;
          padding: 5px 10px;
          font: inherit;
          font-size: 0.8rem;
          cursor: pointer;
        }
        .cube-lab-btn:hover {
          border-color: var(--primary);
        }
        .cube-lab-btn:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .cube-lab-body {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .cube-lab-body {
            grid-template-columns: 1fr;
          }
        }
        .cube-lab-stage-panel {
          padding: 16px;
        }
        .cube-lab-stage-head {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 4px 12px;
          margin-bottom: 10px;
        }
        .cube-lab-stage-head h3 {
          margin: 0;
          font-size: 1.05rem;
        }
        .cube-lab-stage {
          width: min(70vmin, 560px);
          height: min(70vmin, 560px);
          max-width: 100%;
          margin: 0 auto;
          background: #000;
          border-radius: 10px;
          touch-action: none;
        }
        .cube-lab-stage .mediacube-scene {
          font-family: var(--font-sans);
        }
        .cube-lab-stage .mediacube-face svg text {
          font-family: 'TopShot Emoji', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
        }
        .cube-lab-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-top: 12px;
        }
        .cube-lab-actions .cube-lab-btn,
        .cube-lab-actions .btn-primary {
          font-size: 0.8rem;
          padding: 5px 10px;
        }
        .cube-lab-link {
          background: none;
          border: none;
          padding: 5px 4px;
          margin-left: auto;
          font: inherit;
          font-size: 0.78rem;
          color: var(--text-muted);
          text-decoration: underline dotted;
          text-underline-offset: 3px;
          cursor: pointer;
        }
        .cube-lab-link:hover {
          color: #fff;
        }
        .cube-lab-link:disabled {
          opacity: 0.4;
          cursor: default;
          text-decoration: none;
        }
        .cube-lab-note {
          font-size: 0.78rem;
          margin: 8px 0 0;
        }
        .cube-lab-controls {
          margin-top: 16px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          gap: 8px 18px;
        }
        .cube-lab-control {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 2px 8px;
          font-size: 0.8rem;
        }
        .cube-lab-control input[type="range"] {
          grid-column: 1 / span 2;
          width: 100%;
        }
        .cube-lab-control output {
          font-family: var(--font-mono);
          font-size: 0.74rem;
          color: var(--primary-hover);
          white-space: nowrap;
        }
        .cube-lab-control.is-off {
          opacity: 0.45;
        }
        .cube-lab-control select {
          grid-column: 1 / span 2;
          font-size: 0.8rem;
        }
        .cube-lab-config {
          margin-top: 14px;
          font-size: 0.8rem;
        }
        .cube-lab-config pre {
          margin: 8px 0 0;
          max-height: 320px;
          overflow: auto;
          font-size: 0.72rem;
          background: rgba(0, 0, 0, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 10px;
          white-space: pre;
        }
      `}</style>
    </div>
  );
}

/** The faces an edition can front with, given what is live at the gateway */
function faceChoices(cids, ipfsMedia) {
  const out = [];
  if (isLiveCid(cids.VIDEO_SQUARE, ipfsMedia)) out.push(["video", "Square video"]);
  if (isLiveCid(cids.PLAYER, ipfsMedia)) out.push(["player", "Player image"]);
  if (isLiveCid(cids.HERO, ipfsMedia)) out.push(["hero", "Hero"]);
  return out;
}

function faceFor(choice, cids, ipfsMedia, series) {
  if (choice === "video" && cids.VIDEO_SQUARE) {
    return { type: "video", src: gatewayUrl(cids.VIDEO_SQUARE), duration: ipfsMedia ? getMediaInfo(cids.VIDEO_SQUARE)?.duration : undefined };
  }
  if (choice === "player" && cids.PLAYER) return { type: "image", src: gatewayUrl(cids.PLAYER) };
  if (choice === "hero" && cids.HERO) return { type: "image", src: gatewayUrl(cids.HERO) };
  return cubeFaceFor({ cids, ipfsMedia, series });
}

/**
 * One edition on stage. Remounted per edition (key on the caller), so the
 * cube, the controls and the tier override start fresh each time.
 */
function Stage({ edition, ipfsMedia }) {
  const boxRef = useRef(null);
  const cubeRef = useRef(null);
  const [controls, setControls] = useState(CONTROL_DEFAULTS);
  const [tier, setTier] = useState("auto");
  const [faceChoice, setFaceChoice] = useState("auto");
  const [color, setColor] = useState("");
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState("");
  // The hologram pyramid source display, "video" or "cube"; ?holo=video
  // or ?holo=cube opens it on arrival (?holo=1 is the video form), so a
  // link made on a desktop opens straight into it on the phone
  const [holo, setHolo] = useState(() => {
    const v = new URLSearchParams(window.location.search).get("holo");
    return v === "cube" ? "cube" : (v === "1" || v === "video" ? "video" : "");
  });
  const holoSrc = isLiveCid(edition.cids.VIDEO_SQUARE, ipfsMedia)
    ? gatewayUrl(edition.cids.VIDEO_SQUARE)
    : (isLiveCid(edition.cids.VIDEO, ipfsMedia) ? gatewayUrl(edition.cids.VIDEO) : null);
  const setHoloAndUrl = useCallback((next) => {
    setHolo(next);
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("holo", next); else params.delete("holo");
    const qs = toQuery(params);
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);
  const closeHolo = useCallback(() => setHoloAndUrl(""), [setHoloAndUrl]);

  const effectiveTier = tier === "auto" ? edition.tier : tier;
  const choices = useMemo(() => faceChoices(edition.cids, ipfsMedia), [edition, ipfsMedia]);

  // Build the config the tables would build, with the tier, face and
  // colour overrides folded in; the slider settings are baked in at
  // construction (below) and pushed through update() afterwards
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const face = await resolveCubeFace(faceFor(faceChoice, edition.cids, ipfsMedia, edition.series));
      if (cancelled) return;
      if (!face) { setConfig(null); setStatus("Nothing at the gateway can front a cube for this edition."); return; }
      const base = buildCubeConfig(edition.play, effectiveTier, face);
      const next = { ...base, settings: { ...base.settings, colorCubeGlow: color || base.settings.colorCubeGlow } };
      if (color) {
        // A colour override recolours the card frames too, as the tables do with the team colour
        for (const side of ["side_1", "side_2", "side_3", "side_4"]) {
          const layers = Array.isArray(next[side]) ? next[side] : [next[side]];
          next[side] = layers.map((l) => (l && l.tier ? { ...l, colorCube: color, colorFrame: color } : l));
          if (!Array.isArray(base[side])) next[side] = next[side][0];
        }
        next.core = { ...next.core, style: next.core.style.replace(/#[0-9a-fA-F]{6}/g, color) };
      }
      setStatus("");
      setConfig(next);
    })();
    return () => { cancelled = true; };
  }, [edition, ipfsMedia, effectiveTier, faceChoice, color]);

  // The latest slider state, for the constructor; sliders never rebuild
  const controlsRef = useRef(CONTROL_DEFAULTS);
  useEffect(() => { controlsRef.current = controls; }, [controls]);

  useEffect(() => {
    if (!config || !boxRef.current) return undefined;
    let cancelled = false;
    import("mediacube")
      .then(({ default: MediaCube }) => {
        if (cancelled || !boxRef.current) return;
        const settings = { ...config.settings, ...settingsFromControls(controlsRef.current, config.settings.colorCubeGlow) };
        cubeRef.current = new MediaCube(boxRef.current, { ...config, settings });
      })
      .catch((err) => {
        console.error("Failed to load the cube library:", err);
        if (!cancelled) setStatus("Could not load the cube library.");
      });
    return () => {
      cancelled = true;
      if (cubeRef.current) { cubeRef.current.destroy(); cubeRef.current = null; }
    };
  }, [config]);

  // Live settings: push through update() without rebuilding the faces
  const setControl = useCallback((key, value) => {
    setControls((prev) => {
      const next = { ...prev, [key]: value };
      if (cubeRef.current && config) {
        cubeRef.current.update(settingsFromControls(next, config.settings.colorCubeGlow));
      }
      return next;
    });
  }, [config]);

  const shownConfig = useMemo(() => {
    if (!config) return "";
    return JSON.stringify({ ...config, settings: { ...config.settings, ...settingsFromControls(controls, config.settings.colorCubeGlow) } }, null, 2);
  }, [config, controls]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shownConfig);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(""), 1200);
  };

  const showFace = (name) => { if (cubeRef.current) cubeRef.current.showFace(name); };
  const reset = () => {
    setControls(CONTROL_DEFAULTS);
    setTier("auto");
    setFaceChoice("auto");
    setColor("");
    if (cubeRef.current && config) cubeRef.current.update(settingsFromControls(CONTROL_DEFAULTS, config.settings.colorCubeGlow));
  };

  const title = [edition.player || "Team moment", edition.setName, edition.ptype, edition.year].filter(Boolean).join(" · ");

  return (
    <div>
      <div className="cube-lab-stage-head">
        <h3>{title}</h3>
        <span className="font-mono text-muted" style={{ fontSize: "0.78rem" }}>{edition.key}</span>
      </div>

      {status
        ? <p className="text-muted" style={{ margin: 0 }}>{status}</p>
        : <div ref={boxRef} className="cube-lab-stage" title="Drag to spin" />}

      <div className="cube-lab-actions">
        {["side_1", "side_2", "side_3", "side_4"].map((f, i) => (
          <button key={f} type="button" className="cube-lab-btn" onClick={() => showFace(f)} disabled={!config}>Face {i + 1}</button>
        ))}
        <button type="button" className="cube-lab-btn" onClick={reset}>Reset</button>
        <button type="button" className="btn-primary" onClick={copy} disabled={!config}>{copied || "Copy config"}</button>
        <button
          type="button"
          className="cube-lab-link"
          onClick={() => setHoloAndUrl("video")}
          disabled={!holoSrc}
          title={holoSrc
            ? "Full-screen source display for a four-sided hologram pyramid: lay the pyramid on the screen, point up"
            : "No video at the gateway for this edition"}
        >
          Hologram pyramid
        </button>
      </div>
      {holo && holoSrc && (
        <HoloDisplay src={holoSrc} cubeConfig={config} title={title} mode={holo} onMode={setHoloAndUrl} onClose={closeHolo} />
      )}

      <div className="cube-lab-controls">
        <label className="cube-lab-control">
          <span>Tier</span>
          <output>{tier === "auto" ? `auto (${edition.tier || "common"})` : tier}</output>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="auto">Auto</option>
            {TIERS.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </label>
        <label className="cube-lab-control">
          <span>Front face</span>
          <output>{faceChoice}</output>
          <select value={faceChoice} onChange={(e) => setFaceChoice(e.target.value)}>
            <option value="auto">Auto</option>
            {choices.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
          </select>
        </label>
        <label className="cube-lab-control">
          <span>Colour</span>
          <output>{color ? color.toUpperCase() : "team"}</output>
          <span style={{ gridColumn: "1 / span 2", display: "flex", gap: "8px", alignItems: "center" }}>
            <input type="color" value={color || (config ? config.settings.colorCubeGlow : "#8b5cf6")} onChange={(e) => setColor(e.target.value)} />
            {color && <button type="button" className="cube-lab-btn" style={{ fontSize: "0.72rem", padding: "2px 8px" }} onClick={() => setColor("")}>Team colour</button>}
          </span>
        </label>
        {CONTROLS.map((c) => {
          const off = c.group && !controls[c.group];
          return (
            <label key={c.key} className={`cube-lab-control${off ? " is-off" : ""}`}>
              <span>{c.label}</span>
              {c.type === "range"
                ? <>
                    <output>{controls[c.key]}{c.unit}</output>
                    <input type="range" min={c.min} max={c.max} step={c.step} value={controls[c.key]} disabled={off}
                      onChange={(e) => setControl(c.key, Number(e.target.value))} />
                  </>
                : <input type="checkbox" checked={controls[c.key]} onChange={(e) => setControl(c.key, e.target.checked)} />}
            </label>
          );
        })}
      </div>

      <details className="cube-lab-config">
        <summary>Config</summary>
        <pre>{shownConfig}</pre>
      </details>
    </div>
  );
}
