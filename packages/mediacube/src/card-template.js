// Built-in card template (the former master-card.svg), inlined so nothing has
// to be fetched at runtime. A layer with type "card" (or one that has a
// tier/layout but no src) uses this template.
//
// Switching:
//   data-layout  default | top-emoji | center-emoji | center-four-lines | player | score
//   data-tier    common | rare | fandom | legendary | ultimate
// Text slots: any element with a .tpl-* class can be filled through layer.text.
// Colors:     --color-cube (tier lines), --color-frame (inner border), --color-text.

export const CARD_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="mediacube-card">
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
