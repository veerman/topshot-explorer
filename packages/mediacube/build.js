// Zero-dependency build: concatenates src/ into
//   dist/mediacube.esm.js  (ES module, for bundlers and <script type="module">)
//   dist/mediacube.umd.js  (classic <script>, CommonJS, AMD; exposes window.MediaCube)
//
// Run with: node build.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Order matters: each file may only reference the ones before it.
const ORDER = ['styles.js', 'card-template.js', 'mediacube.js', 'media-cube-element.js'];

function stripModuleSyntax(source) {
    return source
        .replace(/^import\s[^;]*;\s*$/gm, '')
        .replace(/^export\s+default\s+class\s/gm, 'class ')
        .replace(/^export\s+(const|let|var|class|function)\s/gm, '$1 ')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
}

const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License | ${pkg.homepage || ''} */\n`;

const body = ORDER
    .map(file => `// ---- src/${file} ----\n${stripModuleSyntax(readFileSync(join(root, 'src', file), 'utf8')).trim()}\n`)
    .join('\n');

const esm = `${banner}${body}
export { MediaCube, MediaCubeElement, defineMediaCubeElement, MEDIACUBE_CSS, CARD_SVG, FACE_NAMES, FACE_ANGLES_Y };
export default MediaCube;
`;

const umd = `${banner}(function (root, factory) {
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

${body.split('\n').map(line => (line ? '    ' + line : line)).join('\n')}

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
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'mediacube.esm.js'), esm);
writeFileSync(join(root, 'dist', 'mediacube.umd.js'), umd);
// Same UMD content under a .cjs name so Node's require() treats it as CommonJS
// (the package is "type": "module", so a .js file would be parsed as ESM).
writeFileSync(join(root, 'dist', 'mediacube.umd.cjs'), umd);

console.log(`built dist/mediacube.esm.js (${esm.length} bytes), dist/mediacube.umd.js and dist/mediacube.umd.cjs (${umd.length} bytes)`);
