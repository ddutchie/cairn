/**
 * Cairn — Chat session IPC. Chat history replays from the engine's session log,
 * the same source the coding-session load path uses.
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import type { ReplayMessage, ReplaySubagent } from "../../shared/agent/session-wire";
import { engineOwns, getEngineHost } from "./engine-bridge";
import type { ChatMessage } from "../../shared/types/chat";

function toChatMessages(threadId: string, messages: ReplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    threadId,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    reasoningItems: m.reasoningItems,
    reasoningModel: m.reasoningModel,
    toolCalls: m.toolCalls && m.toolCalls.length ? m.toolCalls.map((tc) => ({ ...tc, status: "done" as const })) : undefined,
    subagents: (m as ReplayMessage & { subagents?: ReplaySubagent[] }).subagents,
    stats: m.stats,
    // ReplayMessage does not currently preserve event timestamps. Do not stamp
    // every historical message with "now"; the renderer will omit the label.
    createdAt: "",
  } as ChatMessage));
}

export function registerChatSessionHandlers(ctxDb: DbContext): void {
  registerContractHandle("db:chat:sessionMessages", (_e, { threadId }) => handle(async () => {
    if (!threadId) return { messages: [] as ChatMessage[] };
    if (await engineOwns(ctxDb, `chat-${threadId}`)) {
      const { messages, usage, title, contextRing, todos } = await getEngineHost(ctxDb).loadMessages(`chat-${threadId}`);
      return { messages: toChatMessages(threadId, messages), usage, title, contextRing, todos };
    }
    return { messages: [] as ChatMessage[] };
  }));

  // ── Session title (chat-only, phase 1) ───────────────────────────────────
  // Direct read of the latest folded title for one chat thread (session:projection
  // is the live push path; this is the cold read / reload path).
  registerContractHandle("session:title", (_e, { threadId, sessionId }) => handle(async () => {
    const sid = sessionId ?? (threadId ? `chat-${threadId}` : "");
    if (!sid || !sid.startsWith("chat-")) return { title: null as string | null };
    if (await engineOwns(ctxDb, sid)) return { title: await getEngineHost(ctxDb).title(sid) };
    return { title: null as string | null };
  }));

  // Manual rename — pins the title (kind:'user'). Chat-only.
  registerContractHandle("session:renameTitle", (_e, { threadId, sessionId, title }) => handle(async () => {
    const sid = sessionId ?? (threadId ? `chat-${threadId}` : "");
    if (!sid || !sid.startsWith("chat-")) throw new Error("renameTitle: only chat threads can be renamed");
    if (typeof title !== "string" || !title.trim()) throw new Error("renameTitle: title must be non-empty");
    const renamedTitle = await getEngineHost(ctxDb).rename(sid, title, ctxDb.workspacePath);
    try {
      const q = await import("../db/queries");
      const db = ctxDb.db;
      const targetId = threadId ?? sid.replace(/^chat-/, "");
      const row = db.prepare("SELECT workspace_id, scope, project_id, use_subagents FROM chat_threads WHERE id = ?").get(targetId) as
        | { workspace_id: string; scope: string; project_id: string | null; use_subagents: number | null }
        | undefined;
      const wsId = row?.workspace_id ?? "";
      const scope = row?.scope ?? "workspace";
      const pid = row?.project_id ?? undefined;
      // upsertChatThread rewrites use_subagents too — carry the stored value.
      if (wsId) q.upsertChatThread(db, { id: targetId, scope, workspaceId: wsId, projectId: pid ?? undefined, title: renamedTitle, useSubagents: !!row?.use_subagents });
    } catch { }
    return { title: renamedTitle };
  }));
}
