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

  // db:chat:clearThreadMessages — direct SQL DELETE + Cordis jsonl clear.
  // TODO (P2 follow-up): promote to q.clearChatThreadMessages in db/queries.ts.
  registerIpcHandle("db:chat:clearThreadMessages", (_e, { threadId }) => handle(() => {
    ctx.db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
    // Cordis path: also clear the dsh jsonl transcript so a resumed chat
    // session doesn't see old messages (mirrors pi-agent:clear at pi-agent.ts:797).
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const { getSessionRoot } = require("../cordis/run-cordis-loop");
      const root = (getSessionRoot as () => string)();
      const base = path.join(root, threadId);
      const candidates = [base + ".jsonl", path.join(base, "session.jsonl"), base];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            const stat = fs.statSync(p);
            if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
            else fs.unlinkSync(p);
          }
        } catch { /* ignore per candidate */ }
      }
      const { getContext } = require("../cordis/run-cordis-loop");
      getContext().then((c: unknown) => {
        const maybeAgents = (c as { agents?: { get?: (id: string) => unknown; delete?: (id: string) => void; remove?: (id: string) => void } })?.agents;
        try { (maybeAgents?.delete ?? maybeAgents?.remove)?.call(maybeAgents, threadId); } catch { /* ignore */ }
      }).catch(() => {});
    } catch { /* best-effort */ }
  }));

  registerIpcHandle("db:chat:deleteThread", (_e, { threadId }) => handle(() => q.deleteChatThread(ctx.db, threadId)));
}
