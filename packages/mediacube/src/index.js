// Package entry point (ES module).
//
//   import MediaCube from 'mediacube';
//   import { MediaCube, MediaCubeElement, CARD_SVG, MEDIACUBE_CSS } from 'mediacube';
//
// Importing this module also registers the <media-cube> custom element.

import MediaCube, { FACE_NAMES, FACE_ANGLES_Y } from './mediacube.js';
import { MediaCubeElement, defineMediaCubeElement } from './media-cube-element.js';
import { MEDIACUBE_CSS } from './styles.js';
import { CARD_SVG } from './card-template.js';

export { MediaCube, MediaCubeElement, defineMediaCubeElement, MEDIACUBE_CSS, CARD_SVG, FACE_NAMES, FACE_ANGLES_Y };
export default MediaCube;
