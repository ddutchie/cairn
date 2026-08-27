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
    stats: m.stats,
    // ReplayMessage does not currently preserve event timestamps. Do not stamp
    // every historical message with "now"; the renderer will omit the label.
    createdAt: "",
  } as ChatMessage));
}

export function registerChatSessionHandlers(_ctx: DbContext): void {
  registerIpcHandle("db:chat:sessionMessages", (_e, { threadId }: { threadId: string }) => handle(async () => {
    if (!threadId) return { messages: [] as ChatMessage[] };
    try {
      const { getContext, prepareReplayContext } = await import("../cordis/run-cordis-loop");
      const ctx = await getContext();
      const pers = (ctx as unknown as { sessionPersistence?: Parameters<typeof loadSessionMessages>[0] }).sessionPersistence;
      if (!pers) return { messages: [] as ChatMessage[] };

      // Plugin toolviews register through inject-gated backends that wait for
      // the fs chain (only mounted by chat turns) — mount + settle so the
      // tools registry can serve presentationMeta for enrichment below.
      const stableId = String(SessionId(`chat-${threadId}`));
      await prepareReplayContext(pers as { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> }, stableId);
      const liveSessions = (ctx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((ctx as unknown as { sessions: unknown }).sessions);
      const { messages, usage, contextRing, todos, stats } = await loadSessionMessages(pers, liveSessions, stableId);
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      const chatMessages = toChatMessages(threadId, enrichToolCallsWithMeta(messages));

      return {
        messages: chatMessages,
        usage,
        contextRing,
        todos,
        stats,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("no such") || msg.includes("ENOENT") || msg.includes("but this backend is configured for compression") || msg.includes("encodingMismatch")) return { messages: [] as ChatMessage[] };
      throw err;
    }
  }));
}
