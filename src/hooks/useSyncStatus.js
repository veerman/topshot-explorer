import { useEffect, useRef, useState } from "react";
import { subscribeSyncStatus, isSyncCompleteStage } from "../services/sync.coordinator";

/**
 * The live background-sync status, for pages that render progress. One
 * hook call replaces the subscribe-in-effect boilerplate each page used
 * to carry.
 */
export function useSyncStatus() {
  const [syncState, setSyncState] = useState({ isSyncing: false, stage: "Idle", progressPercent: 0, syncedPlays: 0, totalPlays: 0 });
  useEffect(() => subscribeSyncStatus(setSyncState), []);
  return syncState;
}

/**
 * Reruns loadData once whenever a background sync pass completes (not on
 * every stage change). The callback identity may change per render; the
 * subscription stays put and always calls the latest one.
 */
export function useReloadOnSyncComplete(loadData) {
  const loadRef = useRef(loadData);
  useEffect(() => {
    loadRef.current = loadData;
  });
  const wasSyncingRef = useRef(false);
  useEffect(() => subscribeSyncStatus((status) => {
    if (wasSyncingRef.current && isSyncCompleteStage(status.stage)) loadRef.current();
    wasSyncingRef.current = status.isSyncing;
  }), []);
}
