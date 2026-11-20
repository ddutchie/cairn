/**
 * Typed client for desktop sync (`sync:*`). Every failure rejects with the
 * main-process message; off-Electron calls reject with `IpcUnavailableError`.
 */
import type { ConflictResolution, SyncStatus } from "../../../shared/types/sync";
import { domainCall, type ElectronApi } from "./client";

type SyncApi = NonNullable<ElectronApi["sync"]>;
const sync = <T>(fn: (api: SyncApi) => Promise<T>) => domainCall("sync", fn);

export const syncClient = {
  getFolder: () => sync((s) => s.getFolder()),
  selectFolder: () => sync((s) => s.selectFolder()),
  clearFolder: () => sync((s) => s.clearFolder()),
  /** Disconnect and remove this workspace's published files (oplog + blobs) from the shared folder. */
  removeFromFolder: () => sync((s) => s.removeFromFolder()),
  now: () => sync((s) => s.now()),
  /** Current live status snapshot (state + pending/conflict counts + lastSyncAt). */
  status: () => sync((s) => s.status()),
  /** Diagnostic: what's staged in sync_pending. */
  pendingBreakdown: () => sync((s) => s.pendingBreakdown()),
  /** Subscribe to pushed status transitions. Returns the unsubscribe function. */
  onStatus: (cb: (status: SyncStatus) => void): (() => void) =>
    window.electron?.sync?.onStatus?.(cb) ?? (() => {}),
  /** Conflict copies awaiting manual resolution. */
  listConflicts: () => sync((s) => s.listConflicts()),
  resolveConflict: (copyId: string, action: ConflictResolution, mergedContent?: string) =>
    sync((s) => s.resolveConflict(copyId, action, mergedContent)),
  /** Recent reconcile decisions — why a row was applied, skipped or deleted. */
  activity: (limit?: number) => sync((s) => s.activity(limit)),
  /** Notes deleted by another device that can still be restored. */
  listRestorable: (limit?: number) => sync((s) => s.listRestorable(limit)),
  restoreNote: (id: string) => sync((s) => s.restoreNote(id)),
  /** Retry the .md write for a restore whose DB half already succeeded. */
  repairNoteFile: (id: string) => sync((s) => s.repairNoteFile(id)),
  /** Peer devices on a different sync protocol version. */
  peerProtocols: () => sync((s) => s.peerProtocols()),
};
