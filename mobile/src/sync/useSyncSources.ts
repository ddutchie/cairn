import { useCallback, useState } from "react";
import { getActiveSource, getActiveSourceName, getDeviceId } from "@/db";
import { getSyncFolderPath, iCloudAvailable } from "@/sync/folder";
import { listSources, type SyncSource } from "@/sync/fs-transport";
import { mergeSwitcherSources } from "@/sync/switcher-sources";
import { DEMO_WORKSPACE_ID } from "@/dev/demo-seed";

interface UseSyncSourcesOptions {
  /**
   * Merge the currently-active source into the list even if the folder scan
   * hasn't surfaced it yet, and sort the result by display name. Used by the
   * header switcher so the active workspace is always present/ordered. Default
   * false (the picker wants only what's actually on disk, unsorted-merge-free).
   */
  mergeActive?: boolean;
  /**
   * Gate the scan on iCloud availability and surface a user-facing `error`
   * string when iCloud/the folder is unavailable. Used by the first-run picker.
   * Default false (silent — callers that just refresh a list keep their prior
   * value on failure).
   */
  gateOnICloud?: boolean;
}

interface UseSyncSourcesResult {
  sources: SyncSource[];
  loading: boolean;
  error: string | null;
  /** Re-scan the shared folder. Safe to call from focus effects or handlers. */
  refresh: () => Promise<void>;
}

/**
 * Scan the shared iCloud folder for published workspaces (sources) — the common
 * `getSyncFolderPath()` + `listSources(folder, getDeviceId())` round-trip shared
 * by the header WorkspaceHeaderMenu (the first-run OnboardingGuide runs its own
 * scan so it can drive the guided-checklist phases directly).
 *
 * The two call sites differ only in options: the picker gates on iCloud
 * availability and shows errors (`gateOnICloud`), while the header switcher
 * merges the active workspace in and sorts by name (`mergeActive`).
 */
export function useSyncSources(opts: UseSyncSourcesOptions = {}): UseSyncSourcesResult {
  const { mergeActive = false, gateOnICloud = false } = opts;
  // The switcher starts with the active workspace listed (not empty) so its
  // menu has something to show before — or without — a folder scan.
  const [sources, setSources] = useState<SyncSource[]>(() => (mergeActive ? withActiveMerged([]) : []));
  const [loading, setLoading] = useState(gateOnICloud);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (gateOnICloud && !(await iCloudAvailable())) {
        setError("iCloud isn't available. Sign in to iCloud in Settings, then reopen Cairn.");
        setSources([]);
        return;
      }
      const folder = await getSyncFolderPath();
      if (!folder) {
        if (gateOnICloud) {
          setError("Couldn't open the iCloud Cairn folder.");
          setSources([]);
        } else if (mergeActive) setSources(withActiveMerged([]));
        return;
      }
      const found = await listSources(folder, getDeviceId());
      setSources(mergeActive ? withActiveMerged(found) : found);
    } catch (e) {
      // The picker shows the error; the header switcher silently keeps its list.
      if (gateOnICloud) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mergeActive, gateOnICloud]);

  return { sources, loading, error, refresh };
}

/**
 * Ensure the active source is present (it may not be in the scan yet) and sort
 * by display name — the header switcher's ordering. Dev builds also list the
 * local demo workspace so switching can be exercised without iCloud.
 */
function withActiveMerged(found: SyncSource[]): SyncSource[] {
  const active = getActiveSource();
  return mergeSwitcherSources(
    found,
    active ? { workspaceId: active, name: getActiveSourceName() } : null,
    __DEV__ ? [{ workspaceId: DEMO_WORKSPACE_ID, name: "Sample workspace" }] : [],
  );
}
