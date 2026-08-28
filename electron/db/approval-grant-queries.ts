/**
 * Workspace-persistent approval grants — the "Always allow" table.
 *
 * A row is the user's durable answer "this tool (and, for bash, this exact
 * command) is trusted for this workspace, don't ask me again". It mirrors
 * `automation-approval.ts`'s standing rules (target-aware, deduped, exec
 * refuses a wildcard grant) but is scoped to a workspace rather than to one
 * automation, and is consulted by the interactive approval bridge (both chat
 * and coding).
 *
 * Intentionally NOT synced: a trust decision made on one device must not
 * silently apply on another.
 */

import type Database from "better-sqlite3";
import { newId } from "./utils";

/** One grant, as returned by list/get. */
export interface ApprovalGrant {
  id: string;
  workspaceId: string;
  tool: string;
  /** Canonicalized bash command, or the tool's primary target, when the grant is target-scoped. */
  target: string | null;
  createdAt: string;
}

/**
 * True for the two tools where a target-less "always allow" would be a
 * WILDCARD grant of arbitrary code execution — it would auto-allow every
 * `bash` / `run_script` call. The grant writer refuses those; the checker
 * likewise refuses to match them on a target-less basis. Mirrors
 * CODE_EXEC_TOOLS in automation-approval.ts.
 */
const CODE_EXEC_TOOLS = new Set(["bash", "run_script"]);

/** True when the grant would be a wildcard execution grant. */
export function isWildcardExecGrant(tool: string, target: string | null | undefined): boolean {
  return CODE_EXEC_TOOLS.has(tool) && !target;
}

/**
 * All grants for a workspace, ordered oldest-first (the order the user
 * created them). Empty array, not null, when none exist.
 */
export function getWorkspaceApprovalGrants(db: Database.Database, workspaceId: string): ApprovalGrant[] {
  const rows = db.prepare(
    "SELECT id, workspace_id, tool, target, created_at FROM approval_grants WHERE workspace_id = ? ORDER BY created_at ASC",
  ).all(workspaceId) as Array<{ id: string; workspace_id: string; tool: string; target: string | null; created_at: string }>;
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, tool: r.tool, target: r.target, createdAt: r.created_at }));
}

/** One grant by id, or null when it doesn't exist. */
export function getApprovalGrantById(db: Database.Database, id: string): ApprovalGrant | null {
  const r = db.prepare("SELECT id, workspace_id, tool, target, created_at FROM approval_grants WHERE id = ?").get(id) as
    | { id: string; workspace_id: string; tool: string; target: string | null; created_at: string }
    | undefined;
  return r ? { id: r.id, workspaceId: r.workspace_id, tool: r.tool, target: r.target, createdAt: r.created_at } : null;
}

/**
 * Whether a workspace has a persistent grant covering a tool call.
 *
 * Two shapes, both exact-match:
 *  - tool grant — `target IS NULL`, covers every call to that tool (e.g. an
 *    MCP tool like `mcp__atlassian__create_issue` which has no derivable target)
 *  - command grant — `target = <canonical bash command>`, covers only that
 *    exact command (so `ls` can be granted without granting `rm -rf /`)
 */
export function isWorkspaceGranted(
  db: Database.Database,
  workspaceId: string,
  tool: string,
  target?: string | null,
): boolean {
  if (!workspaceId) return false;
  // Tool-scoped grant (`target IS NULL`) covers any call to that tool.
  // Target-less exec reads must NOT match a wildcard-less table, so refuse them
  // before they can match a legitimate tool-scoped grant for the same tool.
  if (isWildcardExecGrant(tool, target ?? null)) return false;

  // Check a tool-scoped grant first (covers bare-external tools).
  const toolGrant = db
    .prepare("SELECT 1 FROM approval_grants WHERE workspace_id = ? AND tool = ? AND target IS NULL")
    .get(workspaceId, tool) as { "1": number } | undefined;
  if (toolGrant) return true;

  if (target) {
    const cmdGrant = db
      .prepare("SELECT 1 FROM approval_grants WHERE workspace_id = ? AND tool = ? AND target = ?")
      .get(workspaceId, tool, target) as { "1": number } | undefined;
    if (cmdGrant) return true;
  }
  return false;
}

/**
 * Record a workspace-persistent "Always allow" grant. Idempotent — a second
 * call for the same (workspace, tool, target) is a no-op. Refuses to record a
 * target-less grant for a code-executing tool (see isWildcardExecGrant).
 *
 * Returns the grant record (new or existing), or null when refused.
 */
export function addWorkspaceApprovalGrant(
  db: Database.Database,
  workspaceId: string,
  tool: string,
  target?: string | null,
): ApprovalGrant | null {
  const canonTarget = target ?? null;
  if (isWildcardExecGrant(tool, canonTarget)) return null;

  const existing = canonTarget === null
    ? (db.prepare("SELECT id FROM approval_grants WHERE workspace_id = ? AND tool = ? AND target IS NULL").get(workspaceId, tool) as { id: string } | undefined)
    : (db.prepare("SELECT id FROM approval_grants WHERE workspace_id = ? AND tool = ? AND target = ?").get(workspaceId, tool, canonTarget) as { id: string } | undefined);
  if (existing) return getApprovalGrantById(db, existing.id);

  const id = newId();
  db.prepare("INSERT INTO approval_grants (id, workspace_id, tool, target) VALUES (?, ?, ?, ?)").run(id, workspaceId, tool, canonTarget);
  return getApprovalGrantById(db, id);
}

/** Remove one grant by id. Returns true when a row was deleted. */
export function deleteWorkspaceApprovalGrant(db: Database.Database, id: string): boolean {
  const res = db.prepare("DELETE FROM approval_grants WHERE id = ?").run(id);
  return res.changes > 0;
}

/** Remove every grant for a workspace. Returns the number deleted. */
export function clearWorkspaceApprovalGrants(db: Database.Database, workspaceId: string): number {
  const res = db.prepare("DELETE FROM approval_grants WHERE workspace_id = ?").run(workspaceId);
  return res.changes;
}
