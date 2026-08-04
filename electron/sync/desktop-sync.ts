/**
 * Desktop sync manager.
 *
 * Instantiates the shared SyncEngine on the app DB and drives the synced-folder
 * round-trip (plan §3/§4) using the Node transport:
 *
 *   drainPending -> backfill (first run) -> write own oplog -> read peers ->
 *   applyRemote -> re-publish
 *
 * The sync folder is a user-chosen directory (typically iCloud Drive/…/Cairn)
 * shared with the mobile app. We ONLY read/write oplog-<deviceId>.ndjson files
 * there — never the binary cairn.db.
 *
 * Drain hooks (see wireDesktopSyncDrainTriggers in main.ts):
 *   - post-write (debounced) - primary
 *   - periodic setInterval    - safety net
 *   - powerMonitor 'resume' / window focus / before-quit - catch missed timers
 */

import type Database from "better-sqlite3";
import { SyncEngine } from "../../shared/sync/engine";
import { writeOplogFileAsync, readPeerOplogsAsync } from "../../shared/sync/transport";
import { inspectConflict, cleanConflictTitle } from "../../shared/sync/conflict";

export interface DesktopSyncResult {
  drained: number;
  seeded: number; // rows seeded by first-run backfill
  peerOpsApplied: number; // ops that actually changed our DB (0 when converged)
  peerOpsRead: number; // ops read from the peer snapshot (steady-state size)
  conflictCopies: number;
  connected: boolean;
}

/**
 * Callback that projects a synced note change back onto disk (.md dual-write).
 * main.ts supplies this (it owns workspacePath + the notes-io/file-watcher
 * modules); desktop-sync stays platform-light. `op` is 'put' (write/rewrite the
 * .md) or 'delete' (remove the .md).
 */
export type NoteFileProjector = (noteId: string, op: "put" | "delete") => void;

// A projector registered once by main.ts, so BOTH the periodic sync loop and
// the manual sync:now IPC handler re-emit .md files for inbound note changes
// without each caller having to thread the callback through.
let _projector: NoteFileProjector | null = null;
export function setNoteFileProjector(fn: NoteFileProjector | null): void {
  _projector = fn;
}

// ── live status (pushed to the renderer title-bar indicator) ────────────────

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

let _status: SyncStatus = {
  state: "disabled",
  pending: 0,
  conflicts: 0,
  lastSyncAt: null,
  connected: false,
};
let _statusListener: ((s: SyncStatus) => void) | null = null;

/** main.ts registers one listener that broadcasts `sync:status` to windows. */
export function setSyncStatusListener(fn: ((s: SyncStatus) => void) | null): void {
  _statusListener = fn;
}

/** Current snapshot (used by the sync:status IPC handler for initial fetch). */
export function getSyncStatus(): SyncStatus {
  return _status;
}

/** Merge a partial update into the status and notify the listener if it changed. */
function updateStatus(db: Database.Database, patch: Partial<SyncStatus>): void {
  const next: SyncStatus = { ..._status, ...patch };
  // Always refresh the derived counters from the DB so they can't drift.
  try {
    next.pending = pendingCount(db);
    next.conflicts = conflictCount(db);
  } catch {
    /* db unavailable mid-teardown — keep prior counters */
  }
  const changed =
    next.state !== _status.state ||
    next.pending !== _status.pending ||
    next.conflicts !== _status.conflicts ||
    next.lastSyncAt !== _status.lastSyncAt ||
    next.connected !== _status.connected;
  _status = next;
  if (changed && _statusListener) _statusListener(_status);
}

/** Recompute + broadcast status from current DB state (folder connect/disconnect, post-write). */
export function refreshSyncStatus(db: Database.Database): void {
  const connected = !!getSyncFolder(db);
  updateStatus(db, {
    connected,
    state: connected ? (_status.state === "syncing" ? "syncing" : _status.state === "offline" ? "offline" : "idle") : "disabled",
  });
}

/** Count of local writes staged but not yet drained into the oplog. */
export function pendingCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) c FROM sync_pending").get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Diagnostic breakdown of what is currently staged in sync_pending, grouped by
 * (entity, op). Answers "why is my pending count non-zero / regenerating after
 * every sync?" — a persistent batch of the same rows points at a writer that
 * re-stages without the capture-trigger suppression (e.g. the file-watcher
 * re-importing .md files on a cloud-backed folder). Also returns the distinct
 * entity_ids per entity (capped) so a specific note/card can be traced.
 */
export function pendingBreakdown(db: Database.Database): {
  total: number;
  groups: { entity: string; op: string; count: number }[];
  sampleIds: Record<string, string[]>;
} {
  const groups = db
    .prepare(
      `SELECT entity, op, COUNT(*) AS count
         FROM sync_pending
        GROUP BY entity, op
        ORDER BY count DESC`,
    )
    .all() as { entity: string; op: string; count: number }[];
  const total = groups.reduce((n, g) => n + g.count, 0);
  const sampleIds: Record<string, string[]> = {};
  for (const g of groups) {
    const ids = db
      .prepare("SELECT DISTINCT entity_id FROM sync_pending WHERE entity = ? LIMIT 20")
      .all(g.entity) as { entity_id: string }[];
    sampleIds[g.entity] = ids.map((r) => r.entity_id);
  }
  return { total, groups, sampleIds };
}

let _engine: SyncEngine | null = null;

/** Stable per-install device id (persisted in sync_state by the engine ctor). */
function ensureDeviceId(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = 'device_id'").get() as
    | { value: string }
    | undefined;
  if (row?.value) return row.value;
  const id = `desktop_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES ('device_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(id);
  return id;
}

/** Get (or lazily create) the SyncEngine bound to the given DB. */
export function getDesktopEngine(db: Database.Database): SyncEngine {
  if (_engine && _engine.db === (db as unknown)) return _engine;
  const deviceId = ensureDeviceId(db);
  // better-sqlite3 satisfies the SyncDb adapter interface structurally.
  _engine = new SyncEngine(db as never, deviceId);
  return _engine;
}

/** Reset the cached engine (call when the workspace DB is swapped). */
export function resetDesktopEngine(): void {
  _engine = null;
}

/**
 * Tombstone the given note ids THROUGH the sync engine (delete-safe) so the
 * deletion propagates to peers with a fresh, winning HLC and both devices
 * converge. Used by the boot cleanup for nested conflict-copy junk: a raw
 * physical DELETE would be re-created on the next sync from the peer's oplog
 * (which still holds the row) — the engine tombstone + high HLC makes the delete
 * stick everywhere. Returns the count tombstoned.
 */
export function tombstoneNotesViaSync(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const engine = getDesktopEngine(db);
  let n = 0;
  for (const id of ids) {
    try {
      engine.remove("notes", id);
      n++;
    } catch {
      /* best-effort per id */
    }
  }
  return n;
}

/**
 * The workspace this desktop syncs as its SOURCE. The desktop is single-source:
 * it takes the first/oldest workspace (matching main.ts boot resolution). Used
 * as the `<workspaceId>` suffix on the oplog filename so many devices AND
 * workspaces can share one folder while each reader selects only its workspace.
 * Returns "" if no workspace exists yet (falls back to legacy unsuffixed name).
 */
function getSourceWorkspaceId(db: Database.Database): string {
  const row = db.prepare("SELECT id FROM workspaces ORDER BY created_at LIMIT 1").get() as
    | { id?: string }
    | undefined;
  return row?.id ?? "";
}

// ── sync-folder persistence (in sync_state) ─────────────────────────────────

const FOLDER_KEY = "sync_folder_path";

export function getSyncFolder(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(FOLDER_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncFolder(db: Database.Database, folderPath: string): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(FOLDER_KEY, folderPath);
}

export function clearSyncFolder(db: Database.Database): void {
  db.prepare("DELETE FROM sync_state WHERE key = ?").run(FOLDER_KEY);
}

// ── conflict copies (surfaced for manual resolution) ────────────────────────

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

interface RawNoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string | null;
  folder: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * All live conflict-copy notes for manual resolution. The engine mints these on
 * `applyRemote` when both sides edited a note body since the common ancestor;
 * they carry the `_conflict_` id marker (see engine.makeConflictCopy).
 */
export function listConflictCopies(db: Database.Database): ConflictCopy[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, title, content, folder, updated_at
         FROM notes
        WHERE deleted_at IS NULL AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'
        ORDER BY updated_at DESC`,
    )
    .all() as RawNoteRow[];

  return rows.map((r) => {
    const info = inspectConflict(r.id, r.title);
    const original = info.originalId
      ? (db
          .prepare("SELECT id, title, content, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL")
          .get(info.originalId) as { id: string; title: string; content: string | null; updated_at: string } | undefined)
      : undefined;
    // The engine records the common-ancestor body against the ORIGINAL note id
    // (the copy is a fresh row), so a 3-way merge reads sync_row_base[originalId].
    const baseRow = info.originalId
      ? (db
          .prepare("SELECT base_body FROM sync_row_base WHERE entity = 'notes' AND entity_id = ?")
          .get(info.originalId) as { base_body: string | null } | undefined)
      : undefined;
    return {
      id: r.id,
      title: cleanConflictTitle(r.title),
      content: r.content,
      projectId: r.project_id,
      folder: r.folder,
      updatedAt: r.updated_at,
      deviceId: info.deviceId,
      originalId: info.originalId,
      original: original
        ? { id: original.id, title: original.title, content: original.content, updatedAt: original.updated_at }
        : null,
      baseBody: baseRow ? baseRow.base_body : null,
    };
  });
}

/** Count of unresolved conflict copies — for the title-bar badge. */
export function conflictCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) c FROM notes
        WHERE deleted_at IS NULL AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'`,
    )
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * How to resolve a conflict:
 *   - "keepCopy": overwrite the original note with the copy's body, then delete
 *     the copy. If the original is gone, promote the copy (strip the suffix).
 *   - "keepOriginal": delete the conflict copy, leaving the original untouched.
 *   - "keepMerged": write the caller-supplied merged body onto the original,
 *     then delete the copy (used by the 3-way / manual merge in the dialog).
 *
 * Writes go through the provided query/file callbacks (supplied by main.ts,
 * which owns the .md dual-write + capture triggers) so the resolution both
 * updates disk and propagates to peers via the normal capture path.
 */
export interface ConflictResolveDeps {
  updateNoteBody: (id: string, title: string, content: string) => void;
  deleteNoteRow: (id: string) => void;
}

export type ConflictAction =
  | { action: "keepCopy" | "keepOriginal" }
  | { action: "keepMerged"; mergedContent: string };

export function resolveConflict(
  db: Database.Database,
  copyId: string,
  action: ConflictAction,
  deps: ConflictResolveDeps,
): { resolvedOriginalId: string | null } {
  const copy = db
    .prepare("SELECT id, project_id, title, content, folder, updated_at, deleted_at FROM notes WHERE id = ?")
    .get(copyId) as RawNoteRow | undefined;
  if (!copy) return { resolvedOriginalId: null };

  const info = inspectConflict(copy.id, copy.title);
  const cleanTitle = cleanConflictTitle(copy.title);

  if (action.action === "keepOriginal") {
    // Discard the copy; the original stands as-is.
    deps.deleteNoteRow(copy.id);
    return { resolvedOriginalId: info.originalId };
  }

  const original = info.originalId
    ? (db.prepare("SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL").get(info.originalId) as
        | { id: string }
        | undefined)
    : undefined;

  if (action.action === "keepMerged") {
    // Write the merged body onto the original (or promote the copy if the
    // original is gone), then drop the copy.
    if (original) {
      deps.updateNoteBody(original.id, cleanTitle, action.mergedContent);
      deps.deleteNoteRow(copy.id);
      return { resolvedOriginalId: original.id };
    }
    deps.updateNoteBody(copy.id, cleanTitle, action.mergedContent);
    return { resolvedOriginalId: copy.id };
  }

  // keepCopy: promote the copy's body onto the original, then remove the copy.
  if (original) {
    deps.updateNoteBody(original.id, cleanTitle, copy.content ?? "");
    deps.deleteNoteRow(copy.id);
    return { resolvedOriginalId: original.id };
  }
  // No live original — strip the suffix so the copy stands in for it.
  deps.updateNoteBody(copy.id, cleanTitle, copy.content ?? "");
  return { resolvedOriginalId: copy.id };
}

// ── Phase 4: sync visibility & recovery ─────────────────────────────────────

/**
 * Recent reconcile decisions (what sync actually did and why).
 *
 * Note this lazily constructs the engine if it doesn't exist yet, so it is not
 * strictly side-effect-free — in practice the panel only renders once a sync
 * folder is connected, by which point the engine is already live.
 */
export function listSyncActivity(db: Database.Database, limit = 100) {
  return getDesktopEngine(db).listSyncActivity(limit);
}

/**
 * Notes tombstoned by another device that can genuinely be brought back, newest
 * first, plus the true total (which may exceed the returned page).
 */
export function listRestorableNotes(db: Database.Database, limit = 50) {
  return getDesktopEngine(db).listRestorable("notes", limit);
}

/**
 * Undo a peer's delete for one note.
 *
 * Two halves must both happen: the engine revives the row with causal proof it
 * observed the delete (so peers accept the revival instead of re-deleting it),
 * and the note's `.md` file has to be written back to disk — the desktop delete
 * removed it. `updateNoteBody` is the same dep the conflict resolver uses, so
 * the file write goes through the watcher's echo-suppression.
 *
 * The row is revived (and published) before the file write, so a file failure
 * is reported as `fileError` rather than silently leaving the caller to think
 * nothing happened — the DB half has already succeeded at that point.
 */
export function restoreDeletedNote(
  db: Database.Database,
  id: string,
  deps: ConflictResolveDeps,
): { restored: boolean; reason?: string; fileError?: string } {
  const engine = getDesktopEngine(db);
  const row = db.prepare("SELECT id, title, content FROM notes WHERE id = ?").get(id) as
    | { id: string; title: string | null; content: string | null }
    | undefined;
  const result = engine.restoreDeleted("notes", id);
  if (!result.restored) return { restored: false, reason: result.reason };
  try {
    deps.updateNoteBody(id, row?.title ?? "", row?.content ?? "");
  } catch (err) {
    return { restored: true, fileError: err instanceof Error ? err.message : String(err) };
  }
  return { restored: true };
}

// ── drain (fast, no folder I/O) ─────────────────────────────────────────────
/**
 * Turn staged local writes into HLC-stamped oplog entries. Cheap and safe to
 * call often (post-write, periodic, on resume). Returns rows drained.
 */
export function drainDesktop(db: Database.Database): number {
  try {
    return getDesktopEngine(db).drainPending();
  } catch (err) {
    console.error("[sync] drain failed:", err);
    return 0;
  }
}

// ── full round-trip (folder I/O) ────────────────────────────────────────────

/**
 * Run a full sync against the connected folder. Safe to call with no folder
 * connected (returns connected:false). Serialised by the engine's transactions.
 *
 * `projectNote` (optional) is invoked for every note row changed by inbound
 * peer ops so the desktop can re-emit the .md file (dual-write parity). Called
 * AFTER reconcile so the DB is already authoritative.
 */
export async function syncDesktop(db: Database.Database, projectNote?: NoteFileProjector): Promise<DesktopSyncResult> {
  const folder = getSyncFolder(db);
  if (!folder) {
    updateStatus(db, { connected: false, state: "disabled" });
    return { drained: 0, seeded: 0, peerOpsApplied: 0, peerOpsRead: 0, conflictCopies: 0, connected: false };
  }
  const engine = getDesktopEngine(db);
  const project = projectNote ?? _projector;
  // The workspace this desktop publishes as its source (filename suffix).
  const workspaceId = getSourceWorkspaceId(db);

  updateStatus(db, { connected: true, state: "syncing" });
  try {
    // First-run backfill so the phone receives the whole existing workspace.
    const seeded = engine.backfill();
    // Stage any pending local writes.
    const drained = engine.drainPending();
    // Publish our full oplog. Folder I/O is async so a slow/network-backed folder
    // (iCloud/Dropbox) doesn't block the Electron main loop.
    await writeOplogFileAsync(folder, engine.deviceId, engine.exportOplog(), workspaceId);
    // Read + reconcile peers — only files for OUR workspace (source isolation).
    const peerEntries = await readPeerOplogsAsync(folder, engine.deviceId, workspaceId);
    const { conflictCopies, applied } = engine.applyRemote(peerEntries);
    // Re-publish if reconcile forwarded peer ops / minted conflict copies.
    if (peerEntries.length > 0) {
      await writeOplogFileAsync(folder, engine.deviceId, engine.exportOplog(), workspaceId);
    }

    // Project inbound note changes onto disk (.md dual-write parity). Conflict
    // copies are new note rows, so they get .md files too.
    if (project) {
      const seen = new Set<string>();
      for (const a of applied) {
        if (a.entity !== "notes") continue;
        if (seen.has(a.entity_id)) continue;
        seen.add(a.entity_id);
        try {
          project(a.entity_id, a.op === "delete" ? "delete" : "put");
        } catch (err) {
          console.error(`[sync] project note ${a.entity_id} to disk failed:`, err);
        }
      }
      for (const copyId of conflictCopies) {
        try { project(copyId, "put"); } catch { /* ignore */ }
      }
    }

    updateStatus(db, { connected: true, state: "idle", lastSyncAt: new Date().toISOString() });
    return {
      drained,
      seeded,
      // Ops actually applied to our DB (new/changed rows). On a converged
      // workspace this is 0 even though we READ the peer's full snapshot.
      peerOpsApplied: applied.length,
      // How many ops we read from the peer file this round (the snapshot size).
      // Distinct from peerOpsApplied — a steady non-zero read with 0 applied is
      // NORMAL convergence, not a loop.
      peerOpsRead: peerEntries.length,
      conflictCopies: conflictCopies.length,
      connected: true,
    };
  } catch (err) {
    // A folder that's temporarily unreadable (iCloud offline, permissions) is a
    // transient offline state, not a hard failure — surface it and rethrow.
    updateStatus(db, { connected: true, state: "offline" });
    throw err;
  }
}
