/**
 * Cairn — IPC result helpers + shared context.
 *
 * Every IPC handler returns IpcResult<T> = { data: T } | { error: string }.
 * `handle` wraps a synchronous or async fn in try/catch and produces the result
 * shape; the renderer's ipcAwait helper checks for { error } and surfaces it.
 *
 * Same `DbContext` is used by every per-domain registrar in `electron/ipc/*`.
 */

import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";

export function ok<T>(data: T): { data: T } {
  return { data };
}

export function err(message: string): { error: string } {
  return { error: message };
}

export type IpcResult<T> = { data: T } | { error: string };

/**
 * Wrap a synchronous or async handler body in try/catch.
 * Returns { data } on success, { error } on failure.
 */
export function handle<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(() => fn())
    .then(ok)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[cairn:ipc:error]", msg);
      return err(msg);
    });
}

/**
 * Resolve a project's display name. Falls back to the projectId if the project
 * was deleted between dispatch and lookup (rare but possible during teardown).
 */
export function getProjectName(db: Database.Database, projectId: string): string {
  const project = q.getProjectById(db, projectId);
  return project?.name ?? projectId;
}

// Avoid a static import cycle: handlers import this module at module-eval time,
// but `q.*` pulls in only code-free type information via Database. Lazy import
// keeps the dependency graph consistent with the rest of electron/ipc/.
import * as q from "../db/queries";

/** Mutable context swapped in-place by main.ts when the workspace changes. */
export interface DbContext {
  db: Database.Database;
  workspacePath: string;
  /** Returns the current BrowserWindow, or null before it is created. */
  getWin: () => BrowserWindow | null;
}
