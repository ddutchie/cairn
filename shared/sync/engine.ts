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

import type { SyncDb } from "./db-adapter";
import { Hlc, compareHlc, decodeHlc, encodeHlc } from "./hlc";
import { SYNCABLE_TABLES, type SyncableTable } from "./schema";
import { inspectConflict } from "./conflict";

export type Op = "put" | "delete";
export type ObservationFrontier = Record<string, string>;

/**
 * How reconcile resolved a single incoming op (plan §4 Phase 4a). Recorded so a
 * surprise vanish/resurrect is explainable after the fact:
 *
 * - `applied`       — the op changed local state cleanly.
 * - `conflict-copy` — the op applied, and divergent local content was preserved
 *                     as a `_conflict_…` row rather than being overwritten.
 * - `delete-won`    — a delete prevailed: either an incoming put was refused
 *                     because it could not prove it observed the delete, or an
 *                     incoming delete tombstoned a live local row.
 * - `skipped-stale` — the op was ignored as older than, or already superseded
 *                     by, local state (includes plain idempotent re-delivery).
 */
export type SyncOutcome = "applied" | "conflict-copy" | "delete-won" | "skipped-stale";

/** One reconcile decision, as surfaced to the UI. */
export interface SyncActivityRow {
  seq: number;
  at: string;
  entity: SyncableTable;
  entity_id: string;
  op: Op;
  hlc: string;
  origin: string;
  outcome: SyncOutcome;
  conflict_copy_id: string | null;
  /**
   * The row's current title/name, when it still exists. Resolved on read rather
   * than snapshotted so it tracks renames; null for a row that is gone or has
   * no title column — the UI should fall back to a generic label, not an id.
   */
  title: string | null;
  /** True when this device authored the op (an echo of our own change). */
  isSelf: boolean;
  /**
   * Which side of a conflict the copy holds. `local` = our version was set
   * aside so the peer's could land; `remote` = the peer's refused edit was set
   * aside. For a recovery UI, which side was preserved is the whole question.
   */
  conflict_side: "local" | "remote" | null;
}

/** A peer-deleted row that still holds content, so it can be restored. */
export interface RestorableRow {
  entity: SyncableTable;
  entity_id: string;
  title: string | null;
  /** When the winning delete was authored (from its HLC), not when we applied it. */
  deleted_at: string | null;
  delete_origin: string | null;
}

/** Why a restore was refused. Surfaced so the UI never shows a silent no-op. */
export type RestoreRefusal =
  | "missing" // no such row
  | "live" // already not deleted
  | "shell" // tombstone placeholder — we never received the content
  | "conflict-copy" // resolve via the conflict UI, not restore
  | "orphaned" // its project/workspace is gone, so reviving would diverge
  | "self-deleted" // this device authored the delete
  | "no-delete-record" // tombstoned, but sync holds no delete metadata for it
  | "preserved-as-copy"; // a live conflict copy already holds this content — resolve that instead

export type RestoreResult =
  | { restored: true; hlc: string }
  | { restored: false; reason: RestoreRefusal };

/**
 * Ring-buffer bound for `sync_activity`. The log is a debugging/recovery aid,
 * not an audit trail, so it is capped rather than retained forever.
 */
export const SYNC_ACTIVITY_LIMIT = 500;

/**
 * Only decisive outcomes are logged. Idle syncs re-read a peer's whole compacted
 * oplog every cycle, so recording `skipped-stale` would flood the ring buffer
 * with no-ops and evict the destructive events the log exists to explain.
 */
const LOGGED_OUTCOMES: ReadonlySet<SyncOutcome> = new Set<SyncOutcome>([
  "applied",
  "conflict-copy",
  "delete-won",
]);

/** How far back a peer delete is still offered for recovery. */
const RESTORABLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Oplog wire-protocol version this build writes and understands.
 *
 * The format was unversioned through v2.6.1; that implicit shape is **protocol
 * 1**, and a missing `v` is read as 1 so legacy entries need no rewrite. Bump
 * this only for a wire change that a peer must understand to stay convergent
 * (a new causal field, a changed reconciliation rule). Additive optional fields
 * that older peers can safely ignore (as `observed`/`tombstone` were) do NOT
 * need a bump.
 *
 * Protocol 2 (v2.6.13/mobile 0.1.6): added `user_style` to the syncable
 * entity set. An older peer is not *broken* by this — `applyRemote` skips
 * unknown entities and convergence is unaffected — but an old desktop lacks
 * the `user_style` capture triggers, so it cannot PUBLISH the writing style
 * to a new mobile at all. Bumping stamps those peers as `behind`, surfacing
 * the "device needs updating" hint so the user knows to update the desktop
 * for writing-style sync to work.
 *
 * Protocol 3 (v3.0.2/mobile 0.1.7): delete-wins now only preserves a
 * divergent note body as a live "conflicted copy" when the losing put is
 * *newer* (higher HLC) than the winning delete. An older stale snapshot
 * (e.g. desktop's last state while it was closed, read by mobile after a
 * mobile delete) is just the pre-delete state, not a concurrent edit after
 * the delete — keeping it as a live recreation is the "mobile tried to
 * recreate the desktop note after it was deleted" and "desktop showed a
 * sync conflict instead of deleting the checklist note" bug. The old rule
 * kept every divergent body, even when the put was older than the delete,
 * which made every offline checkbox toggle look like a conflict.
 *
 * The point of stamping it now, while only two historical shapes exist, is that
 * a peer can be *told* it is behind instead of us inferring capability from
 * which optional fields happen to be present.
 */
export const SYNC_PROTOCOL_VERSION = 3;

/** sync_state key prefix for the highest protocol version seen from a peer. */
const PEER_PROTOCOL_PREFIX = "peer_protocol:";

/** A peer whose observed protocol version differs from this build's. */
export interface PeerProtocol {
  deviceId: string;
  version: number;
  /** True when the peer is writing an OLDER protocol than this build enforces. */
  behind: boolean;
}

export interface OplogEntry {
  hlc: string;
  origin: string;
  entity: SyncableTable;
  entity_id: string;
  op: Op;
  payload: Record<string, unknown> | null; // full row snapshot for 'put'
  /** Exact delete HLC observed for this target when the op was authored. */
  observed?: ObservationFrontier;
  /** Durable delete history carried by a compacted live put for late peers. */
  tombstone?: { hlc: string; origin: string };
  /**
   * Wire-protocol version (SYNC_PROTOCOL_VERSION). Optional on the type so a
   * pre-versioning entry deserialises cleanly; absence is treated as 1.
   */
  v?: number;
}

interface RowBase {
  base_body: string | null;
  delete_hlc: string | null;
  delete_origin: string | null;
  put_hlc: string | null;
  put_observed: string | null;
  /**
   * The HLC of a delete THIS device authored. `delete_origin` is the origin of
   * the *winning* delete and is overwritten when a higher-HLC peer delete
   * arrives, so it cannot answer "did I delete this?" — when two devices delete
   * the same row independently, the first one's own delete gets attributed to
   * the peer. This column records local authorship durably instead.
   */
  local_delete_hlc: string | null;
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

/**
 * Normalize a note body for sync comparison. Mirrors the import ledger's
 * bodyHash trimming (trailing whitespace) plus CRLF normalization so a
 * file round-trip (matter.stringify adds a trailing newline) or a Windows
 * CRLF import doesn't look like a divergent edit and spawn a spurious
 * conflict copy. Only used for equality checks — stored bodies stay raw.
 */
function normalizeForSyncBody(value: unknown): string {
  const s = value == null ? "" : String(value);
  // CRLF → LF for cross-platform parity (see merge3.ts splitLines)
  // then trim trailing whitespace/newlines (matter.stringify adds one)
  return s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

function syncBodiesEqual(a: unknown, b: unknown): boolean {
  return normalizeForSyncBody(a) === normalizeForSyncBody(b);
}

function tableColumns(db: SyncDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function readRow(db: SyncDb, table: string, id: string): Record<string, unknown> | undefined {
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
  readonly db: SyncDb;
  readonly deviceId: string;
  private hlc: Hlc;
  /**
   * Injectable clock, shared with the HLC. Used for wall-clock comparisons such
   * as the restore window so they stay deterministic under a test clock rather
   * than silently reading the real `Date.now()`.
   */
  private now: () => number;
  /** Per-instance FK metadata cache (see `foreignKeys`). */
  private fkCache = new Map<string, Array<{ table: string; from: string; to: string | null }>>();

  constructor(db: SyncDb, deviceId: string, opts?: { now?: () => number }) {
    this.db = db;
    this.deviceId = deviceId;
    this.now = opts?.now ?? (() => Date.now());

    this.ensureBaseTable();
    this.ensureOplogObservedColumn();
    this.ensureActivityTable();
    const stored = this.getState("hlc");
    this.hlc = new Hlc(deviceId, { last: stored ?? undefined, now: opts?.now });
    this.setState("device_id", deviceId);
    // One-time recovery/upgrade passes. Both are idempotent and read-only after
    // the first run, so gate them behind a sync_state flag (mirrors `backfilled`)
    // instead of re-scanning every table on every app start. Ops authored after
    // the upgrade already write the observed/delete metadata on the live paths.
    if (this.getState("recovery_done") !== "1") {
      this.backfillDurableTombstones();
      this.setState("recovery_done", "1");
    }
    this.persistHlc();
  }

  /**
   * Per-row sync metadata. Stores the body-column value at the last point
   * this device agreed with the remote lineage (the "common ancestor" from the
   * plan §5). A genuine body conflict is a classic 3-way disagreement: local
   * changed the body since the ancestor AND the incoming remote also changed it
   * AND the two differ. Recording the ancestor value (not just an HLC) avoids
   * false positives on one-sided edits, where only one side moved from the
   * ancestor, plus durable delete and current-put causal metadata. The table is
   * also created by platform migrations; this guard keeps older databases safe.
   */
  private ensureBaseTable(): void {
    // An early experimental shape had a NOT NULL `base_hlc` column. Rebuild only
    // that obsolete shape because its constraint prevents additive upserts.
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_row_base'")
      .get();
    if (existing) {
      const cols = (this.db.prepare("PRAGMA table_info(sync_row_base)").all() as { name: string }[]).map((c) => c.name);
      if (cols.includes("base_hlc")) {
        this.db.prepare("DROP TABLE sync_row_base").run();
      }
    }
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS sync_row_base (
           entity     TEXT NOT NULL,
           entity_id  TEXT NOT NULL,
           base_body  TEXT,
           delete_hlc TEXT,
           delete_origin TEXT,
           put_hlc TEXT,
           put_observed TEXT,
           local_delete_hlc TEXT,
           PRIMARY KEY (entity, entity_id)
         )`,
      )
      .run();

    const cols = (this.db.prepare("PRAGMA table_info(sync_row_base)").all() as { name: string }[]).map((c) => c.name);
    for (const [name, ddl] of [
      ["base_body", "base_body TEXT"],
      ["delete_hlc", "delete_hlc TEXT"],
      ["delete_origin", "delete_origin TEXT"],
      ["put_hlc", "put_hlc TEXT"],
      ["put_observed", "put_observed TEXT"],
      ["local_delete_hlc", "local_delete_hlc TEXT"],
    ] as const) {
      if (!cols.includes(name)) this.db.prepare(`ALTER TABLE sync_row_base ADD COLUMN ${ddl}`).run();
    }
  }

  private ensureOplogObservedColumn(): void {
    const cols = (this.db.prepare("PRAGMA table_info(sync_oplog)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("observed")) this.db.prepare("ALTER TABLE sync_oplog ADD COLUMN observed TEXT").run();
  }

  /**
   * Reconcile decision log (plan §4 Phase 4a). Engine-owned and created lazily
   * so both platforms get it without a migration — the table is pure derived
   * telemetry, so losing it is never a data-integrity problem.
   */
  private ensureActivityTable(): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS sync_activity (
           seq              INTEGER PRIMARY KEY,
           at               TEXT NOT NULL,
           entity           TEXT NOT NULL,
           entity_id        TEXT NOT NULL,
           op               TEXT NOT NULL,
           hlc              TEXT NOT NULL,
           origin           TEXT NOT NULL,
           outcome          TEXT NOT NULL,
           conflict_copy_id TEXT
         )`,
      )
      .run();
    // No secondary index on `seq`: it is the INTEGER PRIMARY KEY (the rowid), so
    // SQLite already scans it in either direction. A second b-tree would just
    // double the write cost on the reconcile path.
  }

  /** The common-ancestor body value for a row, or undefined if none recorded. */
  private getBaseBody(entity: string, id: string): string | null | undefined {
    const row = this.db
      .prepare("SELECT base_body FROM sync_row_base WHERE entity = ? AND entity_id = ?")
      .get(entity, id) as { base_body: string | null } | undefined;
    return row ? row.base_body : undefined;
  }

  private setBaseBody(entity: string, id: string, body: unknown): void {
    const val = body == null ? null : String(body);
    this.db
      .prepare(
        `INSERT INTO sync_row_base (entity, entity_id, base_body) VALUES (?, ?, ?)
         ON CONFLICT(entity, entity_id) DO UPDATE SET base_body = excluded.base_body`,
      )
      .run(entity, id, val);
  }

  private getRowBase(entity: string, id: string): RowBase | undefined {
    return this.db
      .prepare(
        `SELECT base_body, delete_hlc, delete_origin, put_hlc, put_observed, local_delete_hlc
         FROM sync_row_base WHERE entity = ? AND entity_id = ?`,
      )
      .get(entity, id) as RowBase | undefined;
  }

  /**
   * Record that THIS device authored a delete for a row. Kept separate from
   * `delete_origin` (which tracks the winning delete and gets overwritten by a
   * higher-HLC peer delete) so the recovery list never nags the user about a
   * deletion they performed themselves.
   */
  private markLocalDelete(entity: string, id: string, hlc: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_row_base (entity, entity_id, local_delete_hlc)
         VALUES (?, ?, ?)
         ON CONFLICT(entity, entity_id) DO UPDATE SET local_delete_hlc = excluded.local_delete_hlc`,
      )
      .run(entity, id, hlc);
  }

  private setDeleteVersion(entity: string, id: string, deleteHlc: string, deleteOrigin: string): RowBase {
    const current = this.getRowBase(entity, id);
    if (!current?.delete_hlc || compareHlc(deleteHlc, current.delete_hlc) > 0) {
      this.db
        .prepare(
          `INSERT INTO sync_row_base (entity, entity_id, delete_hlc, delete_origin)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(entity, entity_id) DO UPDATE SET
             delete_hlc = excluded.delete_hlc,
             delete_origin = excluded.delete_origin`,
        )
        .run(entity, id, deleteHlc, deleteOrigin);
    }
    return this.getRowBase(entity, id)!;
  }

  private setPutVersion(entity: string, id: string, putHlc: string, observed: ObservationFrontier): void {
    this.db
      .prepare(
        `INSERT INTO sync_row_base (entity, entity_id, put_hlc, put_observed)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entity, entity_id) DO UPDATE SET
           put_hlc = excluded.put_hlc,
           put_observed = excluded.put_observed`,
      )
      .run(entity, id, putHlc, JSON.stringify(observed));
  }

  private backfillDurableTombstones(): void {
    for (const entity of SYNCABLE_TABLES) {
      const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(entity);
      if (!exists) continue;
      const bodyCol = BODY_COLUMN[entity];
      const rows = this.db
        .prepare(`SELECT * FROM ${entity} WHERE deleted_at IS NOT NULL AND hlc IS NOT NULL`)
        .all() as Array<Record<string, unknown> & { id: string; hlc: string }>;
      for (const row of rows) {
        if (bodyCol && this.getBaseBody(entity, row.id) === undefined) this.setBaseBody(entity, row.id, row[bodyCol]);
        // A legacy/invalid row HLC must not throw here — it would abort the whole
        // engine construction. Canonicalize the stamp exactly like backfill()
        // does for live rows, then use it for both delete-state helpers.
        const stamp = validStoredHlc(row.hlc)
          ?? backfillStamp(row.updated_at, row.created_at, this.deviceId);
        this.setDeleteVersion(entity, row.id, stamp, decodeHlc(stamp).deviceId);
        this.markObservedDelete(entity, row.id, stamp);
      }
    }
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

  private deleteObservationKey(entity: string, id: string): string {
    return `delete:${entity}\u0000${id}`;
  }

  private markObservedDelete(entity: string, id: string, hlc: string): void {
    const key = `observed-${this.deleteObservationKey(entity, id)}`;
    const current = this.getState(key);
    if (!current || compareHlc(hlc, current) > 0) this.setState(key, hlc);
  }

  private observationSnapshot(entity: string, id: string): ObservationFrontier {
    const key = this.deleteObservationKey(entity, id);
    const hlc = this.getState(`observed-${key}`);
    return hlc ? { [key]: hlc } : {};
  }

  private observesDelete(frontier: ObservationFrontier | undefined, entity: string, id: string, hlc: string): boolean {
    return frontier?.[this.deleteObservationKey(entity, id)] === hlc;
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

    // A hard-deleted row leaves no tombstone, so we may need to insert a
    // tombstone SHELL (placeholder FK columns) to keep the staleness guard armed
    // against a later stale peer 'put'. Shells legitimately violate FKs, so
    // disable enforcement around the transaction (the pragma is a no-op inside
    // one) exactly as applyRemote does. Restored in `finally`.
    const fkRow = this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    const fkWasOn = fkRow?.foreign_keys === 1;
    if (fkWasOn) this.db.prepare("PRAGMA foreign_keys = OFF").run();

    const run = this.db.transaction(() => {
      this.setSuppress(true); // our hlc/deleted_at writes below must not re-stage
      for (const { entity, entity_id, op } of latest.values()) {
        const stamp = this.hlc.send();
        const observed = this.observationSnapshot(entity, entity_id);
        const row = readRow(this.db, entity, entity_id);
        if (op === "delete" || !row) {
          // Row gone (hard delete) or explicitly tombstoned.
          const upd = this.db
            .prepare(`UPDATE ${entity} SET deleted_at = COALESCE(deleted_at, ?), hlc = ? WHERE id = ?`)
            .run(nowIso(), stamp, entity_id) as { changes?: number };
          // Desktop's q.deleteNote does a physical `DELETE FROM notes`, so by the
          // time we drain the staged 'delete' the row is already gone and the
          // UPDATE above matches zero rows — leaving NO local tombstone. Without a
          // tombstone, a later peer 'put' with an OLDER HLC hits reconcileOne with
          // local=undefined (localHlc=null), bypasses the staleness guard, and
          // RESURRECTS the deleted row. Insert a tombstone shell (same as the
          // delete-arrives-before-insert case) so the staleness guard trips and
          // the stale put stays dead. FK columns on the shell are placeholders;
          // the row is a tombstone and never read as live data.
          if ((upd.changes ?? 0) === 0) this.insertTombstoneShell(entity, entity_id, stamp);
          this.setDeleteVersion(entity, entity_id, stamp, this.deviceId);
          this.markLocalDelete(entity, entity_id, stamp);
          this.markObservedDelete(entity, entity_id, stamp);
          this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id, op: "delete", payload: null, observed });
        } else {
          this.db.prepare(`UPDATE ${entity} SET hlc = ? WHERE id = ?`).run(stamp, entity_id);
          // Reuse the already-fetched row (with the new hlc) for the payload
          // instead of a second readRow SELECT — the UPDATE only changed hlc.
          this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id, op: "put", payload: { ...row, hlc: stamp }, observed });
        }
        // Establish the conflict ancestor the FIRST time a row is published, so
        // a fresh row has a baseline. We must NOT advance an existing ancestor
        // here: a later local edit has to remain "changed vs ancestor" so a
        // genuinely concurrent remote edit is still detected as a conflict. The
        // ancestor advances only at real sync points — applying a remote op, or
        // receiving our own op echoed back (see reconcileOne).
        const bodyCol = BODY_COLUMN[entity];
        if (bodyCol && row && this.getBaseBody(entity, entity_id) === undefined) {
          this.setBaseBody(entity, entity_id, row[bodyCol]);
        }
        if (op === "put" && row) this.setPutVersion(entity, entity_id, stamp, observed);
      }
      this.db.prepare("DELETE FROM sync_pending WHERE seq <= ?").run(maxSeq);
      this.setSuppress(false);
      this.persistHlc();
    });
    try {
      run();
    } finally {
      if (fkWasOn) this.db.prepare("PRAGMA foreign_keys = ON").run();
    }
    return latest.size;
  }

  /**
   * One-time backfill: seed the oplog with a coalesced `put` for every existing
   * live (non-tombstoned) row across all syncable tables.
   *
   * The oplog is a *changelog* — rows created before the engine started
   * capturing have no ops, so a fresh peer would never receive the existing
   * workspace. This walks the authoritative SQLite rows and logs one `put` each
   * so the whole current state propagates on first sync. Coalesced by design
   * (one op per row, not per historical edit), so the oplog stays proportional
   * to live-row count, not edit history.
   *
   * Idempotent: guarded by a `backfilled` flag in sync_state, so it runs once.
   * Returns the number of rows seeded (0 if already backfilled).
   */
  backfill(): number {
    if (this.getState("backfilled") === "1") return 0;

    let seeded = 0;
    const run = this.db.transaction(() => {
      this.setSuppress(true); // hlc writes below must not re-stage via triggers
      for (const entity of SYNCABLE_TABLES) {
        // Skip tables that don't exist on this platform (e.g. mobile subset).
        const exists = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(entity);
        if (!exists) continue;

        const rows = this.db
          .prepare(`SELECT * FROM ${entity} WHERE deleted_at IS NULL`)
          .all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const id = row.id as string;
          if (id == null) continue;
          // Preserve an authoritative row HLC. Legacy rows without one get a
          // deterministic ordering hint from updated_at/created_at, never from
          // the current wall clock, and carry no causal delete observation.
          const stamp = validStoredHlc(row.hlc)
            ?? backfillStamp(row.updated_at, row.created_at, this.deviceId);
          const origin = decodeHlc(stamp).deviceId;
          this.hlc.receive(stamp);
          if (row.hlc !== stamp) this.db.prepare(`UPDATE ${entity} SET hlc = ? WHERE id = ?`).run(stamp, id);
          const observed: ObservationFrontier = {};
          this.appendOplog({ hlc: stamp, origin, entity, entity_id: id, op: "put", payload: { ...row, hlc: stamp }, observed });
          const bodyCol = BODY_COLUMN[entity];
          if (bodyCol && this.getBaseBody(entity, id) === undefined) this.setBaseBody(entity, id, row[bodyCol]);
          this.setPutVersion(entity, id, stamp, observed);
          seeded++;
        }
      }
      this.setState("backfilled", "1");
      // Backfill captured the full current state of every syncable table, so any
      // rows staged in sync_pending before the first connect are now subsumed —
      // clear them so they don't drain into redundant oplog ops afterwards.
      this.db.prepare("DELETE FROM sync_pending").run();
      this.setSuppress(false);
      this.persistHlc();
    });
    run();
    return seeded;
  }

  // ── local mutations (direct API — used by tests and non-triggered paths) ─

  /**
   * Upsert a row locally and log it. `values` is a partial column map (must
   * include `id`). Missing columns on insert fall back to existing row values.
   */
  put(entity: SyncableTable, values: Record<string, unknown> & { id: string }): string {
    const stamp = this.hlc.send();
    const observed = this.observationSnapshot(entity, values.id);
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

    // Read back the stored row so the payload includes any DB-applied column
    // defaults (e.g. status) that `merged` may have omitted.
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: values.id, op: "put", payload: readRow(this.db, entity, values.id) ?? null, observed });
    // Establish the conflict ancestor the first time this row is published
    // (mirrors drainPending). Never advance an existing ancestor — a later
    // local edit must stay "changed vs ancestor" so a concurrent remote edit is
    // still caught.
    const bodyCol = BODY_COLUMN[entity];
    if (bodyCol && this.getBaseBody(entity, values.id) === undefined) {
      this.setBaseBody(entity, values.id, merged[bodyCol]);
    }
    this.setPutVersion(entity, values.id, stamp, observed);
    this.setSuppress(false);
    return stamp;
  }

  /** Tombstone a row locally and log it (delete-safe — the row is not removed). */
  remove(entity: SyncableTable, id: string): string {
    const stamp = this.hlc.send();
    const observed = this.observationSnapshot(entity, id);
    this.persistHlc();
    this.setSuppress(true);
    this.db.prepare(`UPDATE ${entity} SET deleted_at = ?, hlc = ? WHERE id = ?`).run(nowIso(), stamp, id);
    this.setDeleteVersion(entity, id, stamp, this.deviceId);
    this.markLocalDelete(entity, id, stamp);
    this.markObservedDelete(entity, id, stamp);
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: id, op: "delete", payload: null, observed });
    this.setSuppress(false);
    return stamp;
  }

  private appendOplog(e: OplogEntry): void {
    this.db
      .prepare(
         `INSERT INTO sync_oplog (hlc, origin, entity, entity_id, op, payload, observed, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.hlc, e.origin, e.entity, e.entity_id, e.op, e.payload ? JSON.stringify(e.payload) : null, e.observed ? JSON.stringify(e.observed) : null, nowIso());
  }

  // ── export / import ───────────────────────────────────────────────────

  /**
   * Compact the oplog in place: keep only the highest-HLC entry per
   * (entity, entity_id), dropping superseded ops. Safe because reconcile
   * applies ops in HLC order and the per-row staleness guard makes older ops
   * no-ops anyway — a peer only needs the latest snapshot of each row to
   * converge. This keeps the oplog (and the published .ndjson) proportional to
   * live-row count rather than growing with every edit.
   *
   * Returns the number of superseded rows removed.
   */
  compactOplog(): number {
    // For a stable HLC comparison in SQL we can't rely on lexical ordering of
    // the encoded HLC across all encodings, so resolve the winner per row via
    // the engine's compareHlc in JS, then delete everything else by seq.
    const rows = this.db
      .prepare("SELECT seq, hlc, entity, entity_id FROM sync_oplog")
      .all() as Array<{ seq: number; hlc: string; entity: SyncableTable; entity_id: string }>;
    if (rows.length === 0) return 0;

    const winnerSeq = new Map<string, { seq: number; hlc: string }>();
    for (const r of rows) {
      const key = `${r.entity}\u0000${r.entity_id}`;
      const cur = winnerSeq.get(key);
      // Latest by HLC; tie-break on higher seq (later physical insert).
      if (!cur || compareHlc(r.hlc, cur.hlc) > 0 || (compareHlc(r.hlc, cur.hlc) === 0 && r.seq > cur.seq)) {
        winnerSeq.set(key, { seq: r.seq, hlc: r.hlc });
      }
    }

    // Raw HLC order is not the policy winner for delete/put races. Prefer the
    // op whose HLC matches the reconciled row; rejected higher-clock puts must
    // never evict the durable delete from the published compacted oplog.
    // Pre-group the rows by their winner key once so this loop's per-winner
    // scan is O(distinct rows) instead of a quadratic filter over the whole
    // oplog (which dominates before the first compaction).
    const byKey = new Map<string, Array<{ seq: number; hlc: string; entity: SyncableTable; entity_id: string }>>();
    for (const r of rows) {
      const k = `${r.entity}\u0000${r.entity_id}`;
      const list = byKey.get(k);
      if (list) list.push(r); else byKey.set(k, [r]);
    }
    for (const [key, winner] of winnerSeq) {
      const split = key.indexOf("\u0000");
      const entity = key.slice(0, split) as SyncableTable;
      const entityId = key.slice(split + 1);
      const row = readRow(this.db, entity, entityId);
      const effectiveHlc = typeof row?.hlc === "string" ? row.hlc : this.getRowBase(entity, entityId)?.delete_hlc;
      if (!effectiveHlc || effectiveHlc === winner.hlc) continue;
      const policyRow = (byKey.get(key) ?? [])
        .filter((r) => r.hlc === effectiveHlc)
        .sort((a, b) => b.seq - a.seq)[0];
      if (policyRow) winnerSeq.set(key, { seq: policyRow.seq, hlc: policyRow.hlc });
    }

    const keep = new Set<number>([...winnerSeq.values()].map((w) => w.seq));
    const toDelete = rows.filter((r) => !keep.has(r.seq)).map((r) => r.seq);
    if (toDelete.length === 0) return 0;

    const run = this.db.transaction(() => {
      // Delete in chunks to stay within SQLite's parameter limit.
      const CHUNK = 500;
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        const batch = toDelete.slice(i, i + CHUNK);
        const placeholders = batch.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM sync_oplog WHERE seq IN (${placeholders})`).run(...(batch as never[]));
      }
    });
    run();
    return toDelete.length;
  }

  /**
   * All oplog entries this device has, in HLC order (for a full peer sync).
   * Compacts first so the exported changelog carries one entry per live row,
   * not the full edit history.
   */
  exportOplog(): OplogEntry[] {
    this.compactOplog();
    const rows = this.db.prepare("SELECT * FROM sync_oplog ORDER BY seq ASC").all() as Array<{
      hlc: string;
      origin: string;
      entity: SyncableTable;
      entity_id: string;
      op: Op;
      payload: string | null;
      observed: string | null;
    }>;
    return rows.map((r) => {
      const base = this.getRowBase(r.entity, r.entity_id);
      const observed = parseFrontier(r.observed);
      const tombstone = r.op === "put" && base?.delete_hlc && base.delete_origin
        ? { hlc: base.delete_hlc, origin: base.delete_origin }
        : undefined;
      // Stamp the wire-protocol version at the export boundary. It is not stored
      // per-row (it describes the format, not the edit), so every exported entry
      // carries this build's version uniformly. A peer reads it to know whether
      // we are ahead of or behind them.
      return { ...r, payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null, observed, tombstone, v: SYNC_PROTOCOL_VERSION };
    });
  }

  /**
   * Apply a batch of peer oplog entries. Convergent: entries are sorted by HLC
   * and each is reconciled against local state with LWW + conflict-copy.
   * Idempotent: an entry whose HLC is <= the row's current HLC is skipped.
   *
   * Returns `conflictCopies` (new conflict-copy row ids) and `applied` — the
   * ops that actually changed local state (skipped stale ops are omitted). The
   * desktop uses `applied` to project note changes back into their .md files.
   */
  applyRemote(entries: OplogEntry[]): {
    conflictCopies: string[];
    applied: Array<{ entity: SyncableTable; entity_id: string; op: Op }>;
  } {
    const conflictCopies: string[] = [];
    const applied: Array<{ entity: SyncableTable; entity_id: string; op: Op }> = [];
    let recorded = false;
    const sorted = [...entries].sort((a, b) => compareHlc(a.hlc, b.hlc));

    // Sync applies rows in oplog (HLC) order, not FK-dependency order, and may
    // insert tombstone shells for created-then-deleted rows whose 'put' was
    // compacted away. Both legitimately violate FKs, so enforce none while
    // reconciling. The pragma must be toggled OUTSIDE a transaction (SQLite
    // ignores it inside one), so we do it around the transaction, not within.
    const fkRow = this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
    const fkWasOn = fkRow?.foreign_keys === 1;
    if (fkWasOn) this.db.prepare("PRAGMA foreign_keys = OFF").run();

    const run = this.db.transaction(() => {
      this.setSuppress(true); // reconcile writes must not be re-captured as local ops
      for (const entry of sorted) {
        // Note the peer's wire-protocol version (absent = pre-versioning = 1) so
        // the UI can flag a device that is behind this build. Kept outside the
        // syncable-entity guard below: even an op for a dropped entity still
        // tells us how old that peer's writer is.
        if (entry.origin && entry.origin !== this.deviceId) {
          this.notePeerProtocol(entry.origin, entry.v ?? 1);
        }
        // Ignore ops for entities we no longer sync (e.g. chat_threads /
        // chat_messages, removed in v28). A peer still running an old build — or
        // an oplog file it published before upgrading — can carry these; without
        // this guard we'd re-apply them AND re-forward them via recordForwardedOp,
        // keeping the loop alive. Skipping makes the un-sync self-healing.
        if (!(SYNCABLE_TABLES as readonly string[]).includes(entry.entity)) continue;
        this.hlc.receive(entry.hlc);
        if (entry.op === "delete") this.markObservedDelete(entry.entity, entry.entity_id, entry.hlc);
        const res = this.reconcileOne(entry);
        if (res.applied) applied.push({ entity: entry.entity, entity_id: entry.entity_id, op: entry.op });
        if (res.conflictCopyId) conflictCopies.push(res.conflictCopyId);
        // Telemetry must never be able to roll back real data ops.
        if (LOGGED_OUTCOMES.has(res.outcome)) {
          try {
            this.recordActivity(entry, res.outcome, res.conflictCopyId);
            recorded = true;
          } catch {
            /* activity log is derived; a failure here is not a data problem */
          }
        }
      }
      if (recorded) {
        try {
          this.pruneActivity();
        } catch {
          /* ditto */
        }
      }
      this.setSuppress(false);
      this.persistHlc();
    });
    try {
      run();
    } finally {
      if (fkWasOn) this.db.prepare("PRAGMA foreign_keys = ON").run();
    }
    return { conflictCopies, applied };
  }

  private reconcileOne(entry: OplogEntry): { applied: boolean; conflictCopyId: string | null; outcome: SyncOutcome } {
    const { entity, entity_id, op, hlc, origin, observed } = entry;
    const local = readRow(this.db, entity, entity_id);
    const localHlc = (local?.hlc as string | undefined) ?? null;
    if (op === "put" && entry.tombstone) {
      this.setDeleteVersion(entity, entity_id, entry.tombstone.hlc, entry.tombstone.origin);
      this.markObservedDelete(entity, entity_id, entry.tombstone.hlc);
    }
    const rowBase = this.getRowBase(entity, entity_id);

    // Delete/put races are causal, not wall-clock LWW. A put may revive only
    // when its author had observed the durable delete; a delete may remove a
    // live row unless that row's winning put had already observed this delete.
    // Missing metadata from an older client is intentionally not proof.
    if (op === "put" && rowBase?.delete_hlc && rowBase.delete_origin) {
      const isAfterDelete = compareHlc(hlc, rowBase.delete_hlc) > 0
        && this.observesDelete(observed, entity, entity_id, rowBase.delete_hlc);
      if (!isAfterDelete) {
        this.recordForwardedOp(entry);
        // Only preserve a newer put as a conflict copy. An older stale put
        // (e.g. desktop's last snapshot read while desktop was closed) is
        // just the old state, not a concurrent edit after the delete — keeping
        // it as a live "recreation" is what made mobile appear to resurrect a
        // note the user had just deleted (the "bunch of checkboxes" report).
        // A newer put (higher HLC) that still lost the causal check IS a
        // concurrent edit after the delete and is worth preserving.
        const shouldPreserve = compareHlc(hlc, rowBase.delete_hlc) > 0;
        const conflictCopyId = shouldPreserve
          ? this.preserveRejectedNotePut(entity, entity_id, entry.payload, origin, hlc)
          : null;
        return { applied: false, conflictCopyId, outcome: "delete-won" };
      }

      // A compacted legitimate revival can arrive after this peer already
      // accepted an unobserved stale put with a higher wall-clock HLC. The newly
      // learned tombstone invalidates that local lineage despite raw HLC order.
      if (local && !local.deleted_at && localHlc && compareHlc(localHlc, hlc) > 0) {
        const localObserved = rowBase.put_hlc === localHlc ? parseFrontier(rowBase.put_observed) : undefined;
        if (!this.observesDelete(localObserved, entity, entity_id, rowBase.delete_hlc)) {
          const conflictCopyId = this.preserveRejectedNotePut(
            entity,
            entity_id,
            local,
            decodeHlc(localHlc).deviceId,
            localHlc,
          );
          this.recordForwardedOp(entry);
          this.writeRow(entity, this.mergeForPut(entity, undefined, entry.payload ?? {}, hlc));
          this.setPutVersion(entity, entity_id, hlc, observed ?? {});
          const bodyCol = BODY_COLUMN[entity];
          if (bodyCol) this.setBaseBody(entity, entity_id, entry.payload?.[bodyCol]);
          // The local row was newer by raw HLC but its lineage never observed the
          // delete, so the delete gate discarded it. `preserveRejectedNotePut`
          // only rescues entities with a body column (notes), so for everything
          // else the local edit is genuinely gone — never label that "applied".
          return { applied: true, conflictCopyId, outcome: conflictCopyId ? "conflict-copy" : "delete-won" };
        }
      }
    }

    if (op === "delete" && local && !local.deleted_at) {
      if (rowBase?.delete_hlc && compareHlc(hlc, rowBase.delete_hlc) < 0) {
        this.recordForwardedOp(entry);
        return { applied: false, conflictCopyId: null, outcome: "skipped-stale" };
      }
      const localObserved = rowBase?.put_hlc === localHlc ? parseFrontier(rowBase.put_observed) : undefined;
      if (localObserved && this.observesDelete(localObserved, entity, entity_id, hlc)) {
        this.setDeleteVersion(entity, entity_id, hlc, origin);
        this.recordForwardedOp(entry);
        return { applied: false, conflictCopyId: null, outcome: "skipped-stale" };
      }

      // The delete wins even when a stale peer's unobserved put has the higher
      // raw HLC. Preserve its divergent note body before tombstoning the row,
      // but only when the local put is newer than the incoming delete — an
      // older local snapshot (e.g. a note edited on desktop before it was
      // closed, then deleted on mobile) is not a concurrent edit after the
      // delete, so keeping it as a live recreation is the "mobile tried to
      // recreate" bug. A newer local put that still lost the causal check IS
      // worth preserving.
      const shouldPreserveLocal = !localHlc || compareHlc(localHlc, hlc) > 0;
      const conflictCopyId = shouldPreserveLocal
        ? this.preserveRejectedNotePut(
            entity,
            entity_id,
            local,
            localHlc ? decodeHlc(localHlc).deviceId : this.deviceId,
            localHlc ?? hlc,
          )
        : null;
      this.recordForwardedOp(entry);
      this.setDeleteVersion(entity, entity_id, hlc, origin);
      this.markObservedDelete(entity, entity_id, hlc);
      this.db.prepare(`UPDATE ${entity} SET deleted_at = ?, hlc = ? WHERE id = ?`).run(nowIso(), hlc, entity_id);
      return { applied: true, conflictCopyId, outcome: "delete-won" };
    }

    // Idempotency / staleness guard: never let an older op overwrite a newer row.
    if (localHlc && compareHlc(hlc, localHlc) <= 0) {
      // Even though we don't apply this op, if its body matches our current row
      // it's proof the peer has converged on this exact version (typically our
      // own edit echoed back via gossip). Advance the conflict ancestor so a
      // later legitimately-sequential edit from the peer isn't mistaken for a
      // concurrent one. Only advance toward agreement (bodies equal).
      const bodyCol = BODY_COLUMN[entity];
      if (bodyCol && op === "put" && local && entry.payload) {
        const remoteBody = entry.payload[bodyCol];
        if (syncBodiesEqual(local[bodyCol], remoteBody)) {
          this.setBaseBody(entity, entity_id, remoteBody);
        }
      }
      return { applied: false, conflictCopyId: null, outcome: "skipped-stale" };
    }

    // Record the remote op in our own oplog too, so a third party syncing from
    // us later receives it (gossip). Skip if we already have this exact op.
    this.recordForwardedOp(entry);

    if (op === "delete") {
      this.setDeleteVersion(entity, entity_id, hlc, origin);
      this.markObservedDelete(entity, entity_id, hlc);
      if (local) {
        this.db.prepare(`UPDATE ${entity} SET deleted_at = ?, hlc = ? WHERE id = ?`).run(nowIso(), hlc, entity_id);
      } else {
        // Delete arrived before we ever saw the row: create a tombstone shell so
        // a later 'put' with an older HLC can't resurrect it.
        this.insertTombstoneShell(entity, entity_id, hlc);
      }
      return { applied: true, conflictCopyId: null, outcome: "applied" };
    }

    // op === 'put'
    const remote = entry.payload ?? {};
    let conflictCopyId: string | null = null;
    const bodyCol = BODY_COLUMN[entity];

    if (local && !local.deleted_at && bodyCol) {
      // 3-way body conflict (plan §5): a conflict copy is created only when BOTH
      // sides changed the body since the common ancestor and they now disagree.
      // A one-sided remote edit (local == ancestor) is NOT a conflict — this is
      // what prevents spurious conflict copies on notes the user never touched.
      //
      // NEVER make a conflict copy OF a conflict copy. If this row's id is
      // already a `_conflict_…` clone, a further divergence must resolve by plain
      // LWW, not by minting `_conflict_…_conflict_…` nests. Two devices each
      // cloning the other's copy produced an exploding pile of junk notes that
      // then churned as perpetual delete tombstones (the "31 pending" storm).
      const isConflictClone = inspectConflict(String(entity_id)).isConflict;
      const ancestor = this.getBaseBody(entity, entity_id); // undefined = unknown
      const localBody = local[bodyCol];
      const remoteBody = remote[bodyCol];
      const localChanged = ancestor === undefined ? false : !syncBodiesEqual(localBody, ancestor);
      const remoteChanged = ancestor === undefined ? false : !syncBodiesEqual(remoteBody, ancestor);
      if (
        !isConflictClone &&
        localChanged &&
        remoteChanged &&
        !syncBodiesEqual(localBody, remoteBody) &&
        remoteBody != null &&
        localBody != null
      ) {
        conflictCopyId = this.makeConflictCopy(entity, local);
      }
    }

    const merged = this.mergeForPut(entity, local, remote, hlc);

    // If the merged (union) row contains array elements the WINNING remote
    // payload lacked, re-stamp with a fresh local HLC and publish it, so the
    // complete union propagates to peers. This must fire even when merged equals
    // our local row: the remote won LWW (higher HLC) but may carry an OLDER array
    // subset (e.g. a later scalar edit that shipped a stale tag_ids), so if we
    // don't republish, the peer never learns the elements only we hold and the
    // two devices diverge.
    //
    // This does NOT loop: once a peer applies our published union, its own
    // subsequently-published op for this row CONTAINS the union, so
    // unionChangedBeyondRemote goes false on the next exchange and neither side
    // re-stamps. compactOplog keeps the highest-HLC (full-union) op, so a peer
    // reading a stale earlier subset still converges on the next round.
    if (local && this.unionChangedBeyondRemote(entity, remote, merged)) {
      const stamp = this.hlc.send();
      const nextObserved = this.observationSnapshot(entity, entity_id);
      this.persistHlc();
      merged.hlc = stamp;
      this.writeRow(entity, merged);
      this.setPutVersion(entity, entity_id, stamp, nextObserved);
      this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: entity_id, op: "put", payload: readRow(this.db, entity, entity_id) ?? null, observed: nextObserved });
    } else {
      this.writeRow(entity, merged);
      this.setPutVersion(entity, entity_id, hlc, observed ?? {});
    }
    // The merged body is now the value both sides agree on → new ancestor.
    if (bodyCol) this.setBaseBody(entity, entity_id, merged[bodyCol]);
    return { applied: true, conflictCopyId, outcome: conflictCopyId ? "conflict-copy" : "applied" };
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
    // Insert a minimal row that satisfies NOT NULL constraints, already
    // tombstoned. This is an intentionally-incomplete placeholder (e.g. a
    // created-then-deleted row whose 'put' was compacted away, so the peer only
    // ever sees the delete). FK columns can't reference real rows; callers run
    // reconcile with FKs disabled (see applyRemote) so the dead shell is
    // allowed. The row is never read as live data.
    const cols = db_cols_notnull(this.db, entity);
    const row: Record<string, unknown> = { id, hlc, deleted_at: nowIso() };
    // Only synthesize a placeholder for NOT NULL columns that have NO db default.
    // Columns WITH a default are omitted so SQLite applies the real default —
    // copying the raw PRAGMA dflt_value text here would corrupt quoted-literal
    // defaults (e.g. "'x'" would be stored including the quotes).
    for (const c of cols) {
      if (c.name in row) continue;
      if (c.dflt != null) continue; // let SQLite apply the column default
      row[c.name] = "";
    }
    this.writeRow(entity, row);
  }

  private makeConflictCopy(entity: SyncableTable, local: Record<string, unknown>): string {
    // Clone the LOCAL version as a new row so the incoming remote can win in place.
    // Derive the unique suffix from the freshly-minted HLC (send()) rather than
    // Date.now(), so multiple conflicts in the same millisecond on one device
    // never collide. Keep the `_conflict_<deviceId>_<suffix>` shape the conflict
    // helpers (conflict.ts) parse — suffix is the HLC physical+counter in hex.
    const stamp = this.hlc.send();
    const parts = decodeHlc(stamp);
    const suffix = parts.physical.toString(16) + parts.counter.toString(16).padStart(4, "0");
    const copyId = `${local.id}_conflict_${this.deviceId}_${suffix}`;
    const clone: Record<string, unknown> = { ...local, id: copyId };
    if (entity === "notes") {
      clone.title = `${local.title ?? "Untitled"} (conflicted copy — ${this.deviceId})`;
    }
    clone.hlc = stamp;
    clone.deleted_at = null;
    this.writeRow(entity, clone);
    const observed = this.observationSnapshot(entity, copyId);
    this.setPutVersion(entity, copyId, stamp, observed);
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: copyId, op: "put", payload: readRow(this.db, entity, copyId) ?? null, observed });
    return copyId;
  }

  private preserveRejectedNotePut(
    entity: SyncableTable,
    entityId: string,
    row: Record<string, unknown> | null,
    losingOrigin: string,
    losingHlc: string,
  ): string | null {
    const bodyCol = BODY_COLUMN[entity];
    if (!bodyCol || !row || inspectConflict(entityId).isConflict) return null;
    const body = row[bodyCol];
    const ancestor = this.getBaseBody(entity, entityId);
    if (ancestor !== undefined && syncBodiesEqual(body, ancestor)) return null;

    const parts = decodeHlc(losingHlc);
    const suffix = parts.physical.toString(16) + parts.counter.toString(16).padStart(4, "0");
    const copyId = `${entityId}_conflict_${losingOrigin}_${suffix}`;
    if (readRow(this.db, entity, copyId)) return null;

    const stamp = this.hlc.send();
    const observed = this.observationSnapshot(entity, copyId);
    const clone: Record<string, unknown> = { ...row, id: copyId, hlc: stamp, deleted_at: null };
    clone.title = `${row.title ?? "Untitled"} (conflicted copy — ${losingOrigin})`;
    this.writeRow(entity, clone);
    this.setPutVersion(entity, copyId, stamp, observed);
    this.appendOplog({ hlc: stamp, origin: this.deviceId, entity, entity_id: copyId, op: "put", payload: readRow(this.db, entity, copyId) ?? null, observed });
    return copyId;
  }

  private recordForwardedOp(entry: OplogEntry): void {
    const exists = this.db
      .prepare("SELECT 1 FROM sync_oplog WHERE hlc = ? AND entity = ? AND entity_id = ?")
      .get(entry.hlc, entry.entity, entry.entity_id);
    if (!exists) this.appendOplog(entry);
  }

  // ── protocol versioning ───────────────────────────────────────────────

  /**
   * Record the highest wire-protocol version seen from a peer. Monotonic — a
   * peer that upgrades and writes a newer version is never downgraded in our
   * record, so a single old file lingering in the folder can't mask that the
   * device has since updated.
   */
  private notePeerProtocol(deviceId: string, version: number): void {
    if (!Number.isFinite(version) || version < 1) return;
    const key = `${PEER_PROTOCOL_PREFIX}${deviceId}`;
    const current = Number(this.getState(key) ?? 0);
    if (version > current) this.setState(key, String(version));
  }

  /**
   * Peers whose observed protocol version differs from this build's, so the UI
   * can prompt the user to update a device. `behind: true` is the important
   * case — that peer may not honour deletes, so the fleet is only as strong as
   * it. A peer AHEAD of us is reported too (informational: this build is old).
   */
  listPeerProtocols(): PeerProtocol[] {
    const rows = this.db
      .prepare(`SELECT key, value FROM sync_state WHERE key LIKE ? ESCAPE '\\'`)
      .all(`${PEER_PROTOCOL_PREFIX.replace(/[\\%_]/g, "\\$&")}%`) as Array<{ key: string; value: string }>;
    const out: PeerProtocol[] = [];
    for (const r of rows) {
      const version = Number(r.value);
      if (!Number.isFinite(version) || version === SYNC_PROTOCOL_VERSION) continue;
      out.push({
        deviceId: r.key.slice(PEER_PROTOCOL_PREFIX.length),
        version,
        behind: version < SYNC_PROTOCOL_VERSION,
      });
    }
    return out;
  }

  // ── Phase 4: visibility & recovery ────────────────────────────────────

  private recordActivity(entry: OplogEntry, outcome: SyncOutcome, conflictCopyId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_activity (at, entity, entity_id, op, hlc, origin, outcome, conflict_copy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nowIso(), entry.entity, entry.entity_id, entry.op, entry.hlc, entry.origin, outcome, conflictCopyId);
  }

  /**
   * Trim the log to the newest SYNC_ACTIVITY_LIMIT rows. Called once per batch
   * rather than per row so a large first sync costs one delete, not thousands.
   */
  private pruneActivity(): void {
    this.db
      .prepare(
        `DELETE FROM sync_activity WHERE seq <= (
           SELECT MIN(seq) FROM (
             SELECT seq FROM sync_activity ORDER BY seq DESC LIMIT ?
           )
         ) - 1`,
      )
      .run(SYNC_ACTIVITY_LIMIT);
  }

  /** Most recent reconcile decisions, newest first. */
  listSyncActivity(limit = 100): SyncActivityRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, at, entity, entity_id, op, hlc, origin, outcome, conflict_copy_id
         FROM sync_activity ORDER BY seq DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, SYNC_ACTIVITY_LIMIT))) as Array<
      Omit<SyncActivityRow, "title" | "isSelf" | "conflict_side">
    >;
    return rows.map((row) => ({
      ...row,
      title: this.rowLabel(row.entity, row.entity_id),
      isSelf: row.origin === this.deviceId,
      // A rejected put is the peer's edit being preserved; every other copy is
      // the local version being moved aside so the remote could win in place.
      conflict_side: row.conflict_copy_id ? (row.op === "put" && row.outcome === "delete-won" ? "remote" : "local") : null,
    }));
  }

  /** Current title/name of a row, or null if it's gone or has no such column. */
  private rowLabel(entity: SyncableTable, id: string): string | null {
    if (!(SYNCABLE_TABLES as readonly string[]).includes(entity)) return null;
    const cols = tableColumns(this.db, entity);
    const titleCol = cols.includes("title") ? "title" : cols.includes("name") ? "name" : null;
    if (!titleCol) return null;
    const row = this.db
      .prepare(`SELECT "${titleCol}" AS label FROM ${entity} WHERE id = ?`)
      .get(id) as { label?: unknown } | undefined;
    const label = row?.label;
    return typeof label === "string" && label.trim() ? label : null;
  }

  /**
   * Rows tombstoned by a *peer* that can genuinely be brought back, newest
   * delete first. This is the "why did my note vanish?" list.
   *
   * `total` is the number of qualifying rows, which may exceed the returned
   * page — the caller must not present `rows.length` as the count.
   *
   * Every exclusion here is also enforced by `restoreDeleted` via the shared
   * `restorability()` predicate, so a listed row is always actually restorable.
   * A Restore button that does nothing would be worse than no button.
   */
  listRestorable(entity: SyncableTable, limit = 50): { rows: RestorableRow[]; total: number } {
    const cols = tableColumns(this.db, entity);
    if (!cols.includes("deleted_at")) return { rows: [], total: 0 };
    const titleCol = cols.includes("title") ? "title" : cols.includes("name") ? "name" : null;

    // Cheap SQL prefilter (tombstoned + a delete we know about), then apply the
    // single source of truth in JS so the list and the action cannot disagree.
    const candidates = this.db
      .prepare(
        `SELECT t.id AS id
         FROM ${entity} t
         JOIN sync_row_base b ON b.entity = ? AND b.entity_id = t.id
         WHERE t.deleted_at IS NOT NULL AND b.delete_hlc IS NOT NULL
         ORDER BY b.delete_hlc DESC`,
      )
      .all(entity) as Array<{ id: string }>;

    const rows: RestorableRow[] = [];
    for (const candidate of candidates) {
      const verdict = this.restorability(entity, candidate.id);
      if (!verdict.ok) continue;
      const { row, base } = verdict;
      // Stop advertising very old deletes so the banner isn't permanent. A
      // direct restoreDeleted(id) still works — this only bounds the prompt.
      const authored = base.delete_hlc ? decodeHlc(base.delete_hlc).physical : NaN;
      if (Number.isFinite(authored) && this.now() - authored > RESTORABLE_WINDOW_MS) continue;
      rows.push({
        entity,
        entity_id: candidate.id,
        title: titleCol ? ((row[titleCol] as string | null) ?? null) : null,
        // When the delete was authored, not when this device applied it — the
        // apply time can be days later and reads as a fresh deletion.
        deleted_at: base.delete_hlc
          ? new Date(decodeHlc(base.delete_hlc).physical).toISOString()
          : ((row.deleted_at as string | null) ?? null),
        delete_origin: base.delete_origin,
      });
    }
    return { rows: rows.slice(0, Math.max(1, limit)), total: rows.length };
  }

  /**
   * Single source of truth for "can this tombstoned row be restored?".
   *
   * Shared by `listRestorable` and `restoreDeleted` so the list can never offer
   * something the action refuses (and vice versa).
   */
  private restorability(
    entity: SyncableTable,
    id: string,
  ):
    | { ok: true; row: Record<string, unknown>; base: RowBase }
    | { ok: false; reason: RestoreRefusal } {
    const row = readRow(this.db, entity, id);
    if (!row) return { ok: false, reason: "missing" };
    if (!row.deleted_at) return { ok: false, reason: "live" };

    // Conflict clones have their own resolution UI, and the app's startup
    // cleanup deliberately tombstones nested ones — restoring them here would
    // just be undone at the next launch.
    if (inspectConflict(String(id)).isConflict) return { ok: false, reason: "conflict-copy" };

    const base = this.getRowBase(entity, id);
    // The row exists but sync has no delete metadata for it (e.g. tombstoned
    // outside the sync path). Not "missing" — that must mean the row is gone,
    // or the UI tells the user their note no longer exists when it does.
    if (!base?.delete_hlc) return { ok: false, reason: "no-delete-record" };
    if (base.local_delete_hlc) return { ok: false, reason: "self-deleted" };

    // A tombstone shell is a placeholder for a row whose content we never
    // received (`insertTombstoneShell`). `put_hlc` is the structural signal —
    // it is only set when a real put was applied — so this does not depend on
    // whether a title column happens to be NOT NULL without a default.
    if (!base.put_hlc) return { ok: false, reason: "shell" };

    // Reviving a row whose parent is gone creates a permanently divergent
    // orphan (the parent may have been hard-deleted on the peer).
    if (!this.parentsLive(entity, row)) return { ok: false, reason: "orphaned" };

    // When this device lost a delete/edit race, the delete-won path both
    // tombstoned this row (keeping its body) AND cloned that body into a live
    // conflict copy. Offering restore then produces two identical notes, and
    // the user has to notice and delete one. If such a copy already preserves
    // this content, send them to conflict resolution instead — the edit is not
    // at risk, so this is a redundant second door, not a lost note.
    if (this.hasLivePreservingCopy(entity, id, row)) {
      return { ok: false, reason: "preserved-as-copy" };
    }

    return { ok: true, row, base };
  }

  /** True when every FK parent of `row` still exists and is not tombstoned. */
  private parentsLive(entity: SyncableTable, row: Record<string, unknown>): boolean {
    for (const fk of this.foreignKeys(entity)) {
      const value = row[fk.from];
      if (value == null || value === "") continue; // nullable FK, nothing to check
      const parentKey = fk.to ?? "id";
      const parentCols = tableColumns(this.db, fk.table);
      if (parentCols.length === 0) return false; // parent table is gone entirely
      // Only the key and the tombstone flag matter here — no need to haul the
      // whole parent row back for an existence check.
      const hasDeletedAt = parentCols.includes("deleted_at");
      const parent = this.db
        .prepare(
          `SELECT ${hasDeletedAt ? "deleted_at" : "1 AS present"} FROM ${fk.table} WHERE "${parentKey}" = ?`,
        )
        .get(value) as Record<string, unknown> | undefined;
      if (!parent) return false;
      if (hasDeletedAt && parent.deleted_at) return false;
    }
    return true;
  }

  /**
   * True when a live conflict copy already holds this tombstoned row's content.
   *
   * The delete-won path clones the losing body into `<id>_conflict_<origin>_<ts>`
   * and then tombstones the original with its body intact, so the two match. In
   * that case the edit is safe in the copy and restore would just duplicate it —
   * we suppress the restore offer and point at conflict resolution instead.
   *
   * Only checks entities with a body column (notes); everything else has no
   * conflict-copy mechanism, so the answer is trivially false.
   */
  private hasLivePreservingCopy(entity: SyncableTable, id: string, row: Record<string, unknown>): boolean {
    const bodyCol = BODY_COLUMN[entity];
    if (!bodyCol) return false;
    const body = row[bodyCol];
    // Copies are `<id>_conflict_<origin>_<ts>`. Escape LIKE wildcards in the id
    // (note ids are nanoid, but `_` is a LIKE metachar), then confirm each hit
    // really parses back to THIS original — the deviceId can itself contain the
    // separator, so a prefix match alone is not proof.
    const likePrefix = `${id}_conflict_`.replace(/[\\%_]/g, "\\$&");
    const candidates = this.db
      .prepare(`SELECT id, "${bodyCol}" AS body FROM ${entity} WHERE deleted_at IS NULL AND id LIKE ? ESCAPE '\\'`)
      .all(`${likePrefix}%`) as Array<{ id: string; body: unknown }>;
    for (const c of candidates) {
      if (inspectConflict(c.id).originalId !== id) continue;
      if (String(c.body ?? "") === String(body ?? "")) return true;
    }
    return false;
  }
  private foreignKeys(entity: SyncableTable): Array<{ table: string; from: string; to: string | null }> {
    const cached = this.fkCache.get(entity);
    if (cached) return cached;
    const fks = this.db.prepare(`PRAGMA foreign_key_list(${entity})`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
    }>;
    this.fkCache.set(entity, fks);
    return fks;
  }

  /**
   * Undo a peer's delete for one row (plan §4 Phase 4b).
   *
   * Deliberately reuses `put()` rather than clearing `deleted_at` directly:
   * put() snapshots this device's delete observations, so the resulting op
   * carries exact proof that the author had seen the tombstone. That is the only
   * thing the Phase 1 revival gate accepts, so the restore converges on every
   * peer instead of being re-deleted on the next exchange.
   *
   * Returns the new HLC stamp, or a machine-readable refusal reason so the
   * caller can explain the no-op instead of silently doing nothing.
   */
  restoreDeleted(entity: SyncableTable, id: string): RestoreResult {
    const verdict = this.restorability(entity, id);
    if (!verdict.ok) return { restored: false, reason: verdict.reason };
    const hlc = this.put(entity, {
      ...verdict.row,
      id,
      deleted_at: null,
    } as Record<string, unknown> & { id: string });
    return { restored: true, hlc };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function validStoredHlc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    decodeHlc(value);
    return value;
  } catch {
    return null;
  }
}

function backfillStamp(updatedAt: unknown, createdAt: unknown, deviceId: string): string {
  const updated = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const physical = Number.isFinite(updated) && updated >= 0
    ? updated
    : Number.isFinite(created) && created >= 0 ? created : 0;
  return encodeHlc({ physical, counter: 0, deviceId });
}

function parseFrontier(value: string | null | undefined): ObservationFrontier | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

function db_cols_notnull(db: SyncDb, table: string): Array<{ name: string; dflt: unknown }> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  return cols.filter((c) => c.notnull === 1).map((c) => ({ name: c.name, dflt: c.dflt_value }));
}

export { SYNCABLE_TABLES };
