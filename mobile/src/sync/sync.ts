/**
 * Bidirectional sync orchestration (iCloud container).
 *
 * One "Sync Now" runs the full round-trip on the shared SyncEngine against the
 * app's iCloud container sync folder (no picker — auto-persisting):
 *   drainPending -> writeOwnOplog -> readPeerOplogs -> applyRemote -> re-publish
 * Async because iCloud I/O is async.
 */

import { getDb, getEngine, getActiveSource } from "@/db";
import { getSyncFolderPath, iCloudAvailable } from "./folder";
import { writeOwnOplog, readSourceOplog } from "./fs-transport";

export interface SyncResult {
  drained: number;
  peerOpsApplied: number;
  conflictCopies: number;
  connected: boolean;
  reason?: string; // when connected=false
}

/** Max time to wait on any single iCloud I/O call before treating it as stalled. */
const ICLOUD_IO_TIMEOUT_MS = 20_000;

class TimeoutError extends Error {}

/** Reject if `p` doesn't settle within `ms` — prevents a stalled native iCloud
 * call from wedging the sync scheduler (requestSync's inFlight guard). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function syncNow(): Promise<SyncResult> {
  if (!(await iCloudAvailable())) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason: "iCloud not available — sign in to iCloud in Settings." };
  }
  const folder = await getSyncFolderPath();
  if (!folder) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason: "Couldn't open the iCloud Cairn folder." };
  }

  const workspaceId = getActiveSource();
  if (!workspaceId) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason: "No sync source selected." };
  }

  const engine = getEngine();

  try {
    // 1. Stage local writes into the oplog.
    const drained = engine.drainPending();

    // 2. Publish our oplog for THIS source (oplog-<deviceId>-<workspaceId>).
    await withTimeout(writeOwnOplog(folder, engine.deviceId, workspaceId, engine.exportOplog()), ICLOUD_IO_TIMEOUT_MS, "writeOwnOplog");

    // 3. Read peers for THIS source only (source-isolation boundary).
    const peerEntries = await withTimeout(readSourceOplog(folder, workspaceId, engine.deviceId), ICLOUD_IO_TIMEOUT_MS, "readSourceOplog");

    // 4. Reconcile.
    const { conflictCopies } = engine.applyRemote(peerEntries);

    // 5. Re-publish if reconcile changed our oplog.
    if (peerEntries.length > 0) {
      await withTimeout(writeOwnOplog(folder, engine.deviceId, workspaceId, engine.exportOplog()), ICLOUD_IO_TIMEOUT_MS, "writeOwnOplog");
    }

    return {
      drained,
      peerOpsApplied: peerEntries.length,
      conflictCopies: conflictCopies.length,
      connected: true,
    };
  } catch (e) {
    // A stalled/failed iCloud call resolves to connected:false so the scheduler
    // (controller.requestSync) clears its in-flight guard and can retry later.
    const reason = e instanceof TimeoutError ? e.message : `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason };
  }
}

/** Count local changes waiting to be drained (for a "N pending" hint). */
export function pendingCount(): number {
  if (!getActiveSource()) return 0;
  const row = getDb().getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_pending");
  return row?.n ?? 0;
}
