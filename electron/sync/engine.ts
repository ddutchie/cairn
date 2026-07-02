/**
 * Cairn Sync — engine (Phase 0 spike)
 *
 * Proves the replication protocol from docs/plans/mobile-app-viability.md §4:
 *   - HLC-stamped, append-only oplog as the source of truth for changes
 *   - tombstones (delete-safe: no resurrection)
 *   - convergent reconcile: replay peer ops in HLC order
 *   - LWW per row, with conflict-copy for note bodies
 *   - set-union merge for JSON-array fields (tag_ids, linked_*_ids, blocked_by_ids)
 *   - idempotent replay (same op twice = no-op)
 *
 * Scope: 2 personal devices, single user (see plan §4 scope simplification) —
 * so LWW + conflict-copy is sufficient; no CRDTs.
 */

import type Database from "better-sqlite3";
import { Hlc, compareHlc } from "./hlc";
import { SYNCABLE_TABLES, type SyncableTable } from "./schema";

export type Op = "put" | "delete";

export interface OplogEntry {
  hlc: string;
  origin: string;
  entity: SyncableTable;
  entity_id: string;
  op: Op;
  payload: Record<string, unknown> | null; // full row snapshot for 'put'
}

/** JSON-array columns merged by set-union instead of last-writer-wins. */
const ARRAY_MERGE_COLUMNS: Record<string, string[]> = {
  notes: ["tag_ids", "linked_note_ids", "linked_card_ids"],
  task_cards: ["tag_ids", "linked_note_ids", "blocked_by_ids"],
  projects: ["tag_ids"],
};

/** Column carrying free-text body that gets conflict-copy treatment. */
const BODY_COLUMN: Partial<Record<SyncableTable, string>> = {
  notes: "content",
};

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function readRow(db: Database.Database, table: string, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function parseArray(val: unknown): string[] {
  if (typeof val !== "string" || val.length === 0) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function unionArrays(a: unknown, b: unknown): string {
  const set = new Set<string>([...parseArray(a), ...parseArray(b)]);
  // Sort for deterministic serialization so both devices converge byte-for-byte,
  // not just set-equal.
  return JSON.stringify([...set].sort());
}

/**
 * SyncEngine wraps a single device's DB. All local mutations that should
 * replicate MUST go through put()/remove() so they are HLC-stamped and logged.
 */
export class SyncEngine {
  readonly db: Database.Database;
  readonly deviceId: string;
  private hlc: Hlc;

  constructor(db: Database.Database, deviceId: string, opts?: { now?: () => number }) {
    this.db = db;
    this.deviceId = deviceId;

    const stored = this.getState("hlc");
    this.hlc = new Hlc(deviceId, { last: stored ?? undefined, now: opts?.now });
    this.setState("device_id", deviceId);
    this.persistHlc();
  }

  // ── sync_state helpers ────────────────────────────────────────────────
  private getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private persistHlc(): void {
    this.setState("hlc", this.hlc.getState());
  }

  /** Enable/disable the capture-trigger suppression flag (see migration v26). */
  private setSuppress(on: boolean): void {
    this.setState("suppress", on ? "1" : "0");
  }

  // ── drain staged changes into the HLC-stamped oplog ───────────────────

  /**
   * Convert rows staged in sync_pending (by the capture triggers, migration
   * v26) into HLC-stamped sync_oplog entries. This is the write-path-agnostic
   * hook: renderer IPC, MCP tools, and the file-watcher all land in
   * sync_pending, and this single method turns them into replicable ops.
   *
   * Coalesces multiple pending changes to the same row into one op (the row's
   * final state), so a burst of edits produces a single oplog entry.
   */
  drainPending(): number {
    const pending = this.db
      .prepare("SELECT seq, entity, entity_id, op FROM sync_pending ORDER BY seq ASC")
      .all() as Array<{ seq: number; entity: SyncableTable; entity_id: string; op: Op }>;
    if (pending.length === 0) return 0;

    // Last op per (entity, id) wins the coalesce.
    const latest = new Map<string, { entity: SyncableTable; entity_id: string; op: Op }>();
    let maxSeq = 0;
    for (const p of pending) {
      latest.set(`${p.entity}\u0000${p.entity_id}`, { entity: p.entity, entity_id: p.entity_id, op: p.op });
      if (p.seq > maxSeq) maxSeq = p.seq;
    }

    const run = this.db.transaction(() => {
      this.setSuppress(true); // our hlc/deleted_at writes below must not re-stage
      for (const { entity, entity_id, op } of latest.values()) {
        const stamp = this.hlc.send();
        const row = readRow(this.db, entity, entity_id);
        if (op === "delete" || !row) {
          // Row gone (hard delete) or explicitly tombstoned.
          this.db.prepare(`UPDATE ${entity} SET deleted_at = COALESCE(deleted_at, ?), hlc = ? WHERE id = ?`).run(nowIso(), stamp, entity_id);
          this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id, op: "delete", payload: null });
        } else {
          this.db.prepare(`UPDATE ${entity} SET hlc = ? WHERE id = ?`).run(stamp, entity_id);
          this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id, op: "put", payload: readRow(this.db, entity, entity_id) ?? null });
        }
      }
      this.db.prepare("DELETE FROM sync_pending WHERE seq <= ?").run(maxSeq);
      this.setSuppress(false);
      this.persistHlc();
    });
    run();
    return latest.size;
  }

  // ── local mutations (direct API — used by tests and non-triggered paths) ─

  /**
   * Upsert a row locally and log it. `values` is a partial column map (must
   * include `id`). Missing columns on insert fall back to existing row values.
   */
  put(entity: SyncableTable, values: Record<string, unknown> & { id: string }): string {
    const stamp = this.hlc.send();
    this.persistHlc();
    this.setSuppress(true); // direct API manages its own oplog; don't double-stage
    const existing = readRow(this.db, entity, values.id);
    const cols = tableColumns(this.db, entity);

    const merged: Record<string, unknown> = { ...(existing ?? {}), ...values };
    merged.hlc = stamp;
    merged.deleted_at = null; // a put revives a tombstoned row

    const present = cols.filter((c) => c in merged);
    const placeholders = present.map(() => "?").join(", ");
    const assignments = present.map((c) => `"${c}" = excluded."${c}"`).join(", ");
    this.db
      .prepare(
        `INSERT INTO ${entity} (${present.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${assignments}`,
      )
      .run(...present.map((c) => merged[c] as never));

    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: values.id, op: "put", payload: readRow(this.db, entity, values.id) ?? null });
    this.setSuppress(false);
    return stamp;
  }

  /** Tombstone a row locally and log it (delete-safe — the row is not removed). */
  remove(entity: SyncableTable, id: string): string {
    const stamp = this.hlc.send();
    this.persistHlc();
    this.setSuppress(true);
    this.db.prepare(`UPDATE ${entity} SET deleted_at = ?, hlc = ? WHERE id = ?`).run(nowIso(), stamp, id);
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: id, op: "delete", payload: null });
    this.setSuppress(false);
    return stamp;
  }

  private appendOplog(e: OplogEntry): void {
    this.db
      .prepare(
        `INSERT INTO sync_oplog (hlc, origin, entity, entity_id, op, payload, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.hlc, e.origin, e.entity, e.entity_id, e.op, e.payload ? JSON.stringify(e.payload) : null, nowIso());
  }

  // ── export / import ───────────────────────────────────────────────────

  /** All oplog entries this device has, in HLC order (for a full peer sync). */
  exportOplog(): OplogEntry[] {
    const rows = this.db.prepare("SELECT * FROM sync_oplog ORDER BY seq ASC").all() as Array<{
      hlc: string;
      origin: string;
      entity: SyncableTable;
      entity_id: string;
      op: Op;
      payload: string | null;
    }>;
    return rows.map((r) => ({
      hlc: r.hlc,
      origin: r.origin,
      entity: r.entity,
      entity_id: r.entity_id,
      op: r.op,
      payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
    }));
  }

  /**
   * Apply a batch of peer oplog entries. Convergent: entries are sorted by HLC
   * and each is reconciled against local state with LWW + conflict-copy.
   * Idempotent: an entry whose HLC is <= the row's current HLC is skipped.
   */
  applyRemote(entries: OplogEntry[]): { conflictCopies: string[] } {
    const conflictCopies: string[] = [];
    const sorted = [...entries].sort((a, b) => compareHlc(a.hlc, b.hlc));

    const run = this.db.transaction(() => {
      this.setSuppress(true); // reconcile writes must not be re-captured as local ops
      for (const entry of sorted) {
        this.hlc.receive(entry.hlc);
        const copyId = this.reconcileOne(entry);
        if (copyId) conflictCopies.push(copyId);
      }
      this.setSuppress(false);
      this.persistHlc();
    });
    run();
    return { conflictCopies };
  }

  private reconcileOne(entry: OplogEntry): string | null {
    const { entity, entity_id, op, hlc } = entry;
    const local = readRow(this.db, entity, entity_id);
    const localHlc = (local?.hlc as string | undefined) ?? null;

    // Idempotency / staleness guard: never let an older op overwrite a newer row.
    if (localHlc && compareHlc(hlc, localHlc) <= 0) {
      return null;
    }

    // Record the remote op in our own oplog too, so a third party syncing from
    // us later receives it (gossip). Skip if we already have this exact op.
    this.recordForwardedOp(entry);

    if (op === "delete") {
      if (local) {
        this.db.prepare(`UPDATE ${entity} SET deleted_at = ?, hlc = ? WHERE id = ?`).run(nowIso(), hlc, entity_id);
      } else {
        // Delete arrived before we ever saw the row: create a tombstone shell so
        // a later 'put' with an older HLC can't resurrect it.
        this.insertTombstoneShell(entity, entity_id, hlc);
      }
      return null;
    }

    // op === 'put'
    const remote = entry.payload ?? {};
    let conflictCopyId: string | null = null;

    if (local && !local.deleted_at) {
      // Body conflict detection (notes.content). Both sides changed since we
      // diverged and the bodies differ → keep both via a conflict copy.
      const bodyCol = BODY_COLUMN[entity];
      if (bodyCol && local[bodyCol] !== remote[bodyCol] && remote[bodyCol] != null && local[bodyCol] != null) {
        conflictCopyId = this.makeConflictCopy(entity, local);
      }
    }

    const merged = this.mergeForPut(entity, local, remote, hlc);

    // If array-union produced a value the remote payload did NOT contain, the
    // merged row is a new logical state. Re-stamp it with a fresh local HLC and
    // log it so the union propagates back to peers (otherwise the two devices
    // diverge: each keeps only its own additions).
    if (local && this.unionChangedBeyondRemote(entity, remote, merged)) {
      const stamp = this.hlc.send();
      this.persistHlc();
      merged.hlc = stamp;
      this.writeRow(entity, merged);
      this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: entity_id, op: "put", payload: readRow(this.db, entity, entity_id) ?? null });
    } else {
      this.writeRow(entity, merged);
    }
    return conflictCopyId;
  }

  /** True if any array-merge column in `merged` has elements absent from `remote`. */
  private unionChangedBeyondRemote(
    entity: SyncableTable,
    remote: Record<string, unknown>,
    merged: Record<string, unknown>,
  ): boolean {
    for (const arrCol of ARRAY_MERGE_COLUMNS[entity] ?? []) {
      const remoteSet = new Set(parseArray(remote[arrCol]));
      const mergedArr = parseArray(merged[arrCol]);
      if (mergedArr.some((v) => !remoteSet.has(v))) return true;
    }
    return false;
  }

  private mergeForPut(
    entity: SyncableTable,
    local: Record<string, unknown> | undefined,
    remote: Record<string, unknown>,
    hlc: string,
  ): Record<string, unknown> {
    const cols = tableColumns(this.db, entity);
    // Base = remote row (it won LWW). Then union array columns with local.
    const merged: Record<string, unknown> = {};
    for (const c of cols) merged[c] = c in remote ? remote[c] : local?.[c];

    if (local) {
      for (const arrCol of ARRAY_MERGE_COLUMNS[entity] ?? []) {
        if (cols.includes(arrCol)) merged[arrCol] = unionArrays(local[arrCol], remote[arrCol]);
      }
    }
    merged.hlc = hlc;
    merged.deleted_at = remote.deleted_at ?? null;
    return merged;
  }

  private writeRow(entity: string, row: Record<string, unknown>): void {
    const cols = tableColumns(this.db, entity).filter((c) => c in row);
    const placeholders = cols.map(() => "?").join(", ");
    const assignments = cols.map((c) => `"${c}" = excluded."${c}"`).join(", ");
    this.db
      .prepare(
        `INSERT INTO ${entity} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${assignments}`,
      )
      .run(...cols.map((c) => row[c] as never));
  }

  private insertTombstoneShell(entity: SyncableTable, id: string, hlc: string): void {
    // Insert a minimal row that satisfies NOT NULL constraints, already tombstoned.
    const cols = db_cols_notnull(this.db, entity);
    const row: Record<string, unknown> = { id, hlc, deleted_at: nowIso() };
    for (const c of cols) if (!(c.name in row)) row[c.name] = c.dflt ?? "";
    this.writeRow(entity, row);
  }

  private makeConflictCopy(entity: SyncableTable, local: Record<string, unknown>): string {
    // Clone the LOCAL version as a new row so the incoming remote can win in place.
    const copyId = `${local.id}_conflict_${this.deviceId}_${Date.now().toString(36)}`;
    const clone: Record<string, unknown> = { ...local, id: copyId };
    if (entity === "notes") {
      clone.title = `${local.title ?? "Untitled"} (conflicted copy — ${this.deviceId})`;
    }
    const stamp = this.hlc.send();
    clone.hlc = stamp;
    clone.deleted_at = null;
    this.writeRow(entity, clone);
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: copyId, op: "put", payload: readRow(this.db, entity, copyId) ?? null });
    return copyId;
  }

  private recordForwardedOp(entry: OplogEntry): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sync_oplog WHERE hlc = ? AND entity = ? AND entity_id = ?")
      .get(entry.hlc, entry.entity, entry.entity_id);
    if (!exists) this.appendOplog(entry);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function db_cols_notnull(db: Database.Database, table: string): Array<{ name: string; dflt: unknown }> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  return cols.filter((c) => c.notnull === 1).map((c) => ({ name: c.name, dflt: c.dflt_value }));
}

export { SYNCABLE_TABLES };
