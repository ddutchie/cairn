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
import { writeOplogFile, readPeerOplogs } from "../../shared/sync/transport";

export interface DesktopSyncResult {
  drained: number;
  seeded: number; // rows seeded by first-run backfill
  peerOpsApplied: number;
  conflictCopies: number;
  connected: boolean;
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
 */
export function syncDesktop(db: Database.Database): DesktopSyncResult {
  const folder = getSyncFolder(db);
  if (!folder) {
    return { drained: 0, seeded: 0, peerOpsApplied: 0, conflictCopies: 0, connected: false };
  }
  const engine = getDesktopEngine(db);

  // First-run backfill so the phone receives the whole existing workspace.
  const seeded = engine.backfill();
  // Stage any pending local writes.
  const drained = engine.drainPending();
  // Publish our full oplog.
  writeOplogFile(folder, engine.deviceId, engine.exportOplog());
  // Read + reconcile peers.
  const peerEntries = readPeerOplogs(folder, engine.deviceId);
  const { conflictCopies } = engine.applyRemote(peerEntries);
  // Re-publish if reconcile forwarded peer ops / minted conflict copies.
  if (peerEntries.length > 0) {
    writeOplogFile(folder, engine.deviceId, engine.exportOplog());
  }

  return {
    drained,
    seeded,
    peerOpsApplied: peerEntries.length,
    conflictCopies: conflictCopies.length,
    connected: true,
  };
}
