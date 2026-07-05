/**
 * IPC handlers for desktop sync (folder connect + manual sync + status).
 *
 * Lives under electron/sync/ (type-checked via tsconfig.shared.json) so it can
 * import the repo-root shared sync engine without tripping the electron
 * tsconfig rootDir. Registered from ipc/handlers.ts.
 */

import { dialog } from "electron";
import type Database from "better-sqlite3";
import { getSyncFolder, setSyncFolder, clearSyncFolder, syncDesktop } from "./desktop-sync";

interface SyncHandlerCtx {
  db: Database.Database;
  getWin: () => import("electron").BrowserWindow | null;
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
        return chosen;
      })) as never,
  );

  register("sync:clearFolder", (() => wrap(() => {
    clearSyncFolder(ctx.db);
    return { ok: true };
  })) as never);

  register("sync:now", (() => wrap(() => syncDesktop(ctx.db))) as never);
}
