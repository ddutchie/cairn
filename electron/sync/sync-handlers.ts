/**
 * IPC handlers for desktop sync (folder connect + manual sync + status +
 * conflict resolution).
 *
 * Lives under electron/sync/ (type-checked via tsconfig.shared.json) so it can
 * import the repo-root shared sync engine without tripping the electron
 * tsconfig rootDir. Registered from ipc/handlers.ts.
 */

import { dialog, type IpcMainInvokeEvent } from "electron";
import type { IpcArgs, IpcChannel, IpcReturn } from "../../shared/ipc/contract";
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
  listSyncActivity,
  listRestorableNotes,
  restoreDeletedNote,
  repairNoteFile,
  listPeerProtocols,
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

// Typed against the IPC contract so each handler's args/result are checked, but
// passed in rather than imported: ipc/registry and result-helpers are
// electron-tsconfig-scoped and this file is shared-tsconfig-scoped.
type IpcResult<T> = { data: T } | { error: string };
type RegisterFn = <C extends IpcChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => Promise<IpcResult<IpcReturn<C>>>,
) => void;
type WrapFn = <T>(fn: () => T | Promise<T>) => Promise<IpcResult<T>>;

/**
 * Register sync:* channels. `register` is ipc/registry's registerContractHandle
 * and `wrap` is result-helpers' `handle`.
 */
export function registerSyncHandlers(
  ctx: SyncHandlerCtx,
  register: RegisterFn,
  wrap: WrapFn,
): void {
  register("sync:getFolder", () => wrap(() => getSyncFolder(ctx.db)));

  register("sync:selectFolder", () =>
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
    }),
  );

  register("sync:clearFolder", () => wrap(() => {
    clearSyncFolder(ctx.db);
    refreshSyncStatus(ctx.db);
    return { ok: true as const };
  }));

  register("sync:now", () => wrap(async () => {
    const result = await syncDesktop(ctx.db);
    // Parity with the background sync loop (main.ts): if peer ops were applied,
    // tell the renderer/mobile clients to re-hydrate so pulled edits show up.
    if (result.peerOpsApplied > 0 || result.conflictCopies > 0) ctx.broadcastDbChanged();
    return result;
  }));

  // Current live status snapshot (the renderer also subscribes to pushed
  // `sync:status` events; this is the initial fetch on mount).
  register("sync:status", () => wrap(() => getSyncStatus()));

  // Diagnostic: what's staged in sync_pending right now (entity/op/count +
  // sample ids). Used to explain a stuck / regenerating "pending N" count.
  register("sync:pendingBreakdown", () => wrap(() => pendingBreakdown(ctx.db)));

  // Conflict copies awaiting manual resolution.
  register("sync:listConflicts", () => wrap(() => listConflictCopies(ctx.db)));

  register("sync:resolveConflict", (_e, args) =>
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
    }),
  );

  // What sync decided on recent incoming ops (applied / skipped-stale /
  // conflict-copy / delete-won) — explains a surprise vanish or resurrect.
  register("sync:activity", (_e, args) => wrap(() => listSyncActivity(ctx.db, args?.limit ?? 100)));

  // Peers on an older (or newer) sync protocol than this build.
  register("sync:peerProtocols", () => wrap(() => listPeerProtocols(ctx.db)));

  // Notes a peer deleted that can still be brought back.
  register("sync:listRestorable", (_e, args) => wrap(() => listRestorableNotes(ctx.db, args?.limit ?? 50)));

  register("sync:restoreNote", (_e, args) =>
    wrap(() => {
      if (!args?.id) throw new Error("sync:restoreNote requires an id");
      const res = restoreDeletedNote(ctx.db, args.id, ctx.conflictDeps);
      refreshSyncStatus(ctx.db);
      ctx.broadcastDbChanged();
      return res;
    }),
  );

  // Retry the file write for a restore whose DB half already landed. The row is
  // live by then, so `sync:restoreNote` would refuse it — this is the repair.
  register("sync:repairNoteFile", (_e, args) =>
    wrap(() => {
      if (!args?.id) throw new Error("sync:repairNoteFile requires an id");
      const res = repairNoteFile(ctx.db, args.id, ctx.conflictDeps);
      ctx.broadcastDbChanged();
      return res;
    }),
  );
}
