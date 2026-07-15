/**
 * Mobile database bootstrap + sync engine — MULTI-SOURCE.
 *
 * Mobile is the only device that holds multiple SOURCES (each source = a
 * desktop workspace discovered in the shared iCloud folder). Each source gets
 * its OWN SQLite DB `cairn-mobile-<workspaceId>.db` with its own SyncEngine, so
 * a source's data physically never mixes with another's (the privacy boundary).
 *
 * `getDb()` / `getEngine()` return the ACTIVE source's DB/engine. Switching
 * source (`setActiveSource`) re-points those accessors; because every screen /
 * query / tool reads through them, the whole app re-scopes for free.
 *
 * A tiny `cairn-mobile-meta.db` holds cross-source state that must NOT live in
 * any single source DB: the stable per-install device id and which source is
 * active. The device id is shared across all source DBs so the phone presents
 * one identity to peers, and each source DB's oplog is published as
 * `oplog-<deviceId>-<workspaceId>.ndjson`.
 */

import * as SQLite from "expo-sqlite";
import { SyncEngine } from "@cairn/shared/sync/engine";
import { createExpoSyncDb } from "./expo-sync-db";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";
import { runMigrations } from "./migrations";

/** Meta DB: cross-source install state (device id + active source). */
const META_DB_NAME = "cairn-mobile-meta.db";
/** Pre-multi-source single DB. Deleted once on upgrade (see dropLegacyDb). */
const LEGACY_DB_NAME = "cairn-mobile.db";
/** DB filename for a given source workspace. */
function sourceDbName(workspaceId: string): string {
  return `cairn-mobile-${workspaceId}.db`;
}

interface SourceHandle {
  db: SQLite.SQLiteDatabase;
  engine: SyncEngine;
  workspaceId: string;
}

let _meta: SQLite.SQLiteDatabase | null = null;
const _sources = new Map<string, SourceHandle>();
let _activeWorkspaceId: string | null = null;

function metaDb(): SQLite.SQLiteDatabase {
  if (_meta) return _meta;
  const db = SQLite.openDatabaseSync(META_DB_NAME);
  db.execSync(
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  _meta = db;
  return db;
}

function metaGet(key: string): string | null {
  const row = metaDb().getFirstSync<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

function metaSet(key: string, value: string): void {
  metaDb().runSync(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

/**
 * Device-global key/value access to the meta DB, for config that must survive
 * source (workspace) switches AND the legacy-DB wipe on upgrade — e.g. the AI
 * provider endpoint/model. Do NOT use for workspace data (that belongs in the
 * source DB so it syncs / stays scoped). Meta is never synced.
 */
export function getMeta(key: string): string | null {
  return metaGet(key);
}
export function setMeta(key: string, value: string): void {
  metaSet(key, value);
}

/** Stable per-install device id (shared across all source DBs). */
export function getDeviceId(): string {
  const existing = metaGet("device_id");
  if (existing) return existing;
  const id = `mobile_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  metaSet("device_id", id);
  return id;
}

/** The workspaceId of the active source, or null if none selected yet. */
export function getActiveSource(): string | null {
  if (_activeWorkspaceId) return _activeWorkspaceId;
  const stored = metaGet("active_source");
  if (stored) _activeWorkspaceId = stored;
  return _activeWorkspaceId;
}

/** The active workspace's display name from its DB, or null if unknown. */
export function getActiveSourceName(): string | null {
  const ws = getActiveSource();
  if (!ws) return null;
  try {
    const row = openSource(ws).db.getFirstSync<{ name: string }>(
      "SELECT name FROM workspaces WHERE id = ?",
      ws,
    );
    return row?.name ?? null;
  } catch {
    return null;
  }
}

/** Open (or return cached) the DB + engine for a source workspace. */
function openSource(workspaceId: string): SourceHandle {
  const cached = _sources.get(workspaceId);
  if (cached) return cached;

  const db = SQLite.openDatabaseSync(sourceDbName(workspaceId));
  db.execSync(MOBILE_SCHEMA_SQL);
  db.execSync(MOBILE_TRIGGERS_SQL);
  runMigrations(db);

  // Persist the shared device id into this source DB's sync_state so the engine
  // (which reads it for HLC origin) uses ONE identity across all source DBs.
  const deviceId = getDeviceId();
  db.runSync(
    "INSERT INTO sync_state (key, value) VALUES ('device_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    deviceId,
  );

  const engine = new SyncEngine(createExpoSyncDb(db), deviceId);
  const handle: SourceHandle = { db, engine, workspaceId };
  _sources.set(workspaceId, handle);
  return handle;
}

/**
 * Select the active source. Opens its DB/engine (lazily, cached) and persists
 * the choice. Subsequent getDb()/getEngine() calls resolve to this source, so
 * the whole app re-scopes. Returns the source handle.
 */
export function setActiveSource(workspaceId: string): { db: SQLite.SQLiteDatabase; engine: SyncEngine } {
  const handle = openSource(workspaceId);
  _activeWorkspaceId = workspaceId;
  metaSet("active_source", workspaceId);
  return { db: handle.db, engine: handle.engine };
}

/** True once a source has been selected (and its DB is usable). */
export function hasActiveSource(): boolean {
  return getActiveSource() != null;
}

function activeHandle(): SourceHandle {
  const ws = getActiveSource();
  if (!ws) {
    throw new Error("No active sync source selected. Call setActiveSource(workspaceId) first.");
  }
  return openSource(ws);
}

export function getDb(): SQLite.SQLiteDatabase {
  return activeHandle().db;
}

export function getEngine(): SyncEngine {
  return activeHandle().engine;
}

/**
 * One-time cleanup: the pre-multi-source single DB (`cairn-mobile.db`) is
 * obsolete under one-DB-per-source. Its contents are fully re-derivable from the
 * desktop oplog once a source is picked, so we just delete it (no adoption). The
 * `legacy_dropped` meta flag makes this run exactly once.
 */
function dropLegacyDb(): void {
  if (metaGet("legacy_dropped") === "1") return;
  try {
    SQLite.deleteDatabaseSync(LEGACY_DB_NAME);
  } catch {
    // Not present (fresh install) or already gone — fine.
  }
  metaSet("legacy_dropped", "1");
}

/**
 * Bootstrap at app launch. Ensures the meta DB exists, drops the obsolete
 * legacy single DB once, and — if a source was previously selected — re-opens it
 * so getDb()/getEngine() work immediately. Does NOT throw when no source is
 * selected yet (fresh install / just-upgraded) — the app shows the source
 * picker in that case. Returns whether an active source is ready.
 */
export function initDatabase(): { hasSource: boolean } {
  metaDb(); // ensure meta table
  dropLegacyDb(); // one-time removal of pre-multi-source DB
  const ws = getActiveSource();
  if (ws) {
    openSource(ws); // warm the cache so first query is instant
    return { hasSource: true };
  }
  return { hasSource: false };
}

