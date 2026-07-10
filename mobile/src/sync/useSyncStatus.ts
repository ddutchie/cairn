import { useEffect, useState, useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { subscribe, onDataChanged, getSnapshot, type SyncSnapshot } from "./controller";

/** Subscribe to the auto-sync controller's live state (for badges/banners). */
export function useSyncStatus(): SyncSnapshot {
  const [snap, setSnap] = useState<SyncSnapshot>(getSnapshot);
  useEffect(() => subscribe(setSnap), []);
  return snap;
}

/**
 * Run `reload` whenever a sync applies inbound peer changes. Screens use this
 * (alongside useFocusEffect) so remote edits appear without a manual refresh.
 */
export function useDataChanged(reload: () => void): void {
  useEffect(() => onDataChanged(reload), [reload]);
}

/**
 * Refresh a screen's data on focus AND when a sync applies inbound peer changes
 * — the two triggers nearly every list/detail screen wires up. Consolidates the
 * repeated `useFocusEffect(useCallback(() => load(), [load])); useDataChanged(load);`
 * pair. Pass an already-memoized `load` (wrap in `useCallback` at the call site);
 * set `onData: false` to refresh on focus only (e.g. surfaces that don't need to
 * react to inbound peer edits).
 */
export function useRefreshOnFocus(load: () => void, opts?: { onData?: boolean }): void {
  useFocusEffect(useCallback(() => load(), [load]));
  useEffect(() => (opts?.onData === false ? undefined : onDataChanged(load)), [load, opts?.onData]);
}
