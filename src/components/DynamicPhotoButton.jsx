import { useState } from "react";
import { reconstructPlayer } from "../services/ipfs.generate";

// One rebuild at a time across every row, not per button: heroes are
// multi-MB fetches, and this preserves the old page-level genBusy guard
// without that state living in the page (where each click rebuilt the
// whole records table twice just to flip this flag).
let anyBusy = false;

// "(dynamic photo)" action riding on a PLAYER media line: rebuilds the
// real colour player photo from the hero render, in the browser. The
// result goes up through onResult (the page shows it in its overlay).
export function DynamicPhotoButton({ heroUrl, playerUrl, playName, onResult }) {
  const [busy, setBusy] = useState(false);

  const run = async (e) => {
    e.stopPropagation();
    if (anyBusy) return;
    anyBusy = true;
    setBusy(true);
    try {
      const res = await reconstructPlayer(heroUrl, playerUrl);
      onResult({ url: res.url, type: "image", title: `${playName} - player photo (rebuilt in your browser from the hero)` });
    } catch (err) {
      if (err?.photoHero && heroUrl) {
        // Safety net (the baked full-bleed flag should prevent this): the
        // hero turned out to be a raw photo, which IS the uncropped player
        // photo, so show it with an explanation
        onResult({ url: heroUrl, type: "image", title: `${playName} - this hero is a raw photo (no cube render), shown as is` });
      } else {
        console.warn("on-the-fly generation failed:", err);
      }
    } finally {
      anyBusy = false;
      setBusy(false);
    }
  };

  return (
    <button
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left", color: "rgba(167, 139, 250, 0.8)" }}
      className="ipfs-line"
      title="The official player image is only a silhouette; rebuild the real photo from the hero render, in your browser"
      onClick={run}
    >
      ({busy ? "⏳ rebuilding..." : "dynamic photo"})
    </button>
  );
}
