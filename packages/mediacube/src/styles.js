// MediaCube stylesheet, shipped as a string so the library has no runtime
// path dependency. MediaCube.injectStyles() drops it into <head> once.

export const MEDIACUBE_CSS = `
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
