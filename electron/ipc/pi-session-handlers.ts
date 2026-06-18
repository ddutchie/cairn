/**
 * Cairn — IPC handlers for Pi Agent session persistence (`db:piSession:*`).
 *
 * The agent loop itself lives in `electron/ipc/pi-agent.ts` (streaming events
 * via `pi-agent:*`). These channels are the SQLite read/write surface used by
 * the renderer's SessionPane to load and save session history.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";

export function registerPiSessionHandlers(ctx: DbContext): void {
  registerIpcHandle("db:piSession:list", (_e, { projectId }) => handle(() => q.getPiSessions(ctx.db, projectId)));
  registerIpcHandle("db:piSession:create", (_e, args: Parameters<typeof q.createPiSession>[1]) => handle(() => q.createPiSession(ctx.db, args)));
  registerIpcHandle("db:piSession:delete", (_e, { id }) => handle(() => q.deletePiSession(ctx.db, id)));
  registerIpcHandle("db:piSession:messages", (_e, { sessionId }) => handle(() => q.getPiMessages(ctx.db, sessionId)));
  registerIpcHandle("db:piSession:saveMessages", (_e, { sessionId, messages }) => handle(() => q.savePiMessages(ctx.db, sessionId, messages)));
}
