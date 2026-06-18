/**
 * Cairn — IPC handlers for the Obsidian→Cairn migration tool (`app:*igration*`).
 *
 * Pauses the file watcher around the migration so the watcher doesn't double-write
 * files mid-import. Streams progress events back to the renderer.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { checkMigrations, runMigration } from "../migrations";
import { pauseFileWatcher, resumeFileWatcher } from "../file-watcher";

export function registerMigrationHandlers(ctx: DbContext): void {
  registerIpcHandle("app:checkMigrations", () => handle(() =>
    checkMigrations(ctx.workspacePath)
  ));

  registerIpcHandle("app:runMigration", (_e, { migrationId }: { migrationId: string }) =>
    handle(async () => {
      pauseFileWatcher();
      try {
        await runMigration(ctx.workspacePath, migrationId, (pct, msg) => {
          // Send progress events to the renderer
          const activeWin = ctx.getWin();
          if (activeWin && !activeWin.isDestroyed()) {
            activeWin.webContents.send("app:migrationProgress", { migrationId, pct, msg });
          }
        });
        return { ok: true };
      } finally {
        resumeFileWatcher();
      }
    })
  );
}
