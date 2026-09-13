// <media-cube> custom element. Light DOM (no shadow root) so the single
// injected stylesheet applies. Give the element a width and height in CSS.
//
//   <media-cube config='{"side_1": "clip.mp4"}'></media-cube>
//   document.querySelector('media-cube').config = { ... };   // property form
//   element.cube  -> the underlying MediaCube instance

import MediaCube from './mediacube.js';

// Allow the module to load in non-DOM environments (Node, SSR); the element
// is only registered where customElements exists.
const BaseElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class MediaCubeElement extends BaseElement {
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

export function defineMediaCubeElement(tagName = 'media-cube') {
    if (typeof customElements === 'undefined') return false;
    if (customElements.get(tagName)) return false;
    customElements.define(tagName, MediaCubeElement);
    return true;
}

defineMediaCubeElement();
