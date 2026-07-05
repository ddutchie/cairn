/**
 * Bidirectional sync orchestration (iCloud container).
 *
 * One "Sync Now" runs the full round-trip on the shared SyncEngine against the
 * app's iCloud container sync folder (no picker — auto-persisting):
 *   drainPending -> writeOwnOplog -> readPeerOplogs -> applyRemote -> re-publish
 * Async because iCloud I/O is async.
 */

import { getDb, getEngine } from "@/db";
import { getSyncFolderPath, iCloudAvailable } from "./folder";
import { writeOwnOplog, readPeerOplogs } from "./fs-transport";

export interface SyncResult {
  drained: number;
  peerOpsApplied: number;
  conflictCopies: number;
  connected: boolean;
  reason?: string; // when connected=false
}

export async function syncNow(): Promise<SyncResult> {
  if (!(await iCloudAvailable())) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason: "iCloud not available — sign in to iCloud in Settings." };
  }
  const folder = await getSyncFolderPath();
  if (!folder) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false, reason: "Couldn't open the iCloud Cairn folder." };
  }

  const engine = getEngine();

  // 1. Stage local writes into the oplog.
  const drained = engine.drainPending();

  // 2. Publish our oplog.
  await writeOwnOplog(folder, engine.deviceId, engine.exportOplog());

  // 3. Read peers.
  const peerEntries = await readPeerOplogs(folder, engine.deviceId);

  // 4. Reconcile.
  const { conflictCopies } = engine.applyRemote(peerEntries);

  // 5. Re-publish if reconcile changed our oplog.
  if (peerEntries.length > 0) {
    await writeOwnOplog(folder, engine.deviceId, engine.exportOplog());
  }

  return {
    drained,
    peerOpsApplied: peerEntries.length,
    conflictCopies: conflictCopies.length,
    connected: true,
  };
}

/** Count local changes waiting to be drained (for a "N pending" hint). */
export function pendingCount(): number {
  const row = getDb().getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_pending");
  return row?.n ?? 0;
}
