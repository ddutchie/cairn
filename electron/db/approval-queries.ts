/**
 * Cairn — Durable approval inbox queries
 *
 * The persisted, cross-session human-attention queue (migration v33) that backs
 * approve/deny for background runs and interactive sessions. A consequential
 * tool call parks here as a `pending` item; the user resolves it from the
 * renderer (surviving reloads + tray-time). resolve-once + first-responder-wins:
 * resolving an item idempotently transitions it pending → resolved and records
 * the resolution; a resolved item never re-arms.
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { newId, ts } from "./utils";

export type ApprovalKind = "approval" | "question" | "notification" | "plan";
export type ApprovalState = "pending" | "resolved" | "expired";
export type ApprovalResolution = "approved_once" | "approved_session" | "approved_always" | "denied";

export interface ApprovalItem {
  id: string;
  runId: string | null;
  sessionId: string | null;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  kind: ApprovalKind;
  title: string;
  body: string;
  state: ApprovalState;
  resolution: ApprovalResolution | null;
  createdAt: string;
  resolvedAt: string | null;
}

type Row = Record<string, unknown>;

function toItem(r: Row): ApprovalItem {
  return {
    id: String(r.id),
    runId: r.run_id ? String(r.run_id) : null,
    sessionId: r.session_id ? String(r.session_id) : null,
    tool: String(r.tool),
    args: parseJson<Record<string, unknown>>(r.args, {}),
    argsHash: String(r.args_hash ?? ""),
    kind: r.kind as ApprovalKind,
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    state: r.state as ApprovalState,
    resolution: r.resolution ? (r.resolution as ApprovalResolution) : null,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Sort object keys (recursively) so two structurally-equal arg objects hash alike regardless of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic idempotency key — same tool + args → same key, so a durable
 * resume never creates a duplicate parked item for the same request. SHA-256
 * over the tool + canonically-sorted args avoids the 32-bit collision space of
 * the previous rolling hash.
 */
export function approvalArgsHash(tool: string, args: unknown): string {
  const canonical = JSON.stringify(canonicalize(args ?? {}));
  return createHash("sha256").update(`${tool}:${canonical}`).digest("hex").slice(0, 32);
}

export interface ApprovalItemInput {
  runId?: string | null;
  sessionId?: string | null;
  tool: string;
  args?: Record<string, unknown>;
  kind?: ApprovalKind;
  title?: string;
  body?: string;
}

/**
 * Insert a pending approval item unless an identical pending/resolved item
 * already exists (idempotent by run + tool + args-hash). Returns the existing
 * item when a duplicate is found.
 */
export function parkApproval(db: Database.Database, input: ApprovalItemInput): ApprovalItem {
  const argsHash = approvalArgsHash(input.tool, input.args ?? {});
  const existing = db
    .prepare("SELECT * FROM approval_items WHERE run_id IS ? AND tool = ? AND args_hash = ? ORDER BY created_at DESC LIMIT 1")
    .get(input.runId ?? null, input.tool, argsHash) as Row | undefined;
  if (existing) return toItem(existing);

  const id = newId();
  const now = ts();
  db.prepare(`
    INSERT INTO approval_items (id, run_id, session_id, tool, args, args_hash, kind, title, body, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id, input.runId ?? null, input.sessionId ?? null, input.tool,
    JSON.stringify(input.args ?? {}), argsHash, input.kind ?? "approval",
    input.title ?? "", input.body ?? "", now,
  );
  return getApprovalItemById(db, id)!;
}

export function getApprovalItemById(db: Database.Database, id: string): ApprovalItem | null {
  const r = db.prepare("SELECT * FROM approval_items WHERE id = ?").get(id) as Row | undefined;
  return r ? toItem(r) : null;
}

export function listPendingApprovals(db: Database.Database, limit = 100): ApprovalItem[] {
  const rows = db
    .prepare("SELECT * FROM approval_items WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(toItem);
}

/** Cheap count for the dock/tray attention badge. */
export function countPendingApprovals(db: Database.Database): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM approval_items WHERE state = 'pending'").get() as { n: number };
  return r.n;
}

export function listApprovalItemsForRun(db: Database.Database, runId: string): ApprovalItem[] {
  const rows = db
    .prepare("SELECT * FROM approval_items WHERE run_id = ? ORDER BY created_at ASC")
    .all(runId) as Row[];
  return rows.map(toItem);
}

/**
 * Resolve a pending item. resolve-once + first-responder-wins: a single guarded
 * UPDATE on the pending row means the first resolution wins atomically — a
 * second call finds no pending row and returns the existing item unchanged.
 */
export function resolveApproval(
  db: Database.Database,
  id: string,
  resolution: ApprovalResolution,
): ApprovalItem | null {
  const info = db
    .prepare("UPDATE approval_items SET state = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND state = 'pending'")
    .run(resolution, ts(), id);
  if (info.changes === 0) return getApprovalItemById(db, id);
  return getApprovalItemById(db, id);
}

/** Fail-closed sweep: mark stale pending items expired. */
export function expireStaleApprovals(db: Database.Database, beforeIso: string): number {
  const info = db
    .prepare("UPDATE approval_items SET state = 'expired', resolved_at = ? WHERE state = 'pending' AND created_at < ?")
    .run(ts(), beforeIso);
  return info.changes;
}
