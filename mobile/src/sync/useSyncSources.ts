import { useCallback, useState } from "react";
import { getActiveSource, getActiveSourceName, getDeviceId } from "@/db";
import { getSyncFolderPath, iCloudAvailable } from "@/sync/folder";
import { listSources, type SyncSource } from "@/sync/fs-transport";

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
 * by the first-run SourcePicker and the header WorkspaceHeaderMenu.
 *
 * The two call sites differ only in options: the picker gates on iCloud
 * availability and shows errors (`gateOnICloud`), while the header switcher
 * merges the active workspace in and sorts by name (`mergeActive`).
 */
export function useSyncSources(opts: UseSyncSourcesOptions = {}): UseSyncSourcesResult {
  const { mergeActive = false, gateOnICloud = false } = opts;
  const [sources, setSources] = useState<SyncSource[]>([]);
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
        }
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
 * by display name — the header switcher's ordering. Keyed by id so a scanned
 * entry wins over the injected active stub.
 */
function withActiveMerged(found: SyncSource[]): SyncSource[] {
  const active = getActiveSource();
  const byId = new Map<string, SyncSource>();
  for (const s of found) byId.set(s.workspaceId, s);
  if (active && !byId.has(active)) {
    byId.set(active, { workspaceId: active, name: getActiveSourceName() });
  }
  return [...byId.values()].sort((a, b) =>
    (a.name ?? a.workspaceId).localeCompare(b.name ?? b.workspaceId),
  );
}
