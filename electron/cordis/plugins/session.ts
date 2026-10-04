import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import "../ctx-augment";
import { getDb, getHost } from "./db";

// ── cairn-session ───────────────────────────────────────────────────────────
export interface CairnSessionConfig {
  threadId: string;
  workspaceId: string;
  projectId?: string;
}

/** Extract the plain-text content of a message event. Handles both the
 *  `data.message.content` shape (assistant/message) and the `data.content`
 *  shape (user/message on the live session/event stream, where content sits
 *  directly on data — the previous data.message.content read returned "" for
 *  user messages, so a subagent's instruction fell back to "subagent"). */
export function eventText(event: SessionEvent): string {
  const d = event.data as { message?: { content?: Array<{ type: string; text?: string }> }; content?: Array<{ type: string; text?: string }> };
  const content = d.message?.content ?? d.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
  }
  return "";
}

/** Extract reasoning text + items from an assistant/message event. */
export function eventReasoning(event: SessionEvent): { reasoning: string; items?: Array<Record<string, unknown>> } {
  if (event.type !== "assistant/message") return { reasoning: "" };
  const content = (event.data as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content;
  let reasoning = "";
  const items: Array<Record<string, unknown>> = [];
  for (const b of content) {
    if (b.type === "reasoning") reasoning += String(b.text ?? "");
    else if (b.reasoning && typeof b.reasoning === "string") items.push(b as Record<string, unknown>);
  }
  return { reasoning, items: items.length ? items : undefined };
}

/** Index a dsh session's thread in SQLite; messages live in the JSONL log (not `chat_messages`).
 *
 *  Previously this also duplicated every `user/message`/`assistant/message` into
 *  `chat_messages` (and `useChatStream onDone` did the same), causing the
 *  `rSle/Hwx 171ms` double-final and `GpKH` reasoning-only ghost. `chat_messages`
 *  is now legacy — the session log (`JsonlSessionPersistence` `chat-<threadId>`)
 *  is the durable transcript and `db:chat:sessionMessages` reads it directly.
 *  This plugin only maintains the lightweight `chat_threads` index for the thread
 *  list; message history is never written to SQLite here.
 */
export function cairnSessionPlugin(ctx: Context, config: CairnSessionConfig): void {
  const { threadId, workspaceId, projectId } = config;
  const seen = new Set<string>();

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    const key = `${session.id}:${event.seq}`;
    if (seen.has(key)) return;
    seen.add(key);

    const db = getDb(ctx);
    if (!db) return;

    try {
      getHost(ctx, db)?.indexChatThread(threadId, workspaceId, projectId);
    } catch { /* non-fatal */ }
  });
}
