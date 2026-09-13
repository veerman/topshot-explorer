import { useState, useEffect, useCallback } from "react";
import { useReloadOnSyncComplete } from "./useSyncStatus";

/**
 * The load skeleton seven list/detail pages each hand-rolled (~30 lines
 * apiece): run an async loader against the local database, hold its
 * result, surface a LoadError message on failure, reload when a sync pass
 * completes, and re-run when the loader's identity changes (pages wrap
 * loaders in useCallback over their route params).
 *
 * Returns { data, loading, loadError, retry }: data is null until the
 * first load resolves; loading is true only until then (a loader-change
 * reload swaps content in place, matching the old pages); retry clears
 * the error and shows the spinner again.
 *
 * Plays and Seasons deliberately do NOT use this: they have no loading
 * flag and gate on emptiness to show their "Database is empty. Waiting
 * for Sync Coordinator" message instead.
 */
export function useDbData(loader, errorMessage) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    try {
      const result = await loader();
      setData(result);
      setLoadError("");
    } catch (err) {
      console.error(errorMessage, err);
      setLoadError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [loader, errorMessage]);

  useEffect(() => {
    // Every setState inside loadData lands AFTER an await, never in this
    // effect's synchronous body; the rule cannot see through the async
    // call, so it is silenced once here for every page using the hook
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  useReloadOnSyncComplete(loadData);

  const retry = useCallback(() => {
    setLoading(true);
    setLoadError("");
    loadData();
  }, [loadData]);

  return { data, loading, loadError, retry };
}
