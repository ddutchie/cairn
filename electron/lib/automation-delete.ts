/**
 * Automation delete with retry-safe cleanup ordering (issue #133).
 *
 * The old `db:automation:delete` IPC handler removed the DB row FIRST and then
 * cleaned up the on-disk folder + keychain secrets best-effort. If either
 * cleanup failed, the orphaned artifacts lingered with no way to retry — the
 * row (the only handle back to them) was already gone.
 *
 * This helper inverts the order: keychain secrets and the on-disk folder are
 * removed BEFORE the DB row. A cleanup failure throws, the row is kept, and a
 * later delete retries from scratch (secret purge is idempotent, folder
 * removal is re-attempted). Only when both cleanups succeed is the row
 * deleted.
 *
 * Pure fs/keychain operations are injectable via `deps` so the ordering is
 * unit-testable without Electron's safeStorage.
 */

import type Database from "better-sqlite3";
import { getAutomationById, deleteAutomation } from "../db/automation-queries";
import { automationFolderDir, removeAutomationDir } from "./automation-folder";
import { deleteToolSecrets } from "./secure-store";

export interface AutomationDeleteDeps {
  /** Purge the automation's keychain secrets. Defaults to deleteToolSecrets("automation", id). */
  purgeSecrets?: (automationId: string) => void;
  /** Remove the automation's folder. Returns true when gone. Defaults to removeAutomationDir. */
  removeDir?: (folder: string) => boolean;
  /** Resolve the owning project's display name (for folder placement). Defaults to a projects-table lookup. */
  projectNameFor?: (projectId: string) => string | null;
}

function defaultProjectNameFor(db: Database.Database, projectId: string): string {
  // Strict: a non-null project_id must resolve to a real project. Falling back
  // to null here would target the workspace-level folder (usually absent, so
  // removal reports success) and delete the row while the real project folder
  // remains — exactly the orphan this helper exists to prevent. DB errors
  // propagate for the same reason. project_id = NULL stays the intentional
  // workspace-scoped case (handled by the caller, never reaching this fn).
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
    | { name: string }
    | undefined;
  if (!row) {
    throw new Error(`project ${projectId} was not found`);
  }
  return row.name;
}

export function deleteAutomationWithCleanup(
  db: Database.Database,
  workspacePath: string,
  automationId: string,
  deps: AutomationDeleteDeps = {},
): { ok: boolean; deleted: boolean } {
  const automation = getAutomationById(db, automationId);
  if (!automation) return { ok: false, deleted: false };

  const projectName = automation.projectId
    ? (deps.projectNameFor
        ? deps.projectNameFor(automation.projectId)
        : defaultProjectNameFor(db, automation.projectId))
    : null;
  const folder = automationFolderDir(workspacePath, automation.id, projectName);

  // 1. Keychain secrets first — throws on failure, row is kept for retry.
  const purge = deps.purgeSecrets ?? ((id: string) => deleteToolSecrets("automation", id));
  purge(automation.id);

  // 2. On-disk folder second — a `false` return (or throw) keeps the row for retry.
  const remove = deps.removeDir ?? removeAutomationDir;
  let removed: boolean;
  try {
    removed = remove(folder);
  } catch (err) {
    throw new Error(
      `failed to remove automation folder ${folder}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!removed) {
    throw new Error(`failed to remove automation folder ${folder}`);
  }

  // 3. Only now delete the row — both cleanups succeeded.
  const deleted = deleteAutomation(db, automation.id);
  return { ok: true, deleted };
}
