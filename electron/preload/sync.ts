/** Desktop sync (synced-folder oplog). */

import { invokeContract, onIpcEvent } from "./ipc";
import type { ConflictResolution, SyncStatus } from "../../shared/types/sync";

export const syncApi = {
  // ── Desktop sync (synced-folder oplog: connect folder + manual sync) ──
  sync: {
    getFolder: () => invokeContract("sync:getFolder"),
    selectFolder: () => invokeContract("sync:selectFolder"),
    clearFolder: () => invokeContract("sync:clearFolder"),
    now: () => invokeContract("sync:now"),
    // Current live status snapshot (state + pending/conflict counts + lastSyncAt).
    status: () => invokeContract("sync:status"),
    // Diagnostic: what's staged in sync_pending (entity/op/count + sample ids).
    pendingBreakdown: () => invokeContract("sync:pendingBreakdown"),
    // Subscribe to pushed status transitions. Returns an unsubscribe fn.
    onStatus: (cb: (status: SyncStatus) => void) => onIpcEvent("sync:status", cb),
    // Conflict copies awaiting manual resolution.
    listConflicts: () => invokeContract("sync:listConflicts"),
    resolveConflict: (copyId: string, action: ConflictResolution, mergedContent?: string) =>
      invokeContract("sync:resolveConflict", { copyId, action, mergedContent }),
    // Recent reconcile decisions — why a row was applied, skipped or deleted.
    activity: (limit?: number) => invokeContract("sync:activity", { limit }),
    // Notes deleted by another device that can still be restored. `total` may
    // exceed `rows.length` — never present the page size as the count.
    listRestorable: (limit?: number) => invokeContract("sync:listRestorable", { limit }),
    restoreNote: (id: string) => invokeContract("sync:restoreNote", { id }),
    // Retry the .md write for a restore whose DB half already succeeded.
    repairNoteFile: (id: string) => invokeContract("sync:repairNoteFile", { id }),
    // Peer devices on a different sync protocol version (behind = too old to honour deletes).
    peerProtocols: () => invokeContract("sync:peerProtocols"),
  },
} as const;
