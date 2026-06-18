/**
 * Cairn — IPC handler for chat-thread CRUD channels (`db:chat:*`).
 *
 * Note: the streaming chat (`chat:stream` / `chat:abort` / `chat:compactThread`)
 * lives in `electron/ipc/chat.ts`. These handlers are the simpler CRUD surface
 * used by the renderer to populate the thread list + message history.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";

export function registerChatDbHandlers(ctx: DbContext): void {
  registerIpcHandle("db:chat:threads", (_e, { workspaceId }) => handle(() => q.getChatThreads(ctx.db, workspaceId)));
  registerIpcHandle("db:chat:messages", (_e, { threadId }) => handle(() => q.getChatMessages(ctx.db, threadId)));
  registerIpcHandle("db:chat:upsertThread", (_e, args: Parameters<typeof q.upsertChatThread>[1]) => handle(() => q.upsertChatThread(ctx.db, args)));
  registerIpcHandle("db:chat:addMessage", (_e, args: Parameters<typeof q.addChatMessage>[1]) => handle(() => q.addChatMessage(ctx.db, args)));

  // db:chat:clearThreadMessages — direct SQL DELETE.
  // TODO (P2 follow-up): promote to q.clearChatThreadMessages in db/queries.ts.
  registerIpcHandle("db:chat:clearThreadMessages", (_e, { threadId }) => handle(() => {
    ctx.db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
  }));

  registerIpcHandle("db:chat:deleteThread", (_e, { threadId }) => handle(() => q.deleteChatThread(ctx.db, threadId)));
}
