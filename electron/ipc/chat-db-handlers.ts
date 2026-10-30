/**
 * Cairn — IPC handler for chat-thread CRUD channels (`db:chat:*`).
 *
 * Note: the streaming chat (`session:prompt` / `session:abort` / `chat:compactThread`)
 * lives in `electron/ipc/chat.ts`. These handlers are the simpler CRUD surface
 * used by the renderer to populate the thread list + message history.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { assertSafeId, isSafeId } from "./path-safety";
import { forgetEngineSession, getEngineHost, removeLegacySessions } from "./engine-bridge";

/** Drop a chat thread's engine log (and its subagents') along with the legacy one. */
async function destroyEngineThread(ctx: DbContext, threadId: string): Promise<void> {
  const sessionId = `chat-${threadId}`;
  forgetEngineSession(sessionId);
  await getEngineHost(ctx).destroy(sessionId).catch(() => undefined);
  // The retired harness's copy would otherwise be re-imported on the next touch.
  removeLegacySessions((name) => name === sessionId || name === threadId || name.startsWith(`${sessionId}-`));
}

export function registerChatDbHandlers(ctx: DbContext): void {
  // Legacy SQLite transcript tables are reset by migrations v49/v51; history lives in the engine's session logs.
  registerContractHandle("db:chat:threads", (_e, { workspaceId }) => handle(() => q.getChatThreads(ctx.db, workspaceId)));
  registerContractHandle("db:chat:upsertThread", (_e, args) => handle(() => q.upsertChatThread(ctx.db, args)));

  // db:chat:clearThreadMessages — wipe the thread's session log (and its subagents').
  registerContractHandle("db:chat:clearThreadMessages", (_e, { threadId }) => handle(async () => {
    // Reject renderer-supplied ids that could path-traverse before they reach
    // fs.rmSync() below. Any legitimate `thr-<nanoid>` passes; `..`, `/`, `\`,
    // empty, over-length, control chars all fail here.
    assertSafeId(threadId, "threadId");
    // Chat todo snapshots use the dsh session id, not the chat-thread id. Clear
    // both forms so a stale todo list cannot reappear when the thread resumes
    // after its transcript has been wiped.
    q.saveSessionTodos(ctx.db, `chat-${threadId}`, []);
    q.saveSessionTodos(ctx.db, threadId, []);
    await destroyEngineThread(ctx, threadId);
  }));

  registerContractHandle("db:chat:clearAllThreads", (_e, { workspaceId, projectId }) => handle(async () => {
    const threads = q.getChatThreads(ctx.db, workspaceId).filter((t) => !projectId || t.projectId === projectId);
    // Ids come from SQLite, but filter for path-safety anyway — a corrupt row
    // (e.g. from a compromised sync peer or a manual DB edit) must not turn
    // this handler into a path-traversal sink.
    const ids = threads.map((t) => t.id).filter(isSafeId);
    if (ids.length === 0) return { deletedThreads: 0, deletedMessages: 0 };
    const placeholders = ids.map(() => "?").join(",");
    ctx.db.prepare(`DELETE FROM chat_threads WHERE id IN (${placeholders})`).run(...ids);
    for (const id of ids) await destroyEngineThread(ctx, id);
    return { deletedThreads: ids.length, deletedMessages: 0 };
  }));

  registerContractHandle("db:chat:deleteThread", (_e, { threadId }) => handle(async () => {
    q.deleteChatThread(ctx.db, threadId);
    if (isSafeId(threadId)) await destroyEngineThread(ctx, threadId);
  }));
}
