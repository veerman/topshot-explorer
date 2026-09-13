# MediaCube

An interactive 3D "moment cube" for the web, in the spirit of the NBA Top Shot
display cube. Pure CSS 3D and vanilla JS, no dependencies, no runtime assets.
Each of the six faces holds a stack of layers: video with a poster frame and
in/out points, images, SVG cards (a built-in template or your own), and
extruded 3D text or emoji. A 3D object floats in the middle of the cube.

Drag to spin. When the cube idles past a face that has a video, it snaps to it
and plays the clip, then resumes spinning. With `waitForVideo` it keeps spinning
until the clip can play and then turns onto the face.

## Install

Everything ships in one file. Pick one:

```html
<!-- Classic script: exposes window.MediaCube and registers <media-cube> -->
<script src="dist/mediacube.umd.js"></script>
```

```js
// ES module (bundlers, or <script type="module">)
import MediaCube from './dist/mediacube.esm.js';
```

```js
// From npm after publishing, or via a local path dependency
import MediaCube from 'mediacube';
```

Styles are injected into `<head>` automatically the first time a cube is
created. The card template SVG is inlined too, so nothing else needs to be
copied alongside the script.

## Quick start

```html
<div id="cube" style="width: 500px; height: 500px; background: #000"></div>
<script src="dist/mediacube.umd.js"></script>
<script>
  new MediaCube('cube', {
    core: { text: '🍀' },
    side_1: [
      { src: 'clip.mp4', style: 'width: 78%; height: 78%;', startTime: 1, endTime: -2,
        paused: { src: 'poster.jpg', style: 'width: 78%; height: 78%;' } },
      { tier: 'rare', layout: 'player', text: { 'tpl-badge': '▶ 14s', 'tpl-name': 'BROWN' } }
    ],
    side_2: { tier: 'rare', layout: 'center-emoji',
              text: { 'tpl-line1': 'HANDLES', 'tpl-emoji': '🍀', 'tpl-line3': "DEC 25 '19" } },
    side_3: { tier: 'rare', layout: 'score',
              text: { 'tpl-home-score': '102', 'tpl-away-score': '118',
                      'tpl-home-team': 'TOR', 'tpl-away-team': 'BOS' } },
    side_4: [
      { type: 'text', text: '7', style: 'color: #3ddc84; font-size: 60%; font-weight: 900;' },
      { tier: 'rare' }
    ]
  });
</script>
```

The cube sizes itself to the container (55% of the shorter side, so it never
clips while rotating) and follows the container through a ResizeObserver.

### Web component

```html
<media-cube style="width: 400px; height: 400px"
            config='{"core": {"text": "🔥"}, "side_1": "clip.mp4"}'></media-cube>
<script>
  // or set it as a property
  document.querySelector('media-cube').config = { side_1: 'clip.mp4' };
  document.querySelector('media-cube').cube.showFace('side_3');
</script>
```

The element is registered when the script loads. It uses light DOM so the
shared stylesheet applies. It destroys its cube when removed from the page.

## Config

```js
{
  settings: { ... },     // see Settings
  core: { ... } | null,  // the floating 3D object in the middle, null to omit
  cardSvg: '<svg ...>' | 'cards/my-card.svg',   // optional custom card template
  top: layers, bottom: layers,
  side_1: layers, side_2: layers, side_3: layers, side_4: layers
}
```

`layers` is a single layer or an array of layers. Layers stack in order, first
at the back. A bare string is shorthand for `{ src: string }`.

Faces: `side_1` faces the viewer at rest, then `side_2`, `side_3`, `side_4`
going around, plus `top` and `bottom`.

### Layers

The layer kind is inferred from `src` (video by extension, `.svg` or inline
`<svg` markup, otherwise image), from `svg`, or from the presence of card or
text fields. Set `type` explicitly when the URL has no useful extension:
`'video' | 'image' | 'svg' | 'card' | 'text'`.

Common fields for image and video layers:

| field | meaning |
|---|---|
| `src` | URL |
| `style` | CSS applied to the layer box, e.g. `'width: 78%; height: 78%;'` |
| `zoom` | scale factor applied to the media inside its box |
| `offsetX`, `offsetY` | CSS lengths to pan the media |

Video only:

| field | meaning |
|---|---|
| `startTime` | seconds in; negative counts from the end |
| `endTime` | seconds out; zero or negative counts from the end |
| `paused` | a layer (image or video) shown whenever the clip is not playing |

Videos are muted and inline. A video on `side_1` plays on load. Videos on
`top` or `bottom` just loop.

While an image or video downloads, its layer shows a dark shimmering tile so
the face is never see-through. The tile fades out on the first frame. No
symbol is drawn by default; set `videoText: '▶'` or `text` in the setting
below if you want one. If the video has a `paused` poster, the
poster stays up until the clip is actually playing. Control it with the
`loadingPlaceholder` setting, or per layer:

| field | meaning |
|---|---|
| `loading: false` | no placeholder for this layer |
| `loading: '⏳'` | custom glyph |
| `loading: { text, style }` | glyph plus extra CSS for it |

A layer with a `type` but no `src` (for example `{ type: 'video' }`) is a
pending slot: it shows the placeholder until you replace the face with
`setFace()`, which is handy when the media URL arrives later from an API.

SVG and card layers:

| field | meaning |
|---|---|
| `type: 'card'` | use the built-in template (implied when `tier`, `layout`, or a `text` object is present and there is no `src`) |
| `src` / `svg` | a `.svg` URL or inline `<svg>` markup for your own template |
| `layout` | `default`, `top-emoji`, `center-emoji`, `center-four-lines`, `player`, `score` |
| `tier` | `common`, `rare`, `fandom`, `legendary`, `ultimate` (draws the corner brackets) |
| `text` | string (fills `.tpl-main`) or `{ 'tpl-xxx': 'value' }` map filling any `.tpl-*` node |
| `colorCube`, `colorFrame`, `colorText` | override the template's CSS variables |
| `thickness`, `elevation` | per-layer override of the 3D text settings |

The template's `<text>` nodes are rendered as a stack of Z-offset copies to
look extruded; everything else in the SVG is drawn flat on the face.

Text layers:

```js
{ type: 'text', text: '7', style: 'color: #3ddc84; font-size: 60%; font-weight: 900;' }
```

`font-size` percentages are relative to the cube edge length, so `60%` is
always the same proportion of the face regardless of container size.

### Settings

| setting | default | meaning |
|---|---|---|
| `cubeGlowSize` | `'16px'` | blur of the neon edge glow, scaled with cube size |
| `colorCubeGlow` | `'#007A33'` | glow color |
| `glowSpread` | `'0px'` | glow spread |
| `faceOverlap` | `'0.5px'` | pulls faces inward to hide seams |
| `faceFill` | `'transparent'` | face background, e.g. `'rgba(0,0,0,0.5)'` for smoked glass |
| `spinOpacity` | `'0.85'` | media opacity while the cube moves |
| `textThickness` | `8` | number of Z slices for extruded text |
| `textElevation` | `20` | how far face text floats above the face (px at a 500px cube) |
| `idleSpinSpeed` | `-1` | degrees per frame while no video plays, `0` for still |
| `waitForVideo` | `false` | keep idling past a video face until its clip can play, then turn the shortest way onto it (either direction, easing in and out) and play; the spin doubles as the loading indicator. Off, the cube snaps to the face at once and holds the placeholder there |
| `arriveMs` | `300` | how long that turn takes for a half revolution; shorter distances take proportionally less (never under 150ms) |
| `livingGlow` | `false` | `true` or `{ intensity: 1.5, spread: 12, speed: 1.5 }` for a pulsing glow |
| `shine` | `false` | `true` or `{ opacity: 0.5, angle: 45, speed: 3 }` for a sweeping highlight |
| `loadingPlaceholder` | `true` | `false`, or `{ text, videoText, style, fill, shimmer, textColor }` to restyle the tile shown while media loads. `text` and `videoText` are empty by default; `shimmer: false` disables the sweep |

Core: `{ text, style, thickness, spinFactor, spinOffset }`. The core
counter-rotates relative to the cube (`spinFactor: -2` by default).

## Methods

| method | meaning |
|---|---|
| `update(settings)` | change any settings at runtime |
| `setFace(name, layers)` | replace one face's layers |
| `clearFace(name)` | empty a face |
| `showFace(name, { play })` | snap to a face, playing its video unless `play: false` |
| `destroy()` | stop the render loop, release videos, remove the DOM |

Static: `MediaCube.injectStyles(document)`, `MediaCube.CARD_SVG`,
`MediaCube.CSS`, `MediaCube.FACES`.

## Custom card templates

Start from `src/card-template.js`. The rules:

- Layout groups carry `layout-layer layout-<name>` and are switched by
  `data-layout` on the root `<svg>`.
- Tier groups carry `tier-layer tier-<name>` and are switched by `data-tier`.
- Text slots are any element with a `tpl-*` class.
- Use `var(--color-cube)`, `var(--color-frame)`, and `var(--color-text)` so
  the color overrides and the darker extrusion slices work.
- Keep selectors prefixed with a class on the root `<svg>`, because inline
  SVG `<style>` blocks are global.

Pass it as `cardSvg` (inline string or URL) on the config, or per layer via
`src` / `svg`.

## Development

```
node build.js        # writes dist/
npm run check        # build plus a syntax check of both bundles
```

The demo in `demo/index.html` loads `dist/mediacube.umd.js` and works straight
from the file system, or serve the folder with any static server.

## Repository layout

```
src/                 editable source (ES modules)
  styles.js          stylesheet as a string
  card-template.js   built-in card SVG as a string
  mediacube.js       the MediaCube class
  media-cube-element.js   <media-cube> custom element
  index.js           entry point
dist/                built single-file bundles
  mediacube.esm.js   ES module
  mediacube.umd.js   classic <script> / AMD (window.MediaCube)
  mediacube.umd.cjs  same UMD content, named for Node require()
demo/                test page with sample media
build.js             dependency-free bundler
```
