import { Link } from "react-router-dom";
import { toQuery } from "../utils/query";

const fmt = (n) => Number(n).toLocaleString();
const pct = (x) => (x >= 0.1 ? `${Math.round(x * 100)}%` : x >= 0.01 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toFixed(2)}%`);
const times = (x) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);
const approx = (x) => (x >= 10 ? fmt(Math.round(x)) : x >= 1 ? x.toFixed(1) : x.toFixed(2));

// Where a lean leads in the account table: the facet the dimension maps to
const FACET = { team: "team", player: "player", tier: "tier", parallel: null, series: "series", set: "set", badge: "badge", league: "league" };

/**
 * Two bars in moments on one scale: what the collection holds (filled)
 * against what an average collection its size would hold (hollow).
 * The longer of the two fills the width, so the gap between them is the
 * lean itself. Each bar carries its label and its count as text, so the
 * pair reads without colour.
 */
function BarPair({ you, expected, youText, expectedText }) {
  const max = Math.max(you, expected, 1e-9);
  const w = (v) => `${Math.max(1.5, (v / max) * 100)}%`;
  return (
    <div className="lean-bars">
      <span className="lean-bar-label lean-bar-label-you">Yours</span>
      <span className="lean-bar-track"><span className="lean-bar lean-bar-you" style={{ width: w(you) }} /></span>
      <span className="lean-bar-num font-mono">{youText}</span>
      <span className="lean-bar-label">Average</span>
      <span className="lean-bar-track"><span className="lean-bar lean-bar-expected" style={{ width: w(expected) }} /></span>
      <span className="lean-bar-num lean-bar-num-expected font-mono">{expectedText}</span>
    </div>
  );
}

/**
 * The account's collector profile on the home page: one lead line that
 * says what the panel compares, then a tile per lean, strongest first.
 * Each tile shows two counts in moments: what the collection holds of
 * the value against what an average collection its size would hold,
 * Top Shot's mix (the supply as Settings shows it, remaining by
 * default) scaled to the collection's size, and the multiplier between
 * the two (services/collector.profile: average = owned / lift). Serial tiles compare copies held against the copies
 * chance would give, the same frame. Percentages stay off the tiles
 * (the multiple reads, shares of two different pies do not).
 * Nothing renders when no lean clears the bar, so a flat collection
 * gets no panel rather than an empty one.
 */
export function CollectorProfile({ profile, address }) {
  if (!profile) return null;
  const rows = profile.leans.filter((d) => d.lean);
  const { serialLean, lowSerials } = profile;
  const serialTiles = [];
  if (serialLean && serialLean.lift >= 2) {
    serialTiles.push({
      key: "serial", label: "Serial", value: `#${serialLean.serial}`, lift: serialLean.lift,
      you: serialLean.owned, expected: serialLean.expected,
      youText: `${fmt(serialLean.owned)} ${serialLean.owned === 1 ? "copy" : "copies"}`, expectedText: approx(serialLean.expected),
      foot: `Serial #${serialLean.serial}, drawn ${times(serialLean.lift)} more often than chance`,
      title: `${fmt(serialLean.owned)} of your moments carry serial #${serialLean.serial}. A random draw from the same runs would give about ${approx(serialLean.expected)}.`
    });
  }
  if (lowSerials && lowSerials.lift >= 1.5) {
    serialTiles.push({
      key: "low", label: "Low serials", value: "#1 to #10", lift: lowSerials.lift,
      you: lowSerials.owned, expected: lowSerials.expected,
      youText: `${fmt(lowSerials.owned)} ${lowSerials.owned === 1 ? "copy" : "copies"}`, expectedText: approx(lowSerials.expected),
      foot: `Serials ten and under, held ${times(lowSerials.lift)} more often than chance`,
      title: `${fmt(lowSerials.owned)} of your moments are numbered ten or below. A random draw from the same runs would give about ${approx(lowSerials.expected)}.`
    });
  }
  if (rows.length === 0 && serialTiles.length === 0) return null;

  const sentence = `Where your collection leans, against an average collection of ${fmt(profile.totalOwned)} moments.`;

  const linkFor = (d) => {
    const facet = FACET[d.key];
    if (!facet || !address) return null;
    const params = new URLSearchParams();
    params.set(facet, d.lean.value);
    return `/account/${address}?${toQuery(params)}`;
  };

  const tile = ({ key, label, value, lift, liftCap, bars, foot, title, to }) => {
    const body = (
      <>
        <div className="lean-tile-head">
          <span className="lean-tile-dim">{label}</span>
          <span className="lean-tile-lift font-mono">{times(lift)}{liftCap && <span className="lean-tile-lift-cap">{liftCap}</span>}</span>
        </div>
        <div className="lean-tile-value">{value}</div>
        {bars}
        <div className="lean-tile-foot">{foot}</div>
      </>
    );
    return to
      ? <Link key={key} to={to} className="lean-tile lean-tile-link" title={title}>{body}</Link>
      : <div key={key} className="lean-tile" title={title}>{body}</div>;
  };

  // Strongest lean first, whichever the dimension
  const tiles = [
    ...rows.map((d) => {
      const l = d.lean;
      // What an average collection this size holds of the value: the
      // field's share of the collection's total
      const expected = l.owned / l.lift;
      return {
        key: d.key, label: d.label, value: l.value, lift: l.lift, to: linkFor(d),
        bars: <BarPair you={l.owned} expected={expected} youText={fmt(l.owned)} expectedText={approx(expected)} />,
        foot: `${pct(l.hold)} of the ${fmt(l.supply)} moments`,
        title: `You hold ${fmt(l.owned)} ${l.value} moments. An average collection of ${fmt(profile.totalOwned)} holds ${approx(expected)}: ${times(l.lift)} the average. That is ${pct(l.hold)} of the ${fmt(l.supply)} moments.`
      };
    }),
    ...serialTiles.map((t) => ({
      ...t,
      liftCap: "vs chance",
      bars: <BarPair you={t.you} expected={t.expected} youText={t.youText} expectedText={t.expectedText} />
    }))
  ].sort((a, b) => b.lift - a.lift);

  return (
    <div className="glass-panel collector-profile">
      <div className="collector-profile-head">
        <h3 className="collector-profile-title">Your collection</h3>
        {address && <span className="collector-profile-address font-mono">{address}</span>}
      </div>
      <p className="collector-profile-lead">{sentence}</p>
      <div className="lean-grid">
        {tiles.map(tile)}
      </div>
    </div>
  );
}
