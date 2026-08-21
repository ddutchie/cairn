/**
 * Cairn — Chat session IPC (dsh as source of truth).
 *
 * Loads chat history directly from dsh's JSONL session log via the shared
 * session-replay helpers (electron/cordis/session-replay.ts), which use the
 * canonical surface (foldSurface + deriveEventMessage) and attach subagent
 * children. The pi-agent/coding load path uses the SAME helpers so both surfaces
 * stay in lockstep (session-as-truth, not the duplicated SQLite tables).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { SessionId } from "@deepseek-ai/dsh-session";
import { loadSessionMessages, type ReplayMessage, type ReplaySubagent } from "../cordis/session-replay";
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
    createdAt: new Date().toISOString(),
  } as ChatMessage));
}

export function registerChatSessionHandlers(_ctx: DbContext): void {
  registerIpcHandle("db:chat:sessionMessages", (_e, { threadId }: { threadId: string }) => handle(async () => {
    if (!threadId) return [] as ChatMessage[];
    try {
      const { getContext } = await import("../cordis/run-cordis-loop");
      const ctx = await getContext();
      const pers = (ctx as unknown as { sessionPersistence?: Parameters<typeof loadSessionMessages>[0] }).sessionPersistence;
      if (!pers) return [] as ChatMessage[];
      const liveSessions = (ctx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((ctx as unknown as { sessions: unknown }).sessions);
      const stableId = String(SessionId(`chat-${threadId}`));
      const { messages } = await loadSessionMessages(pers, liveSessions, stableId);
      // presentationMeta is not persisted in the session log — recompute from
      // the registered tool defs so rich toolviews (dsh-visualize) render.
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      return toChatMessages(threadId, enrichToolCallsWithMeta(messages));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("no such") || msg.includes("ENOENT")) return [] as ChatMessage[];
      throw err;
    }
  }));

  registerIpcHandle("db:chat:sessionThreads", (_e, { workspaceId }: { workspaceId: string }) => handle(async () => {
    void workspaceId;
    return [] as unknown[];
  }));
}
