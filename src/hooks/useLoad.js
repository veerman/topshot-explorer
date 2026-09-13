import { useEffect, useRef } from "react";

/**
 * Runs a page's data loader on mount and whenever its inputs change: the
 * one pattern behind every "fetch this page's data" effect. The loader
 * sets state as its results land, inside its own promise chain; the
 * effect body itself changes no state, so React commits the render first
 * and the loader's first setState (a loading flag, a reset) never cascades
 * inside the commit (the react-hooks/set-state-in-effect rule). The
 * loader identity may change per render; each run calls the latest one,
 * and a run superseded by a newer input change is skipped.
 */
export function useLoad(load, deps) {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) loadRef.current();
    });
    return () => { alive = false; };
    // The inputs are the caller's; the loader itself is read through the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
