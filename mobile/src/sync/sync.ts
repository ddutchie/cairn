/**
 * Bidirectional sync orchestration (P4).
 *
 * A single "Sync Now" runs the full round-trip against the connected iCloud
 * folder using the IDENTICAL shared SyncEngine the desktop uses:
 *
 *   1. drainPending()  — turn local writes (staged by capture triggers) into
 *                        HLC-stamped oplog entries.
 *   2. writeOwnOplog() — publish this device's full oplog to the shared folder.
 *   3. readPeerOplogs()— read every other device's oplog file.
 *   4. applyRemote()   — reconcile peer ops (LWW + array-union + conflict-copy).
 *   5. re-export + re-publish — applyRemote may forward peer ops into our own
 *                        oplog and mint conflict copies, so write again so peers
 *                        converge on the merged state.
 *
 * Convergent by construction (all peers replay the same ops in HLC order).
 */

import { getDb, getEngine } from "@/db";
import { getSyncFolder } from "./folder";
import { writeOwnOplog, readPeerOplogs } from "./fs-transport";

export interface SyncResult {
  drained: number; // local changes turned into ops this run
  peerOpsApplied: number; // peer ops reconciled in
  conflictCopies: number; // conflict-copy notes created
  connected: boolean; // false if no folder is connected
}

export function syncNow(): SyncResult {
  const folder = getSyncFolder();
  if (!folder) {
    return { drained: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false };
  }

  const engine = getEngine();

  // 1. Stage local writes into the oplog.
  const drained = engine.drainPending();

  // 2. Publish our oplog.
  writeOwnOplog(folder, engine.deviceId, engine.exportOplog());

  // 3. Read peers.
  const peerEntries = readPeerOplogs(folder, engine.deviceId);

  // 4. Reconcile.
  const { conflictCopies } = engine.applyRemote(peerEntries);

  // 5. Re-publish if reconcile changed our oplog (forwarded ops / conflict copies).
  if (peerEntries.length > 0) {
    writeOwnOplog(folder, engine.deviceId, engine.exportOplog());
  }

  return {
    drained,
    peerOpsApplied: peerEntries.length,
    conflictCopies: conflictCopies.length,
    connected: true,
  };
}

/** Count local changes waiting to be drained (for a "N pending" status hint). */
export function pendingCount(): number {
  const row = getDb().getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_pending");
  return row?.n ?? 0;
}
