import { useState } from "react";
import { isRemainingSupply } from "../services/supply.service";

const fmtDefault = (v) => Number(v).toLocaleString();

/**
 * A count of moments that swaps between its two truths: the remaining
 * supply (minted minus burned) and the original mint count. Whichever
 * Settings puts first is shown; the other appears while the pointer is
 * over it (or over the cell or card holding it), and on touch a tap
 * toggles. Both numbers are laid on top of each other and the wider one
 * sets the width, so nothing shifts when they swap. A labelled figure
 * pairs it with SupplyWord below, whose label swaps in step ("Moments
 * Remaining" to "Moments Minted"), so the change never relies on the
 * reader noticing digits move; nothing is ever added beside the number
 * itself. With nothing burned there is nothing to swap and the count
 * renders plain.
 *
 * remaining / minted  the two numbers; or `shown` / `other` when the
 *                     caller already summed them per the setting
 * format              how to print one (default: locale digits)
 * title               hover text; false for none (a wrapping cell has its own)
 */
export function Supply({ remaining, minted, shown, other, format = fmtDefault, className = "", title }) {
  const [flipped, setFlipped] = useState(false);
  const remainingFirst = isRemainingSupply();
  const bySetting = shown !== undefined;
  const r = Number(bySetting ? (remainingFirst ? shown : other) : remaining) || 0;
  const m = Number(bySetting ? (remainingFirst ? other : shown) : minted) || 0;
  const first = remainingFirst ? r : m;
  const second = remainingFirst ? m : r;
  if (r === m) {
    return <span className={className || undefined}>{format(first)}</span>;
  }
  const hint = title === false ? undefined : (title || `${m.toLocaleString()} minted, ${Math.max(0, m - r).toLocaleString()} burned, ${r.toLocaleString()} remaining`);
  // Touch has no hover: a tap flips and a second tap flips back. With a
  // pointer, hover does the job and a click is left to the link around it
  const onClick = () => {
    if (window.matchMedia && window.matchMedia("(hover: none)").matches) setFlipped((f) => !f);
  };
  return (
    <span className={`supply${flipped ? " is-flipped" : ""}${className ? ` ${className}` : ""}`} title={hint} onClick={onClick}>
      <span className="supply-a">{format(first)}</span>
      <span className="supply-b" aria-hidden="true">{format(second)}</span>
    </span>
  );
}

/**
 * The label of a swapping figure: one word while the number shows its
 * first value, the other while it swaps. The two are laid over each other
 * like the numbers, so the label keeps its place and its centring.
 */
export function SupplyWord({ remaining, minted, className = "" }) {
  const remainingFirst = isRemainingSupply();
  return (
    <span className={`supply-word${className ? ` ${className}` : ""}`}>
      <span className="supply-word-a">{remainingFirst ? remaining : minted}</span>
      <span className="supply-word-b" aria-hidden="true">{remainingFirst ? minted : remaining}</span>
    </span>
  );
}
