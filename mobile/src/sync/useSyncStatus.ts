import { useEffect, useState } from "react";
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
