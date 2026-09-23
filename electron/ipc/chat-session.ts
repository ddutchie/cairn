/**
 * Cairn — Chat session IPC (dsh as source of truth).
 *
 * Loads chat history directly from dsh's JSONL session log via the shared
 * session-replay helpers (electron/cordis/session-replay.ts), which use the
 * canonical surface (foldSurface + deriveEventMessage) and attach subagent
 * children. The coding-session load path uses the SAME helpers so both surfaces
 * stay in lockstep (session-as-truth, not the duplicated SQLite tables).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { SessionId } from "@deepseek-ai/dsh-session";
import { type ReplayMessage, type ReplaySubagent } from "../cordis/session-replay";
import { getAgentHost } from "../cordis/agent-host";
import type { ChatMessage } from "../../src/types";

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
  registerIpcHandle("db:chat:sessionMessages", (_e, { threadId }: { threadId: string }) => handle(async () => {
    if (!threadId) return { messages: [] as ChatMessage[] };
    try {
      const stableId = String(SessionId(`chat-${threadId}`));
      const { messages, usage, contextRing, todos, stats, title } = await getAgentHost().loadSessionMessages(stableId);
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      const chatMessages = toChatMessages(threadId, enrichToolCallsWithMeta(messages));

      return {
        messages: chatMessages,
        usage,
        contextRing,
        todos,
        stats,
        title: title ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("no such") || msg.includes("ENOENT") || msg.includes("but this backend is configured for compression") || msg.includes("encodingMismatch")) return { messages: [] as ChatMessage[] };
      throw err;
    }
  }));

  // ── Session title (chat-only, phase 1) ───────────────────────────────────
  // Direct read of the latest folded title for one chat thread (session:projection
  // is the live push path; this is the cold read / reload path).
  registerIpcHandle("session:title", (_e, { threadId, sessionId }: { threadId?: string; sessionId?: string }) => handle(async () => {
    const sid = sessionId ?? (threadId ? String(SessionId(`chat-${threadId}`)) : "");
    if (!sid || !sid.startsWith("chat-")) return { title: null as string | null };
    try {
      return { title: await getAgentHost().readSessionTitle(sid) };
    } catch {
      return { title: null as string | null };
    }
  }));

  // Manual rename — pins the title (kind:'user'). Chat-only.
  registerIpcHandle("session:renameTitle", (_e, { threadId, sessionId, title }: { threadId?: string; sessionId?: string; title: string }) => handle(async () => {
    const sid = sessionId ?? (threadId ? String(SessionId(`chat-${threadId}`)) : "");
    if (!sid || !sid.startsWith("chat-")) throw new Error("renameTitle: only chat threads can be renamed");
    if (typeof title !== "string" || !title.trim()) throw new Error("renameTitle: title must be non-empty");
    const renamedTitle = await getAgentHost().renameSessionTitle(sid, title);
    try {
      const q = await import("../db/queries");
      const db = ctxDb.db;
      const targetId = threadId ?? sid.replace(/^chat-/, "");
      const row = db.prepare("SELECT workspace_id, scope, project_id FROM chat_threads WHERE id = ?").get(targetId) as
        | { workspace_id: string; scope: string; project_id: string | null }
        | undefined;
      const wsId = row?.workspace_id ?? "";
      const scope = row?.scope ?? "workspace";
      const pid = row?.project_id ?? undefined;
      if (wsId) q.upsertChatThread(db, { id: targetId, scope, workspaceId: wsId, projectId: pid ?? undefined, title: renamedTitle });
    } catch { }
    return { title: renamedTitle };
  }));
}
