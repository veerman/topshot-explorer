import { useEffect, useState } from "react";
import { loadIpfsMedia, getIpfsMediaState } from "../services/ipfs.media";

// Triggers the lazy load of data/ipfs_media.json and re-renders once it
// arrives. Returns the media state ({media, probedAt}) or null while
// loading/unavailable; pages must render fine with null.
export function useIpfsMedia() {
  const [state, setState] = useState(getIpfsMediaState());

  useEffect(() => {
    if (state) return;
    let alive = true;
    loadIpfsMedia().then((s) => { if (alive) setState(s); }).catch(() => { /* stays null */ });
    return () => { alive = false; };
  }, [state]);

  return state;
}
