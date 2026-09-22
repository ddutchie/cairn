/**
 * Cairn — coding-agent session / message / todo queries.
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";

// ── Coding Agent Sessions ───────────────────────────────────────────────────────────────

export interface CodingSessionRow {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`
   * tool for this session. Cached so the execute-mode system prompt can
   * carry the approved plan forward without folding the entire session log.
   * NULL when the session never called exit_plan_mode.
   */
  planContent: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
  role: "default" | "automation-dev";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCodingSession(row: any): CodingSessionRow {
  return {
    id:          row.id as string,
    projectId:   row.project_id as string,
    taskTitle:   row.task_title as string,
    taskId:      row.task_id as string | null,
    cwd:         row.cwd as string,
    mode:        (row.mode ?? "execute") as "plan" | "execute",
    planNoteId:  row.plan_note_id as string | null,
    planContent: (row.plan_content ?? null) as string | null,
    status:      (row.status ?? "running") as "running" | "exited",
    spawnedAt:   row.spawned_at as string,
    updatedAt:   row.updated_at as string,
    role:        normalizeSessionRole(row.role),
  };
}

/**
 * Validate a persisted session persona. Absent → "default" (existing behavior);
 * a known value → itself; an unknown/corrupt value FAILS CLOSED to the
 * restricted "automation-dev" persona so an unvalidated session can never
 * default to the unrestricted toolset.
 */
export function normalizeSessionRole(raw: unknown): "default" | "automation-dev" {
  if (raw === "default") return "default";
  if (raw === "automation-dev") return "automation-dev";
  return raw === undefined || raw === null ? "default" : "automation-dev";
}

export function createCodingSession(
  db: Database.Database,
  session: { id: string; projectId: string; taskTitle: string; taskId?: string | null; cwd: string; mode: "plan" | "execute"; spawnedAt: string; role?: "default" | "automation-dev" },
): CodingSessionRow {
  const now = ts();
  const role = normalizeSessionRole(session.role);
  db.prepare(`
    INSERT INTO agent_session_metadata (id, project_id, task_title, task_id, cwd, mode, role, status, spawned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(session.id, session.projectId, session.taskTitle, session.taskId ?? null, session.cwd, session.mode, role, session.spawnedAt, now);
  return getCodingSessionById(db, session.id)!;
}

export function getCodingSessionById(db: Database.Database, id: string): CodingSessionRow | null {
  const row = db.prepare("SELECT * FROM agent_session_metadata WHERE id = ?").get(id);
  return row ? toCodingSession(row) : null;
}

export function getCodingSessions(db: Database.Database, projectId: string): CodingSessionRow[] {
  return (db.prepare("SELECT * FROM agent_session_metadata WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50").all(projectId) as unknown[])
    .map(toCodingSession);
}

export function updateCodingSession(
  db: Database.Database,
  sessionId: string,
  patch: { mode?: "plan" | "execute"; planNoteId?: string | null; planContent?: string | null; status?: "running" | "exited"; updatedAt?: string },
) {
  const now = patch.updatedAt ?? ts();
  if (patch.mode !== undefined) {
    db.prepare("UPDATE agent_session_metadata SET mode = ?, updated_at = ? WHERE id = ?").run(patch.mode, now, sessionId);
  }
  if (patch.planNoteId !== undefined) {
    db.prepare("UPDATE agent_session_metadata SET plan_note_id = ?, updated_at = ? WHERE id = ?").run(patch.planNoteId, now, sessionId);
  }
  if (patch.planContent !== undefined) {
    db.prepare("UPDATE agent_session_metadata SET plan_content = ?, updated_at = ? WHERE id = ?").run(patch.planContent, now, sessionId);
  }
  if (patch.status !== undefined) {
    db.prepare("UPDATE agent_session_metadata SET status = ?, updated_at = ? WHERE id = ?").run(patch.status, now, sessionId);
  }
  if (patch.mode === undefined && patch.planNoteId === undefined && patch.planContent === undefined && patch.status === undefined) {
    db.prepare("UPDATE agent_session_metadata SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }
}

export function deleteCodingSession(db: Database.Database, sessionId: string) {
  db.prepare("DELETE FROM agent_session_metadata WHERE id = ?").run(sessionId);
}

/**
 * Mark every coding session still stuck in 'running' as 'exited'. A session's
 * status is set to 'running' on creation and only flipped to 'exited' on a
 * clean close, so a crash / quit / dev reload mid-session leaves the row
 * 'running' forever — which the session browser would otherwise paint as a
 * live "active" session indefinitely. Called once on startup, mirroring the
 * automation runs' recoverInterruptedRuns. Returns the number reconciled.
 */
export function reconcileInterruptedCodingSessions(db: Database.Database): number {
  const info = db.prepare("UPDATE agent_session_metadata SET status = 'exited', updated_at = ? WHERE status = 'running'").run(ts());
  return info.changes;
}

// ── Coding Agent Messages ───────────────────────────────────────────────────────────────



// ── Coding Agent Session Todos ─────────────────────────────────────────────────

export interface SessionTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

interface SessionTodoRow {
  content: string;
  status: string;
  priority: string;
}

function toSessionTodo(row: SessionTodoRow): SessionTodo {
  return {
    content: row.content,
    status: row.status as SessionTodo["status"],
    priority: row.priority as SessionTodo["priority"],
  };
}

/**
 * Replace-wholesale save for a session's todo list (the model sends the entire
 * list each `todowrite` call). Delete + insert by position in one transaction.
 */
export function saveSessionTodos(db: Database.Database, sessionId: string, todos: SessionTodo[]) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM session_todos WHERE session_id = ?").run(sessionId);
    todos.forEach((todo, position) => {
      db.prepare("INSERT INTO session_todos (session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, todo.content, todo.status, todo.priority, position);
    });
  });
  save();
}

export function getSessionTodos(db: Database.Database, sessionId: string): SessionTodo[] {
  return (db.prepare("SELECT content, status, priority FROM session_todos WHERE session_id = ? ORDER BY position ASC").all(sessionId) as SessionTodoRow[])
    .map(toSessionTodo);
}
