/**
 * IPC handlers for desktop sync (folder connect + manual sync + status +
 * conflict resolution).
 *
 * Lives under electron/sync/ (type-checked via tsconfig.shared.json) so it can
 * import the repo-root shared sync engine without tripping the electron
 * tsconfig rootDir. Registered from ipc/handlers.ts.
 */

import { dialog } from "electron";
import type Database from "better-sqlite3";
import {
  getSyncFolder,
  setSyncFolder,
  clearSyncFolder,
  syncDesktop,
  getSyncStatus,
  refreshSyncStatus,
  pendingBreakdown,
  listConflictCopies,
  resolveConflict,
  type ConflictResolveDeps,
} from "./desktop-sync";

interface SyncHandlerCtx {
  db: Database.Database;
  getWin: () => import("electron").BrowserWindow | null;
  /**
   * How to apply a conflict resolution to a note + its .md file. Supplied by
   * ipc/handlers.ts (which owns the electron-scoped notes-files helpers and the
   * file-watcher echo-suppression) so this shared-scoped module stays free of
   * electron-tsconfig imports.
   */
  conflictDeps: ConflictResolveDeps;
  /** Ask the renderer/mobile to re-hydrate after a resolution changed rows. */
  broadcastDbChanged: () => void;
}

// Loosely typed to match ipc/registry's registerIpcHandle without importing it
// (that module is electron-tsconfig-scoped; this file is shared-tsconfig-scoped).
type RegisterFn = (channel: string, handler: (event: never, ...args: never[]) => unknown) => void;
type WrapFn = <T>(fn: () => T | Promise<T>) => unknown;

/**
 * Register sync:* channels. `register` is ipc/registry's registerIpcHandle and
 * `wrap` is result-helpers' `handle` (kept as params so this file needs no
 * electron-tsconfig-scoped imports).
 */
export function registerSyncHandlers(
  ctx: SyncHandlerCtx,
  register: RegisterFn,
  wrap: WrapFn,
): void {
  register("sync:getFolder", (() => wrap(() => getSyncFolder(ctx.db))) as never);

  register(
    "sync:selectFolder",
    (async () =>
      wrap(async () => {
        const win = ctx.getWin();
        const result = await dialog.showOpenDialog(win ?? undefined!, {
          title: "Select the shared Cairn sync folder (e.g. iCloud Drive → Cairn)",
          message: "Pick the SAME folder your phone will connect to. Only oplog files are written here — never the database.",
          buttonLabel: "Use This Folder",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        const chosen = result.filePaths[0];
        setSyncFolder(ctx.db, chosen);
        refreshSyncStatus(ctx.db);
        return chosen;
      })) as never,
  );

  register("sync:clearFolder", (() => wrap(() => {
    clearSyncFolder(ctx.db);
    refreshSyncStatus(ctx.db);
    return { ok: true };
  })) as never);

  register("sync:now", (() => wrap(async () => {
    const result = await syncDesktop(ctx.db);
    // Parity with the background sync loop (main.ts): if peer ops were applied,
    // tell the renderer/mobile clients to re-hydrate so pulled edits show up.
    if (result.peerOpsApplied > 0 || result.conflictCopies > 0) ctx.broadcastDbChanged();
    return result;
  })) as never);

  // Current live status snapshot (the renderer also subscribes to pushed
  // `sync:status` events; this is the initial fetch on mount).
  register("sync:status", (() => wrap(() => getSyncStatus())) as never);

  // Diagnostic: what's staged in sync_pending right now (entity/op/count +
  // sample ids). Used to explain a stuck / regenerating "pending N" count.
  register("sync:pendingBreakdown", (() => wrap(() => pendingBreakdown(ctx.db))) as never);

  // Conflict copies awaiting manual resolution.
  register("sync:listConflicts", (() => wrap(() => listConflictCopies(ctx.db))) as never);

  register(
    "sync:resolveConflict",
    (((_e: never, args: { copyId: string; action: "keepCopy" | "keepOriginal" | "keepMerged"; mergedContent?: string }) =>
      wrap(() => {
        let resolveArg: { action: "keepCopy" | "keepOriginal" } | { action: "keepMerged"; mergedContent: string };
        if (args.action === "keepMerged") {
          // Guard against a caller sending keepMerged without a body — writing
          // an empty string would silently blank the note. Reject instead.
          if (typeof args.mergedContent !== "string") {
            throw new Error("sync:resolveConflict keepMerged requires mergedContent");
          }
          resolveArg = { action: "keepMerged", mergedContent: args.mergedContent };
        } else {
          resolveArg = { action: args.action };
        }
        const res = resolveConflict(ctx.db, args.copyId, resolveArg, ctx.conflictDeps);
        refreshSyncStatus(ctx.db);
        ctx.broadcastDbChanged();
        return res;
      })) as never),
  );
}
