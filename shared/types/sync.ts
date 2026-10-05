/**
 * Desktop sync (synced-folder oplog) payloads shared by the main-process sync
 * handlers (`electron/sync/`), the typed IPC contract and the renderer.
 * Engine row shapes (activity, restorable notes, peer protocols) live with
 * the engine in `shared/sync/engine.ts`.
 */

export type { PeerProtocol, RestorableRow, SyncActivityRow } from "../sync/engine";

export interface DesktopSyncResult {
  drained: number;
  /** Rows seeded by first-run backfill. */
  seeded: number;
  /** Ops that actually changed our DB (0 when converged). */
  peerOpsApplied: number;
  /** Ops read from the peer snapshot (steady-state size). */
  peerOpsRead: number;
  conflictCopies: number;
  connected: boolean;
}

/** Coarse sync lifecycle state, mirroring mobile's controller model. */
export type SyncState = "disabled" | "idle" | "syncing" | "offline";

/** A snapshot the renderer renders as a status glyph + popover. */
export interface SyncStatus {
  state: SyncState;
  /** Local writes staged but not yet published (sync_pending rows). */
  pending: number;
  /** Unresolved conflict copies awaiting the user's decision. */
  conflicts: number;
  /** ISO timestamp of the last successful full sync (null if never). */
  lastSyncAt: string | null;
  /** Whether a sync folder is connected. */
  connected: boolean;
}

/** What's staged in sync_pending (diagnostic for a stuck pending count). */
export interface SyncPendingBreakdown {
  total: number;
  groups: Array<{ entity: string; op: string; count: number }>;
  sampleIds: Record<string, string[]>;
}

/**
 * A conflict-copy note: the losing side of a 3-way body conflict, kept as a
 * cloned row (id `<originalId>_conflict_<deviceId>_<suffix>`) so nothing is
 * lost. Mirrors mobile's ConflictCopy shape so both platforms share the UI
 * model. `original` is the current live note this conflicts with (null if it
 * was since deleted).
 */
export interface ConflictCopy {
  id: string;
  /** Clean title with the " (conflicted copy — …)" suffix stripped. */
  title: string;
  content: string | null;
  projectId: string;
  folder: string;
  updatedAt: string;
  deviceId: string | null;
  originalId: string | null;
  original: { id: string; title: string; content: string | null; updatedAt: string } | null;
  /** The common-ancestor body (sync_row_base) for a true 3-way merge, if known. */
  baseBody: string | null;
}

export type ConflictResolution = "keepCopy" | "keepOriginal" | "keepMerged";
