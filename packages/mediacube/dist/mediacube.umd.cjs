/*! mediacube v0.3.0 | MIT License |  */
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        var api = factory();
        root.MediaCube = api.MediaCube;
        root.MediaCubeLib = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---- src/styles.js ----
    // MediaCube stylesheet, shipped as a string so the library has no runtime
    // path dependency. MediaCube.injectStyles() drops it into <head> once.

    const MEDIACUBE_CSS = `
    media-cube { display: block; }

    .mediacube-scene {
        width: 100%;
        height: 100%;
        perspective: var(--perspective, 1000px);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        touch-action: none;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: geometricPrecision;
    }
    .mediacube-world {
        width: var(--cube-size, 300px);
        height: var(--cube-size, 300px);
        position: relative;
        transform-style: preserve-3d;
    }
    .mediacube-cube,
    .mediacube-core {
        position: absolute;
        width: 100%;
        height: 100%;
        transform-style: preserve-3d;
        user-select: none;
        -webkit-user-select: none;
    }
    .mediacube-core {
        pointer-events: none;
        font-size: var(--cube-size, 300px);
    }
    .mediacube-core-face,
    .mediacube-text-face {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        transform-style: flat;
    }
    .mediacube-face {
        position: absolute;
        width: 100%;
        height: 100%;
        display: grid;
        font-size: var(--cube-size, 300px);
        background: var(--face-fill, transparent);
        box-shadow: 0 0 var(--glow-blur, 16px) var(--glow-spread, 0px) var(--color-cube-glow, #007A33);
        backface-visibility: visible;
        transform-style: preserve-3d;
        animation: var(--glow-animation, none);
    }
    .mediacube-face img,
    .mediacube-face video,
    .mediacube-face svg {
        grid-area: 1 / 1;
        place-self: center;
        width: 100%;
        height: 100%;
        object-fit: contain;
        pointer-events: none;
    }
    .mediacube-media-wrapper {
        grid-area: 1 / 1;
        place-self: center;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
    }
    .mediacube-media-wrapper img,
    .mediacube-media-wrapper video {
        object-fit: cover;
        transform-origin: center;
    }
    .mediacube-text-layer {
        grid-area: 1 / 1;
        place-self: center;
        width: 100%;
        height: 100%;
        position: relative;
        transform-style: preserve-3d;
        pointer-events: none;
    }
    .mediacube-face img,
    .mediacube-face video,
    .svg-base-layer {
        opacity: 1;
        transition: opacity 0.4s ease;
    }
    .mediacube-cube.is-spinning .mediacube-face img,
    .mediacube-cube.is-spinning .mediacube-face video,
    .mediacube-cube.is-spinning .svg-base-layer {
        opacity: var(--spin-opacity, 0.85);
    }

    .mediacube-face[data-face="top"]    { transform: rotateX(90deg)  translate3d(0, 0, var(--translate-z)); }
    .mediacube-face[data-face="bottom"] { transform: rotateX(-90deg) translate3d(0, 0, var(--translate-z)); }
    .mediacube-face[data-face="side_1"] { transform: rotateY(0deg)   translate3d(0, 0, var(--translate-z)); }
    .mediacube-face[data-face="side_2"] { transform: rotateY(90deg)  translate3d(0, 0, var(--translate-z)); }
    .mediacube-face[data-face="side_3"] { transform: rotateY(180deg) translate3d(0, 0, var(--translate-z)); }
    .mediacube-face[data-face="side_4"] { transform: rotateY(-90deg) translate3d(0, 0, var(--translate-z)); }

    /* SVG cards: the base layer draws shapes only, the pop layers draw text only
       (stacked along Z to fake extruded 3D lettering). */
    .svg-base-layer text,
    .svg-base-layer tspan { display: none !important; }
    .svg-pop-layer *:not(text):not(tspan):not(g):not(defs):not(style) { display: none !important; }
    .svg-pop-wrapper {
        grid-area: 1 / 1;
        place-self: center;
        width: 100%;
        height: 100%;
        display: grid;
        transform-style: flat;
        pointer-events: none;
    }

    /* Loading placeholder: a media layer is a dark shimmering tile until its
       first frame is available, so the face is never see-through while a
       remote file downloads. */
    .mediacube-media-wrapper.is-loading,
    .mediacube-media-wrapper.is-error {
        position: relative;
        background: var(--loading-fill, rgba(18, 18, 18, 0.92));
    }
    .mediacube-face .mediacube-media-wrapper.is-loading > img,
    .mediacube-face .mediacube-media-wrapper.is-loading > video,
    .mediacube-face .mediacube-media-wrapper.is-error > img,
    .mediacube-face .mediacube-media-wrapper.is-error > video {
        opacity: 0;
    }
    .mediacube-media-wrapper.is-loading::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(110deg, transparent 30%, var(--loading-shimmer, rgba(255, 255, 255, 0.10)) 50%, transparent 70%);
        background-size: 250% 100%;
        animation: mediacube-shimmer 1.6s infinite linear;
        pointer-events: none;
    }
    @keyframes mediacube-shimmer {
        0%   { background-position: 150% 0; }
        100% { background-position: -150% 0; }
    }
    .mediacube-loading-text { display: none; }
    .mediacube-media-wrapper.is-loading > .mediacube-loading-text,
    .mediacube-media-wrapper.is-error > .mediacube-loading-text {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        color: var(--loading-text-color, rgba(255, 255, 255, 0.6));
        font-size: 14%;
        line-height: 1;
        animation: mediacube-loading-pulse 1.4s infinite ease-in-out;
        pointer-events: none;
        user-select: none;
    }
    @keyframes mediacube-loading-pulse {
        0%, 100% { opacity: 0.3; }
        50%      { opacity: 0.9; }
    }
    .mediacube-media-wrapper.is-error .mediacube-loading-text {
        animation: none;
        opacity: 0.4;
    }
    @media (prefers-reduced-motion: reduce) {
        .mediacube-media-wrapper.is-loading::before,
        .mediacube-loading-text { animation: none; }
    }

    /* Optional effects, enabled per cube through settings.livingGlow / settings.shine */
    @keyframes mediacube-living-glow {
        0%   { box-shadow: 0 0 var(--glow-blur, 16px) var(--glow-spread, 0px) var(--color-cube-glow, #007A33); }
        100% { box-shadow: 0 0 calc(var(--glow-blur, 16px) * var(--glow-pulse-intensity, 1.5)) calc(var(--glow-spread, 0px) + var(--glow-pulse-spread, 12px)) var(--color-cube-glow, #007A33); }
    }
    .mediacube-cube.has-shine .mediacube-face::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(var(--shine-angle, 45deg), rgba(255,255,255,0) 35%, rgba(255,255,255,var(--shine-opacity, 0.5)) 50%, rgba(255,255,255,0) 65%);
        background-size: 300% 300%;
        background-position: 200% 200%;
        mix-blend-mode: overlay;
        pointer-events: none;
        z-index: 10;
        animation: var(--shine-animation, none);
    }
    @keyframes mediacube-shine-sweep {
        0%   { background-position: 200% 200%; }
        100% { background-position: -100% -100%; }
    }
    `;

    // ---- src/card-template.js ----
    // Built-in card template (the former master-card.svg), inlined so nothing has
    // to be fetched at runtime. A layer with type "card" (or one that has a
    // tier/layout but no src) uses this template.
    //
    // Switching:
    //   data-layout  default | top-emoji | center-emoji | center-four-lines | player | score
    //   data-tier    common | rare | fandom | legendary | ultimate
    // Text slots: any element with a .tpl-* class can be filled through layer.text.
    // Colors:     --color-cube (tier lines), --color-frame (inner border), --color-text.

    const CARD_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="mediacube-card">
      <style>
        .mediacube-card .tier-layer,
        .mediacube-card .layout-layer { display: none; }

        .mediacube-card[data-layout="default"]           .layout-default           { display: inline; }
        .mediacube-card[data-layout="top-emoji"]         .layout-top-emoji         { display: inline; }
        .mediacube-card[data-layout="center-emoji"]      .layout-center-emoji      { display: inline; }
        .mediacube-card[data-layout="center-four-lines"] .layout-center-four-lines { display: inline; }
        .mediacube-card[data-layout="player"]            .layout-player            { display: inline; }
        .mediacube-card[data-layout="score"]             .layout-score             { display: inline; }

        .mediacube-card[data-tier="common"]    .tier-common    { display: inline; }
        .mediacube-card[data-tier="rare"]      .tier-rare      { display: inline; }
        .mediacube-card[data-tier="fandom"]    .tier-fandom    { display: inline; }
        .mediacube-card[data-tier="legendary"] .tier-legendary { display: inline; }
        .mediacube-card[data-tier="ultimate"]  .tier-ultimate  { display: inline; }

        .mediacube-card .inner-border {
          fill: none;
          stroke: var(--color-frame, #888888);
          stroke-width: 2;
        }
        .mediacube-card .tier-line {
          fill: none;
          stroke: var(--color-cube, #007A33);
          stroke-linecap: square;
          stroke-linejoin: miter;
        }
        .mediacube-card .tier-thick { stroke-width: 2; }
        .mediacube-card .tier-thin  { stroke-width: 0.666; }

        .mediacube-card .card-text {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          text-anchor: middle;
          dominant-baseline: central;
          alignment-baseline: central;
          fill: var(--color-text, #ffffff);
        }
        .mediacube-card .text-left     { text-anchor: start; }
        .mediacube-card .text-bold     { font-weight: 700; }
        .mediacube-card .text-main     { font-size: 52px; }
        .mediacube-card .text-emoji    { font-size: 26px; }
        .mediacube-card .text-emoji-lg { font-size: 36px; }
        .mediacube-card .text-line     { font-size: 9px; }
        .mediacube-card .text-name     { font-size: 8px; letter-spacing: 0.08em; }
        .mediacube-card .text-badge    { font-size: 4.5px; }
        .mediacube-card .text-score    { font-size: 20px; }
        .mediacube-card .text-x        { font-size: 7px; }
        .mediacube-card .text-label    { font-size: 4.5px; letter-spacing: 0.12em; }
        .mediacube-card .text-team     { font-size: 8px; }
        .mediacube-card .text-footer   { font-size: 4px; letter-spacing: 0.08em; }
        .mediacube-card .footer-box {
          fill: none;
          stroke: var(--color-text, #ffffff);
          stroke-width: 0.5;
        }
      </style>

      <g class="inner-content">
        <rect class="inner-border" x="10" y="10" width="80" height="80"></rect>

        <g class="layout-layer layout-default">
          <text class="card-text text-main tpl-main" x="50" y="51.5"></text>
        </g>

        <g class="layout-layer layout-top-emoji">
          <text class="card-text text-emoji tpl-emoji" x="50" y="32">🍀</text>
          <text class="card-text text-line tpl-line1" x="50" y="58">LINE ONE</text>
          <text class="card-text text-line tpl-line2" x="50" y="70">LINE TWO</text>
          <text class="card-text text-line tpl-line3" x="50" y="82">LINE THREE</text>
        </g>

        <g class="layout-layer layout-center-emoji">
          <text class="card-text text-line text-bold tpl-line1" x="50" y="22">LINE ONE</text>
          <text class="card-text text-line tpl-line2" x="50" y="34">LINE TWO</text>
          <text class="card-text text-emoji-lg tpl-emoji" x="50" y="52">🍀</text>
          <text class="card-text text-line text-bold tpl-line3" x="50" y="82">LINE THREE</text>
        </g>

        <g class="layout-layer layout-center-four-lines">
          <text class="card-text text-line tpl-line1" x="50" y="25">LINE ONE</text>
          <text class="card-text text-line tpl-line2" x="50" y="42">LINE TWO</text>
          <text class="card-text text-line tpl-line3" x="50" y="59">LINE THREE</text>
          <text class="card-text text-line tpl-line4" x="50" y="76">LINE FOUR</text>
        </g>

        <g class="layout-layer layout-player">
          <text class="card-text text-left text-badge tpl-badge" x="14" y="15"></text>
          <text class="card-text text-left text-name text-bold tpl-name" x="14" y="85"></text>
        </g>

        <g class="layout-layer layout-score">
          <text class="card-text text-score text-bold tpl-home-score" x="30" y="47">0</text>
          <text class="card-text text-x tpl-x" x="50" y="49">x</text>
          <text class="card-text text-score text-bold tpl-away-score" x="70" y="47">0</text>
          <text class="card-text text-label text-bold tpl-home-label" x="30" y="58">HOME</text>
          <text class="card-text text-label text-bold tpl-away-label" x="70" y="58">AWAY</text>
          <text class="card-text text-team text-bold tpl-home-team" x="30" y="66"></text>
          <text class="card-text text-team text-bold tpl-away-team" x="70" y="66"></text>
          <rect class="footer-box" x="34" y="76" width="32" height="8"></rect>
          <text class="card-text text-footer tpl-footer" x="50" y="80">FINAL SCORE</text>
        </g>
      </g>

      <g class="tier-layer tier-common"></g>

      <g class="tier-layer tier-rare">
        <path class="tier-line tier-thick" d="M 10 1 L 1 1 L 1 10"></path>
        <path class="tier-line tier-thick" d="M 90 1 L 99 1 L 99 10"></path>
        <path class="tier-line tier-thick" d="M 1 90 L 1 99 L 10 99"></path>
        <path class="tier-line tier-thick" d="M 99 90 L 99 99 L 90 99"></path>
      </g>

      <g class="tier-layer tier-fandom">
        <line class="tier-line tier-thick" x1="18" y1="1" x2="82" y2="1"></line>
        <line class="tier-line tier-thick" x1="82" y1="99" x2="18" y2="99"></line>
      </g>

      <g class="tier-layer tier-legendary">
        <line class="tier-line tier-thin" x1="18" y1="1" x2="82" y2="1"></line>
        <line class="tier-line tier-thin" x1="99" y1="18" x2="99" y2="82"></line>
        <line class="tier-line tier-thin" x1="82" y1="99" x2="18" y2="99"></line>
        <line class="tier-line tier-thin" x1="1" y1="82" x2="1" y2="18"></line>
        <path class="tier-line tier-thick" d="M 18 1 L 1 1 L 1 18"></path>
        <path class="tier-line tier-thick" d="M 82 1 L 99 1 L 99 18"></path>
        <path class="tier-line tier-thick" d="M 1 82 L 1 99 L 18 99"></path>
        <path class="tier-line tier-thick" d="M 99 82 L 99 99 L 82 99"></path>
      </g>

      <g class="tier-layer tier-ultimate">
        <line class="tier-line tier-thin" x1="18" y1="1" x2="82" y2="1"></line>
        <line class="tier-line tier-thin" x1="99" y1="18" x2="99" y2="82"></line>
        <line class="tier-line tier-thin" x1="82" y1="99" x2="18" y2="99"></line>
        <line class="tier-line tier-thin" x1="1" y1="82" x2="1" y2="18"></line>
        <path class="tier-line tier-thick" d="M 18 1 L 10 1 L 1 10 L 1 18"></path>
        <path class="tier-line tier-thick" d="M 82 1 L 90 1 L 99 10 L 99 18"></path>
        <path class="tier-line tier-thick" d="M 1 82 L 1 90 L 10 99 L 18 99"></path>
        <path class="tier-line tier-thick" d="M 99 82 L 99 90 L 90 99 L 82 99"></path>
      </g>
    </svg>`;

    // ---- src/mediacube.js ----
    // MediaCube: an interactive 3D "moment cube". Each of the six faces can hold
    // any number of stacked layers: video (with poster frame and in/out points),
    // image, SVG card (built-in template or your own), or extruded 3D text/emoji.
    // A 3D "core" object floats in the middle of the cube.
    //
    // No runtime file dependencies: styles and the card template are inlined.



    const FACE_NAMES = ['top', 'bottom', 'side_1', 'side_2', 'side_3', 'side_4'];
    const FACE_ANGLES_Y = { side_1: 0, side_2: -90, side_3: -180, side_4: 90 };
    const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)([?#]|$)/i;
    const SVG_RE = /\.svg([?#]|$)/i;
    const STYLE_ID = 'mediacube-styles';

    const DEFAULT_SETTINGS = {
        cubeGlowSize: '16px',      // blur radius of the edge glow (scaled with cube size)
        colorCubeGlow: '#007A33',
        glowSpread: '0px',         // box-shadow spread of the edge glow
        faceOverlap: '0.5px',      // pulls faces inward slightly to hide seams
        faceFill: 'transparent',   // e.g. 'rgba(0,0,0,0.5)' for smoked glass faces
        spinOpacity: '0.85',       // media opacity while the cube is moving
        textThickness: 8,          // number of Z slices used for extruded text
        textElevation: 20,         // px (at 500px cube) that face text floats above the face
        idleSpinSpeed: -1,         // degrees per frame while no video is playing (0 = still)
        // Keep idling past a video face until its clip can play, then turn the
        // shortest way onto it (either direction, never more than half a turn)
        // in arriveMs for a half turn, less for less. The spin itself is the
        // loading indicator. false: snap to the face at once and hold the
        // placeholder there until the clip plays.
        waitForVideo: false,
        arriveMs: 300,
        livingGlow: false,         // false | true | { intensity: 1.5, spread: 12, speed: 1.5 }
        shine: false,              // false | true | { opacity: 0.5, angle: 45, speed: 3 }
        // Placeholder shown on a media layer until its first frame is available.
        // false | true | { text, videoText, style, fill, shimmer, textColor }
        loadingPlaceholder: true
    };
    const LOADING_DEFAULTS = {
        text: '',                  // optional glyph for images while loading (none by default)
        videoText: '',             // optional glyph for videos while loading, e.g. '▶' (none by default)
        style: '',                 // extra CSS for the glyph
        fill: 'rgba(18, 18, 18, 0.92)',
        shimmer: 'rgba(255, 255, 255, 0.10)',   // false to disable the sweep
        textColor: 'rgba(255, 255, 255, 0.6)'
    };
    const DEFAULT_CORE = {
        text: '🍀',
        style: 'color: #007A33; font-size: 45%; font-weight: bold; letter-spacing: 0.1em; text-shadow: 0 0 0.04em #007A33, 0 0 0.08em #007A33;',
        spinFactor: -2,            // core rotateY = rotY * spinFactor + spinOffset
        spinOffset: -90
    };
    const LIVING_GLOW_DEFAULTS = { intensity: 1.5, spread: 12, speed: 1.5 };
    const SHINE_DEFAULTS = { opacity: 0.5, angle: 45, speed: 3 };

    const DARKEN = 'color-mix(in srgb, currentColor 30%, #000000)';

    function toArray(value) {
        if (value === undefined || value === null || value === '') return [];
        return Array.isArray(value) ? value : [value];
    }

    function normalizeLayer(raw) {
        return typeof raw === 'string' ? { src: raw } : { ...raw };
    }

    // Layer kinds: 'video' | 'image' | 'svg' | 'card' | 'text'.
    // An explicit layer.type always wins; otherwise it is inferred.
    function detectKind(layer) {
        if (layer.type) return layer.type;
        if (typeof layer.svg === 'string') return 'svg';
        const src = layer.src;
        if (typeof src === 'string') {
            if (src.trim().startsWith('<svg')) return 'svg';
            if (SVG_RE.test(src)) return 'svg';
            if (VIDEO_RE.test(src)) return 'video';
            return 'image';
        }
        if (layer.layout || layer.tier || (layer.text && typeof layer.text === 'object')) return 'card';
        if (typeof layer.text === 'string') return 'text';
        return 'card';
    }

    class MediaCube {
        static FACES = FACE_NAMES.slice();
        static CARD_SVG = CARD_SVG;
        static CSS = MEDIACUBE_CSS;
        static _svgCache = new Map();

        // Inject the stylesheet once per document. Called automatically.
        static injectStyles(doc = document) {
            if (doc.getElementById(STYLE_ID)) return;
            const style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = MEDIACUBE_CSS;
            doc.head.appendChild(style);
        }

        static mergeConfig(user = {}) {
            const core = (user.core === null || user.core === false)
                ? null
                : { ...DEFAULT_CORE, ...(user.core || {}) };
            return {
                ...user,
                settings: { ...DEFAULT_SETTINGS, ...(user.settings || {}) },
                core,
                cardSvg: user.cardSvg || CARD_SVG
            };
        }

        constructor(container, userConfig = {}) {
            this.container = typeof container === 'string'
                ? document.getElementById(container)
                : container;
            if (!this.container) throw new Error('MediaCube: container element not found');

            this.config = MediaCube.mergeConfig(userConfig);
            this.faces = {};
            this.videoRegistry = [];
            this.currentVideo = null;
            this.lastPlayedVideo = null;
            this.isDragging = false;
            this.wasSpinning = false;
            this.prevX = 0; this.prevY = 0; this.prevTime = 0;
            this.rotX = 0; this.rotY = 0; this.spinY = 0; this.velX = 0;
            this.arrival = null;       // in-flight turn onto a face whose video became ready
            this.rafId = 0;
            this.destroyed = false;
            this._listeners = [];

            this.init();
        }

        // ------------------------------------------------------------------
        // Setup
        // ------------------------------------------------------------------

        init() {
            MediaCube.injectStyles(this.container.ownerDocument);
            this.buildDom();
            this.resizeObserver = new ResizeObserver(() => this.applyGlobalStyles());
            this.resizeObserver.observe(this.container);
            this.applyGlobalStyles();
            this.applyEffects();
            this.populateFaces();
            this.buildCore();
            this.checkInitialVideo();
            this.setupInteraction();
            this.applyTransform();
            this.startRenderLoop();
        }

        buildDom() {
            const doc = this.container.ownerDocument;
            const el = (cls) => { const d = doc.createElement('div'); d.className = cls; return d; };

            this.scene = el('mediacube-scene');
            this.world = el('mediacube-world');
            this.cubeEl = el('mediacube-cube');
            this.coreEl = el('mediacube-core');

            for (const name of FACE_NAMES) {
                const face = el('mediacube-face');
                face.dataset.face = name;
                this.faces[name] = face;
                this.cubeEl.appendChild(face);
            }

            this.world.appendChild(this.cubeEl);
            this.world.appendChild(this.coreEl);
            this.scene.appendChild(this.world);
            this.container.classList.add('mediacube-container');
            this.container.appendChild(this.scene);
        }

        applyGlobalStyles() {
            if (this.destroyed) return;
            const width = this.container.clientWidth || 620;
            const height = this.container.clientHeight || 620;
            const minDim = Math.min(width, height);

            // 0.55 leaves room for the cube's diagonal so it never clips while rotating.
            this.cubeSize = minDim * 0.55;
            this.scale = this.cubeSize / 500;

            const s = this.config.settings;
            const root = this.container.style;
            root.setProperty('--cube-scale', this.scale);
            root.setProperty('--cube-size', `${this.cubeSize}px`);
            root.setProperty('--face-overlap', s.faceOverlap || '0.5px');
            root.setProperty('--translate-z', `calc(${this.cubeSize / 2}px - var(--face-overlap, 0.5px))`);
            root.setProperty('--perspective', `${this.cubeSize * 4}px`);

            const glow = parseFloat(s.cubeGlowSize);
            root.setProperty('--glow-blur', `${(Number.isNaN(glow) ? 16 : glow) * this.scale}px`);
            root.setProperty('--glow-spread', s.glowSpread || '0px');
            root.setProperty('--color-cube-glow', s.colorCubeGlow || '#007A33');
            root.setProperty('--spin-opacity', s.spinOpacity ?? '0.85');
            root.setProperty('--face-fill', s.faceFill || 'transparent');

            const lp = this.loadingOptions();
            root.setProperty('--loading-fill', lp.fill);
            root.setProperty('--loading-shimmer', lp.shimmer === false ? 'transparent' : lp.shimmer);
            root.setProperty('--loading-text-color', lp.textColor);
        }

        loadingOptions(layer) {
            const s = this.config.settings.loadingPlaceholder;
            const base = { ...LOADING_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
            if (!layer) return base;
            if (layer.loading === false || !s) return null;
            const own = typeof layer.loading === 'string'
                ? { text: layer.loading, videoText: layer.loading }
                : (layer.loading && typeof layer.loading === 'object' ? layer.loading : {});
            return { ...base, ...own };
        }

        applyEffects() {
            const s = this.config.settings;
            const root = this.container.style;

            const glow = s.livingGlow;
            if (glow) {
                const o = { ...LIVING_GLOW_DEFAULTS, ...(typeof glow === 'object' ? glow : {}) };
                root.setProperty('--glow-pulse-intensity', o.intensity);
                root.setProperty('--glow-pulse-spread', `${parseFloat(o.spread) || 0}px`);
                root.setProperty('--glow-animation', `mediacube-living-glow ${o.speed}s infinite alternate ease-in-out`);
            } else {
                root.setProperty('--glow-animation', 'none');
            }

            const shine = s.shine;
            if (shine) {
                const o = { ...SHINE_DEFAULTS, ...(typeof shine === 'object' ? shine : {}) };
                root.setProperty('--shine-opacity', o.opacity);
                root.setProperty('--shine-angle', `${parseFloat(o.angle) || 0}deg`);
                root.setProperty('--shine-animation', `mediacube-shine-sweep ${o.speed}s infinite linear`);
                this.cubeEl.classList.add('has-shine');
            } else {
                this.cubeEl.classList.remove('has-shine');
            }
        }

        // Change settings at runtime, e.g. cube.update({ livingGlow: true, colorCubeGlow: '#f00' })
        update(settings = {}) {
            this.config.settings = { ...this.config.settings, ...settings };
            this.applyGlobalStyles();
            this.applyEffects();
            return this;
        }

        // ------------------------------------------------------------------
        // Faces and layers
        // ------------------------------------------------------------------

        populateFaces() {
            for (const name of FACE_NAMES) {
                toArray(this.config[name]).forEach(layer => this.addLayer(name, layer));
            }
        }

        // Replace everything on one face: cube.setFace('side_2', [ ...layers ])
        setFace(name, layers) {
            if (!this.faces[name]) throw new Error(`MediaCube: unknown face "${name}"`);
            this.clearFace(name);
            this.config[name] = layers;
            toArray(layers).forEach(layer => this.addLayer(name, layer));
            return this;
        }

        clearFace(name) {
            const face = this.faces[name];
            if (!face) return this;
            this.videoRegistry = this.videoRegistry.filter(v => {
                if (v.face !== name) return true;
                v.el.pause();
                if (this.currentVideo === v) this.currentVideo = null;
                if (this.lastPlayedVideo === v) this.lastPlayedVideo = null;
                return false;
            });
            face.replaceChildren();
            return this;
        }

        addLayer(faceName, rawLayer) {
            if (rawLayer === undefined || rawLayer === null || rawLayer === '') return;
            const face = this.faces[faceName];
            if (!face) return;
            const layer = normalizeLayer(rawLayer);
            const kind = detectKind(layer);

            switch (kind) {
                case 'text':  this.addTextLayer(face, layer); break;
                case 'card':  this.addSvgLayer(face, layer, this.config.cardSvg); break;
                case 'svg':   this.addSvgLayer(face, layer, typeof layer.svg === 'string' ? layer.svg : layer.src); break;
                case 'video': this.addMediaLayer(faceName, face, layer, true); break;
                case 'image': this.addMediaLayer(faceName, face, layer, false); break;
                default: console.warn(`MediaCube: unknown layer type "${kind}"`, layer);
            }
        }

        // --- image / video ---

        createMediaNode(layer, isVideo) {
            const doc = this.container.ownerDocument;
            const wrapper = doc.createElement('div');
            wrapper.className = 'mediacube-media-wrapper';
            if (layer.style) wrapper.style.cssText += layer.style;

            const media = doc.createElement(isVideo ? 'video' : 'img');
            if (!isVideo) {
                media.alt = layer.alt || '';
                media.draggable = false;
            }

            const transform = [];
            if (layer.zoom !== undefined) transform.push(`scale(${layer.zoom})`);
            if (layer.offsetX !== undefined) transform.push(`translateX(${layer.offsetX})`);
            if (layer.offsetY !== undefined) transform.push(`translateY(${layer.offsetY})`);
            if (transform.length) media.style.transform = transform.join(' ');

            wrapper.appendChild(media);

            // Loading placeholder: shimmer tile plus optional glyph until the
            // first frame is available. A layer with no src stays in this state
            // (a "pending" slot you fill later with setFace).
            const loading = this.loadingOptions(layer);
            if (loading) {
                wrapper.classList.add('is-loading');
                const glyph = isVideo ? (loading.videoText ?? loading.text) : loading.text;
                if (glyph) {
                    const label = doc.createElement('div');
                    label.className = 'mediacube-loading-text';
                    label.textContent = glyph;
                    if (loading.style) label.style.cssText += loading.style;
                    wrapper.appendChild(label);
                }
                if (layer.src) {
                    const done = () => {
                        wrapper.classList.remove('is-loading');
                        const label = wrapper.querySelector(':scope > .mediacube-loading-text');
                        if (label) label.remove();
                    };
                    const fail = () => { wrapper.classList.remove('is-loading'); wrapper.classList.add('is-error'); };
                    media.addEventListener(isVideo ? 'loadeddata' : 'load', done, { once: true });
                    media.addEventListener('error', fail, { once: true });
                }
            }

            if (layer.src) {
                media.src = layer.src;
                if (loading) {
                    const ready = isVideo ? media.readyState >= 2 : (media.complete && media.naturalWidth > 0);
                    if (ready) {
                        wrapper.classList.remove('is-loading');
                        const label = wrapper.querySelector(':scope > .mediacube-loading-text');
                        if (label) label.remove();
                    }
                }
            }
            return { wrapper, media };
        }

        addMediaLayer(faceName, face, layer, isVideo) {
            const { wrapper, media } = this.createMediaNode(layer, isVideo);

            // Optional poster shown while the video is not playing.
            let fallbackWrapper = null;
            if (isVideo && layer.paused) {
                const poster = normalizeLayer(layer.paused);
                const fb = this.createMediaNode(poster, detectKind(poster) === 'video');
                fb.wrapper.style.display = 'none';
                face.appendChild(fb.wrapper);
                fallbackWrapper = fb.wrapper;
            }

            face.appendChild(wrapper);
            if (!isVideo || !layer.src) return;

            media.muted = true;
            media.playsInline = true;
            media.setAttribute('playsinline', '');
            media.setAttribute('muted', '');
            media.loop = false;
            media.preload = 'auto';

            const angleY = FACE_ANGLES_Y[faceName];
            if (angleY === undefined) {
                // top/bottom faces are never "in front", so they just loop quietly
                media.loop = true;
                media.autoplay = true;
                return;
            }

            const entry = {
                el: media, wrapper, fallbackWrapper, angleY, face: faceName,
                rawStart: layer.startTime ?? 0,
                rawEnd: layer.endTime ?? 0,
                start: 0,
                end: Infinity
            };
            if (fallbackWrapper) this.showPoster(entry, true);
            this.videoRegistry.push(entry);
            this.setupVideo(entry);
            // With waitForVideo the idle pass skips this face until the clip can
            // play; the moment it can, the cube turns onto it
            if (this.config.settings.waitForVideo) {
                if (media.readyState >= 3) this.videoReady(entry);
                else media.addEventListener('canplay', () => this.videoReady(entry), { once: true });
            }
        }

        // A video face became playable while the cube idled: plan the turn
        // onto it. Nothing happens while a drag or another clip is under way;
        // the ordinary idle pass picks the face up later in those cases.
        videoReady(v) {
            if (this.destroyed || this.isDragging || this.currentVideo || this.arrival) return;
            if (!this.config.settings.waitForVideo || !this.videoRegistry.includes(v)) return;
            // The shortest way onto the face, whichever direction that is: the
            // least motion, so a clip that loads at once barely moves the cube
            const delta = ((v.angleY - this.rotY) % 360 + 540) % 360 - 180;
            const arriveMs = Math.max(1, Number(this.config.settings.arriveMs) || 300);
            this.arrival = {
                v,
                startY: this.rotY,
                targetY: this.rotY + delta,
                start: performance.now(),
                duration: Math.max(150, arriveMs * Math.abs(delta) / 180)
            };
        }

        setupVideo(v) {
            const initTimeline = () => {
                let start = parseFloat(v.rawStart) || 0;
                let end = parseFloat(v.rawEnd) || 0;
                const dur = v.el.duration || 0;
                // negative values count back from the end of the clip
                if (start < 0 && dur > 0) start = Math.max(0, dur + start);
                if (end <= 0 && dur > 0) end = Math.max(0, dur + end);
                if (end <= 0) end = Infinity;
                v.start = start;
                v.end = end;
                v.el.currentTime = start;
            };

            if (v.el.readyState >= 1) initTimeline();
            else v.el.addEventListener('loadedmetadata', initTimeline, { once: true });

            v.el.addEventListener('timeupdate', () => {
                if (this.currentVideo !== v) return;
                if (v.el.currentTime >= v.end) this.finishVideo(v);
            });
            v.el.addEventListener('ended', () => {
                if (this.currentVideo === v) this.finishVideo(v);
            });
            // A clip that cannot load should not hold the cube still forever.
            v.el.addEventListener('error', () => {
                if (this.currentVideo === v) this.finishVideo(v);
            }, { once: true });
        }

        showPoster(v, show) {
            if (!v.fallbackWrapper) return;
            v.wrapper.style.display = show ? 'none' : '';
            v.fallbackWrapper.style.display = show ? '' : 'none';
        }

        playVideo(v) {
            this.currentVideo = v;
            // Keep the poster up until frames are actually being rendered, so a
            // slow download never leaves an empty face.
            if (v.fallbackWrapper) {
                if (v.el.readyState >= 3) this.showPoster(v, false);
                else v.el.addEventListener('playing', () => {
                    if (this.currentVideo === v) this.showPoster(v, false);
                }, { once: true });
            }
            const go = () => {
                if (this.destroyed || this.currentVideo !== v) return;
                this.seekAndPlay(v.el, v.start);
            };
            if (v.el.readyState >= 1) go();
            else v.el.addEventListener('loadedmetadata', go, { once: true });
        }

        finishVideo(v) {
            v.el.pause();
            this.showPoster(v, true);
            this.lastPlayedVideo = v;
            this.currentVideo = null;
        }

        seekAndPlay(video, time) {
            const safeTime = Math.max(0, time || 0);
            const tryPlay = () => video.play().catch(err => console.warn('MediaCube: video.play() rejected', err));
            video.addEventListener('seeked', tryPlay, { once: true });
            video.currentTime = safeTime;
            if (Math.abs(video.currentTime - safeTime) < 0.05) {
                video.removeEventListener('seeked', tryPlay);
                tryPlay();
            }
        }

        checkInitialVideo() {
            const v = this.videoRegistry.find(entry => entry.angleY === 0);
            if (!v) return;
            // waitForVideo: a front clip that cannot play yet does not hold the
            // cube; it idles and turns back onto the face once the clip can
            if (this.config.settings.waitForVideo && v.el.readyState < 3) return;
            this.rotY = 0;
            this.spinY = 0;
            this.lastPlayedVideo = v;
            this.playVideo(v);
        }

        // --- svg / card ---

        addSvgLayer(face, layer, source) {
            if (typeof source !== 'string' || !source) {
                console.warn('MediaCube: svg layer has no source', layer);
                return;
            }
            if (source.trim().startsWith('<svg')) {
                this.processSvg(source, layer, face);
                return;
            }
            MediaCube.loadSvg(source)
                .then(text => {
                    if (!this.destroyed && face.isConnected) this.processSvg(text, layer, face);
                })
                .catch(err => console.error(`MediaCube: could not load SVG "${source}"`, err));
        }

        static loadSvg(url) {
            if (!MediaCube._svgCache.has(url)) {
                const promise = fetch(url).then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.text();
                });
                promise.catch(() => MediaCube._svgCache.delete(url));
                MediaCube._svgCache.set(url, promise);
            }
            return MediaCube._svgCache.get(url);
        }

        processSvg(svgText, layer, face) {
            const doc = this.container.ownerDocument;
            const wrap = doc.createElement('div');
            wrap.innerHTML = svgText.trim();
            const baseSvg = wrap.querySelector('svg');
            if (!baseSvg) {
                console.warn('MediaCube: svg source did not contain an <svg> element', layer);
                return;
            }

            if (layer.style) baseSvg.style.cssText += layer.style;
            if (layer.zoom !== undefined) {
                const current = baseSvg.style.transform || '';
                baseSvg.style.transform = `${current} scale(${layer.zoom})`.trim();
            }
            baseSvg.setAttribute('data-layout', layer.layout || 'default');
            if (layer.tier) baseSvg.setAttribute('data-tier', layer.tier);

            if (layer.text && typeof layer.text === 'object') {
                for (const [className, value] of Object.entries(layer.text)) {
                    baseSvg.querySelectorAll(`.${className}`).forEach(node => { node.textContent = value; });
                }
            } else if (typeof layer.text === 'string') {
                const node = baseSvg.querySelector('.tpl-main') || baseSvg.querySelector('text');
                if (node) node.textContent = layer.text;
            }

            if (layer.colorCube) baseSvg.style.setProperty('--color-cube', layer.colorCube);
            if (layer.colorFrame) baseSvg.style.setProperty('--color-frame', layer.colorFrame);
            if (layer.colorText) {
                baseSvg.style.setProperty('--color-text', layer.colorText);
                baseSvg.querySelectorAll('text').forEach(t => t.setAttribute('fill', 'var(--color-text, currentColor)'));
            }

            baseSvg.classList.add('svg-base-layer');
            face.appendChild(baseSvg);

            // Extruded text: clone the svg N times, each a little further off the face.
            const thickness = layer.thickness ?? this.config.settings.textThickness;
            const elevation = layer.elevation ?? this.config.settings.textElevation;

            for (let i = 0; i <= thickness; i++) {
                const popWrap = doc.createElement('div');
                popWrap.className = 'svg-pop-wrapper';
                popWrap.style.transform = `translate3d(0, 0, calc(${elevation + i}px * var(--cube-scale, 1)))`;

                const popSvg = baseSvg.cloneNode(true);
                popSvg.classList.remove('svg-base-layer');
                popSvg.classList.add('svg-pop-layer');

                if (i > 0 && i < thickness) {
                    popSvg.style.color = DARKEN;
                    popSvg.style.setProperty('--color-text', 'color-mix(in srgb, var(--color-text, #ffffff) 30%, #000000)');
                    popSvg.style.setProperty('--color-cube', 'color-mix(in srgb, var(--color-cube, #007A33) 30%, #000000)');
                    popSvg.style.setProperty('--color-frame', 'color-mix(in srgb, var(--color-frame, #007A33) 30%, #000000)');
                }
                popWrap.appendChild(popSvg);
                face.appendChild(popWrap);
            }
        }

        // --- extruded text / emoji ---

        buildTextStack(text, style, thickness, zFor, sliceClass) {
            const doc = this.container.ownerDocument;
            const slices = [];
            for (let i = 0; i <= thickness; i++) {
                const slice = doc.createElement('div');
                slice.className = sliceClass;
                slice.style.transform = `translate3d(0, 0, calc(${zFor(i)}px * var(--cube-scale, 1)))`;
                // user style goes on the slice so that "currentColor" below refers to it
                if (style) slice.style.cssText += style;

                const content = doc.createElement('div');
                content.textContent = text;
                if (i > 0 && i < thickness) {
                    content.style.color = DARKEN;
                    content.style.textShadow = 'none';
                }
                slice.appendChild(content);
                slices.push(slice);
            }
            return slices;
        }

        addTextLayer(face, layer) {
            const s = this.config.settings;
            const thickness = layer.thickness ?? s.textThickness;
            const elevation = layer.elevation ?? s.textElevation;
            const holder = this.container.ownerDocument.createElement('div');
            holder.className = 'mediacube-text-layer';
            this.buildTextStack(layer.text, layer.style, thickness, i => elevation + i, 'mediacube-text-face')
                .forEach(slice => holder.appendChild(slice));
            face.appendChild(holder);
        }

        buildCore() {
            const core = this.config.core;
            if (!core || !core.text) return;
            const thickness = core.thickness ?? this.config.settings.textThickness;
            const startZ = -Math.floor(thickness / 2);
            this.buildTextStack(core.text, core.style, thickness, i => startZ + i, 'mediacube-core-face')
                .forEach(slice => this.coreEl.appendChild(slice));
        }

        // ------------------------------------------------------------------
        // Interaction and animation
        // ------------------------------------------------------------------

        setupInteraction() {
            const c = this.container;
            const on = (type, fn) => { c.addEventListener(type, fn); this._listeners.push([type, fn]); };

            on('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                this.isDragging = true;
                this.prevX = e.clientX;
                this.prevY = e.clientY;
                this.prevTime = performance.now();
                this.velX = 0;
                try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                e.preventDefault();
            });

            on('pointermove', (e) => {
                if (!this.isDragging) return;
                const now = performance.now();
                const dt = now - this.prevTime;
                if (dt === 0) return;

                const dx = e.clientX - this.prevX;
                const dy = e.clientY - this.prevY;

                const instantV = (dx / dt) * 8.0;
                this.velX = this.velX * 0.7 + instantV * 0.3;

                this.rotY += dx * 0.5;
                this.rotX -= dy * 0.5;
                this.rotX = Math.max(-90, Math.min(90, this.rotX));
                this.applyTransform();

                this.prevX = e.clientX;
                this.prevY = e.clientY;
                this.prevTime = now;
            });

            const release = (e) => {
                if (!this.isDragging) return;
                this.isDragging = false;
                if (performance.now() - this.prevTime > 70) this.velX = 0;
                this.spinY = this.velX;
                if (e.pointerId !== undefined && c.hasPointerCapture && c.hasPointerCapture(e.pointerId)) {
                    c.releasePointerCapture(e.pointerId);
                }
            };
            on('pointerup', release);
            on('pointercancel', release);
            on('pointerleave', release);
        }

        applyTransform() {
            this.cubeEl.style.transform = `rotateX(${this.rotX}deg) rotateY(${this.rotY}deg)`;
            const core = this.config.core;
            if (core) {
                const factor = core.spinFactor ?? -2;
                const offset = core.spinOffset ?? -90;
                this.coreEl.style.transform = `rotateX(${-this.rotX}deg) rotateY(${this.rotY * factor + offset}deg)`;
            }
        }

        // Snap to a face. If that face has a video it starts playing.
        showFace(name, { play = true } = {}) {
            const angle = FACE_ANGLES_Y[name];
            if (angle === undefined) return this;
            this.rotY = angle;
            this.rotX = 0;
            this.spinY = 0;
            this.arrival = null;
            if (this.currentVideo) {
                this.currentVideo.el.pause();
                this.showPoster(this.currentVideo, true);
                this.currentVideo = null;
            }
            const v = this.videoRegistry.find(entry => entry.face === name);
            if (v && play) {
                this.lastPlayedVideo = v;
                this.playVideo(v);
            } else {
                this.lastPlayedVideo = null;
            }
            this.applyTransform();
            return this;
        }

        startRenderLoop() {
            const FRICTION = 0.95;
            const RETURN_SMOOTH = 0.015;

            const render = () => {
                if (this.destroyed) return;
                const baseSpin = Number(this.config.settings.idleSpinSpeed) || 0;

                const isSpinning = this.isDragging || Math.abs(this.spinY) > 0.05 || !this.currentVideo;
                if (isSpinning !== this.wasSpinning) {
                    this.cubeEl.classList.toggle('is-spinning', isSpinning);
                    this.wasSpinning = isSpinning;
                }

                if (this.isDragging) this.arrival = null;

                if (this.arrival && !this.isDragging) {
                    // Ease from the idle turn into the face and stop dead on it;
                    // the clip starts the frame the cube lands
                    const a = this.arrival;
                    const t = Math.min(1, (performance.now() - a.start) / a.duration);
                    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                    this.rotY = a.startY + (a.targetY - a.startY) * eased;
                    this.rotX += (0 - this.rotX) * 0.2;
                    if (t >= 1) {
                        this.rotY = a.targetY;
                        this.rotX = 0;
                        this.spinY = 0;
                        this.arrival = null;
                        if (!this.currentVideo && this.videoRegistry.includes(a.v)) this.playVideo(a.v);
                    }
                    this.applyTransform();
                    this.rafId = requestAnimationFrame(render);
                    return;
                }

                if (!this.isDragging) {
                    const targetSpin = this.currentVideo ? 0 : baseSpin;
                    const diff = this.spinY - targetSpin;

                    if (Math.abs(diff) > 0.01) {
                        this.spinY = targetSpin + diff * FRICTION;
                        this.rotY += this.spinY;
                    } else {
                        this.spinY = targetSpin;
                        const prevY = this.rotY;
                        this.rotY += this.spinY;
                        const currY = this.rotY;

                        // While idling past a face that has a video, snap to it and play.
                        if (!this.currentVideo && Math.abs(this.rotX) < 15 && this.spinY !== 0) {
                            let snapY = currY;
                            let videoToPlay = null;

                            for (const v of this.videoRegistry) {
                                // Not playable yet: keep idling; videoReady brings the cube back
                                if (this.config.settings.waitForVideo && v.el.readyState < 3) continue;
                                const targetMod = (v.angleY % 360 + 360) % 360;
                                const prevMod = (prevY % 360 + 360) % 360;

                                let dist;
                                if (this.spinY < 0) {
                                    dist = prevMod >= targetMod ? prevMod - targetMod : prevMod + 360 - targetMod;
                                } else {
                                    dist = prevMod <= targetMod ? targetMod - prevMod : targetMod + 360 - prevMod;
                                }

                                if (v === this.lastPlayedVideo) {
                                    if (dist > 15 && dist < 345) this.lastPlayedVideo = null;
                                    continue;
                                }

                                const T = this.spinY < 0 ? prevY - dist : prevY + dist;
                                if ((this.spinY < 0 && prevY >= T && currY <= T) ||
                                    (this.spinY > 0 && prevY <= T && currY >= T)) {
                                    snapY = T;
                                    videoToPlay = v;
                                    break;
                                }
                            }

                            if (videoToPlay) {
                                this.rotY = snapY;
                                this.spinY = 0;
                                this.rotX = 0;
                                this.playVideo(videoToPlay);
                            }
                        }
                    }

                    this.rotX += (0 - this.rotX) * RETURN_SMOOTH;
                    this.applyTransform();
                }
                this.rafId = requestAnimationFrame(render);
            };
            this.rafId = requestAnimationFrame(render);
        }

        // ------------------------------------------------------------------
        // Teardown
        // ------------------------------------------------------------------

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            cancelAnimationFrame(this.rafId);
            if (this.resizeObserver) this.resizeObserver.disconnect();
            this._listeners.forEach(([type, fn]) => this.container.removeEventListener(type, fn));
            this._listeners = [];

            this.videoRegistry.forEach(v => {
                v.el.pause();
                v.el.removeAttribute('src');
                v.el.load();
            });
            this.videoRegistry = [];
            this.currentVideo = null;
            this.lastPlayedVideo = null;

            if (this.scene) this.scene.remove();
            this.container.classList.remove('mediacube-container');
            [
                '--cube-scale', '--cube-size', '--face-overlap', '--translate-z', '--perspective',
                '--glow-blur', '--glow-spread', '--color-cube-glow', '--spin-opacity', '--face-fill',
                '--glow-pulse-intensity', '--glow-pulse-spread', '--glow-animation',
                '--shine-opacity', '--shine-angle', '--shine-animation',
                '--loading-fill', '--loading-shimmer', '--loading-text-color'
            ].forEach(prop => this.container.style.removeProperty(prop));
        }
    }

    // ---- src/media-cube-element.js ----
    // <media-cube> custom element. Light DOM (no shadow root) so the single
    // injected stylesheet applies. Give the element a width and height in CSS.
    //
    //   <media-cube config='{"side_1": "clip.mp4"}'></media-cube>
    //   document.querySelector('media-cube').config = { ... };   // property form
    //   element.cube  -> the underlying MediaCube instance


    // Allow the module to load in non-DOM environments (Node, SSR); the element
    // is only registered where customElements exists.
    const BaseElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

    class MediaCubeElement extends BaseElement {
        static get observedAttributes() { return ['config']; }

        constructor() {
            super();
            this._config = null;
            this._cube = null;
        }

        get config() { return this._config; }
        set config(value) {
            this._config = value;
            this._render();
        }

        get cube() { return this._cube; }

        connectedCallback() {
            this._render();
        }

        disconnectedCallback() {
            if (this._cube) this._cube.destroy();
            this._cube = null;
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (name !== 'config') return;
            if (newValue === null || newValue === '') {
                this._config = null;
            } else {
                try {
                    this._config = JSON.parse(newValue);
                } catch (err) {
                    console.error('<media-cube>: config attribute is not valid JSON', err);
                    return;
                }
            }
            this._render();
        }

        _render() {
            if (!this.isConnected) return;
            if (this._cube) this._cube.destroy();
            this._cube = new MediaCube(this, this._config || {});
        }
    }

    function defineMediaCubeElement(tagName = 'media-cube') {
        if (typeof customElements === 'undefined') return false;
        if (customElements.get(tagName)) return false;
        customElements.define(tagName, MediaCubeElement);
        return true;
    }

    defineMediaCubeElement();


    MediaCube.MediaCubeElement = MediaCubeElement;
    MediaCube.defineMediaCubeElement = defineMediaCubeElement;
    return {
        MediaCube: MediaCube,
        MediaCubeElement: MediaCubeElement,
        defineMediaCubeElement: defineMediaCubeElement,
        MEDIACUBE_CSS: MEDIACUBE_CSS,
        CARD_SVG: CARD_SVG,
        FACE_NAMES: FACE_NAMES,
        FACE_ANGLES_Y: FACE_ANGLES_Y,
        default: MediaCube
    };
}));
