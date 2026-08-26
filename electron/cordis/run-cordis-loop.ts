/** Public chat loop surface and compatibility exports for Cordis helpers. */
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Database } from "better-sqlite3";
import { openCordisSessionAgent } from "./session-agent";
import { peekChatAgentCache, getChatAgentCache } from "./chat-agent-cache";
import { getContext, resolvePresentationMeta } from "./cordis-context";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

export { getContext, dropChatAgentForThread, resolvePresentationMeta, getSessionRoot, setSessionRoot, __setToolDefForTest } from "./cordis-context";
export { ensureAgentAiAdapter } from "./session-runtime";

export interface RunCordisLoopResult {
  exhausted: boolean;
  content: string;
  reasoning: string;
  reasoningSummary?: string;
  reasoningItems?: Array<Record<string, unknown>>;
  reasoningField?: string;
  reasoningModel?: string;
}

export interface RunCordisLoopOptions {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  llmConfig: LLMConfig;
  onToken?: (delta: string) => void;
  onThought?: (delta: string) => void;
  onUsage?: (pt: number, ct: number, rt?: number, costUsd?: number, cacheReadTokens?: number, cacheCreationTokens?: number) => void;
  emitToolCall?: (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void;
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string; meta?: unknown }) => void;
  sendSubagent?: (channel: string, payload: Record<string, unknown>) => void;
  questions?: { send: (channel: string, payload: Record<string, unknown>) => void; emitQuestions?: (requestId: string, questions: unknown[]) => void; registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void };
  getWin?: () => Electron.BrowserWindow | null;
  signal?: AbortSignal;
  onSessionEvent?: (event: SessionEvent) => void;
}

export function enrichToolCallsWithMeta<T extends { toolCalls?: Array<{ tool: string; args?: string; output?: string; meta?: unknown }> }>(messages: T[]): T[] {
  for (const message of messages) for (const call of message.toolCalls ?? []) if (call.meta === undefined) call.meta = resolvePresentationMeta(call.tool, call.args, call.output);
  return messages;
}

export async function prepareReplayContext(pers: { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> }, sessionId: string): Promise<void> {
  try {
    const { pluginsDevEnabled } = await import("./plugin-loader");
    if (!pluginsDevEnabled()) return;
    const ctx = await getContext();
    if (!ctx.get("fs")) {
      let cwd: string | undefined;
      try { cwd = (await pers.inspect(sessionId))?.header?.cwd; } catch { /* fall back */ }
      const { mountFsChain } = await import("./cordis-coding-tools");
      await mountFsChain(ctx, { cwd: cwd || process.cwd() });
    }
    const { settleLoader } = await import("./plugin-loader");
    await settleLoader(ctx);
  } catch (err) { console.error("[cordis] prepareReplayContext failed:", err instanceof Error ? err.message : err); }
}

export function getCachedChatAgent(threadId: string): unknown { return peekChatAgentCache()?.get(threadId); }

export async function resumeChatAgent(threadId: string, workspacePath: string, model: string): Promise<unknown> {
  const cached = getCachedChatAgent(threadId);
  if (cached) { try { await (cached as { whenIdle: () => Promise<void> }).whenIdle(); } catch { /* fall through */ } return cached; }
  const ctx = await getContext();
  try {
    const opened = await openCordisSessionAgent(ctx, { sessionId: String(SessionId(`chat-${threadId}`)), cwd: workspacePath, llmConfig: { provider: "openai", baseUrl: "", model, apiKey: "" }, createIfMissing: false });
    getChatAgentCache().set(threadId, { handle: opened as unknown as Record<PropertyKey, unknown>, agent: opened.agent as Record<PropertyKey, unknown>, selectionRef: opened.selectionRef });
    return opened.agent;
  } catch { return undefined; }
}

export async function readContextRing(sessionId: string): Promise<{ available: boolean; ring?: { currentModel: string | null; byModel: Record<string, { turns: number; reasoningBlocks: number; reasoningChars: number; replayedBlocks: number; degradedBlocks: number }> } }> {
  try {
    const { cachedContextRing } = await import("./plugins/context-ring");
    const cached = cachedContextRing(sessionId);
    if (cached) return { available: true, ring: { currentModel: cached.currentModel, byModel: cached.byModel } };
    const ctx = await getContext();
    const registry = ctx.sessionProjections;
    const session = ctx.sessions?.get?.(sessionId as never);
    if (!registry || !session) return { available: false };
    const state = registry.stateOf(session, "contextRing" as never) as { currentModel: string | null; byModel: Record<string, { turns: number; reasoningBlocks: number; reasoningChars: number; replayedBlocks: number; degradedBlocks: number }> } | undefined;
    return state ? { available: true, ring: state } : { available: false };
  } catch { return { available: false }; }
}

import { runChatCordisSession } from "./chat-session-runner";
export async function runCordisLoop(opts: RunCordisLoopOptions): Promise<RunCordisLoopResult> { return runChatCordisSession(opts); }
