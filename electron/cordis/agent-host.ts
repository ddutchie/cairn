import type { Context } from "@deepseek-ai/cordis";
import { getContext } from "./cordis-context";
import { readGoalSnapshot, type GoalWire } from "./goal-bridge";
import {
  getMessageFeedback,
  putMessageFeedback,
  type MessageFeedbackItemWire,
  type PutMessageFeedbackInput,
} from "./message-feedback";
import { listSchedules, type ScheduleWire } from "./schedule-read";
import { readPermissionsSnapshot, type PermissionsSelect } from "./permissions-bridge";
import {
  loadSessionMessages as loadReplaySessionMessages,
  type LoadSessionMessagesResult,
} from "./session-replay";
import type { SessionStatsSnapshot } from "./session-stats";

type SessionApiMode = "responses" | "completions" | "anthropic-messages";

export interface AgentSessionModel {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiMode?: SessionApiMode;
}

export interface CompactSessionInput extends AgentSessionModel {
  sessionId: string;
  cwd: string;
}

export interface CompactSessionResult {
  messageCount: number;
  summary: string;
}

export interface SetSessionModeInput extends AgentSessionModel {
  sessionId: string;
  cwd: string;
  mode: "plan" | "execute";
}

export interface AgentHost {
  readGoalSnapshot(sessionId: string): Promise<GoalWire | null>;
  putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedbackItemWire>;
  getMessageFeedback(sessionId: string, messageId: string): Promise<MessageFeedbackItemWire | null>;
  listSchedules(sessionId: string): Promise<ScheduleWire[]>;
  readPermissionsSnapshot(sessionId: string): Promise<PermissionsSelect>;
  loadSessionMessages(sessionId: string): Promise<LoadSessionMessagesResult>;
  compactSession(input: CompactSessionInput): Promise<CompactSessionResult | null>;
  setSessionMode(input: SetSessionModeInput): Promise<"plan" | "execute">;
  releaseSessionAgent(sessionId: string): Promise<void>;
}

interface CommandRuntimeLike {
  execute: (agent: unknown, line: string, images: unknown[], signal?: AbortSignal) => Promise<unknown>;
}

interface CompactionLike {
  compactNow: (agent: unknown, signal: AbortSignal) => Promise<{ replacedCount?: number; replacedSeqs?: unknown[]; summary?: string } | null>;
}

function createLocalAgentHost(): AgentHost {
  const context = (): Promise<Context> => getContext();

  return {
    async readGoalSnapshot(sessionId) {
      return readGoalSnapshot(await context(), sessionId);
    },
    async putMessageFeedback(input) {
      return putMessageFeedback(await context(), input);
    },
    async getMessageFeedback(sessionId, messageId) {
      return getMessageFeedback(await context(), sessionId, messageId);
    },
    async listSchedules(sessionId) {
      return listSchedules(await context(), sessionId);
    },
    async readPermissionsSnapshot(sessionId) {
      return readPermissionsSnapshot(await context(), sessionId);
    },
    async loadSessionMessages(sessionId) {
      const ctx = await context();
      const persistence = (ctx as unknown as { sessionPersistence?: Parameters<typeof loadReplaySessionMessages>[0] }).sessionPersistence;
      if (!persistence) return { messages: [], subagents: [] };
      const { prepareReplayContext } = await import("./run-cordis-loop");
      await prepareReplayContext(persistence as { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> }, sessionId);
      const liveSessions = (ctx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((ctx as unknown as { sessions: unknown }).sessions);
      let statsSnapshot: SessionStatsSnapshot | undefined;
      try {
        const { readSessionStatsSnapshot } = await import("./session-stats");
        const live = (ctx as unknown as { sessions?: { get: (id: unknown) => unknown } }).sessions?.get?.(sessionId as never);
        statsSnapshot = readSessionStatsSnapshot(
          (ctx as unknown as { sessionProjections?: import("./session-stats").SessionStatsRegistryLike }).sessionProjections,
          live,
        );
      } catch { }
      return loadReplaySessionMessages(persistence, liveSessions, sessionId, statsSnapshot ? { statsSnapshot } : undefined);
    },
    async compactSession({ sessionId, cwd, baseUrl, model, apiKey, apiMode }) {
      const [{ openCordisAgent }, { ensureAgentAiAdapter }] = await Promise.all([
        import("./run-cordis-coding"),
        import("./session-runtime"),
      ]);
      const ctx = await context();
      const compactApi = apiMode === "responses" ? "openai-responses"
        : apiMode === "anthropic-messages" ? "anthropic-messages"
        : "openai-completions";
      await ensureAgentAiAdapter(ctx, { baseUrl, model, apiKey, api: compactApi });
      const handle = await openCordisAgent(ctx, {
        sessionId,
        cwd,
        llmConfig: { baseUrl, model, apiKey, provider: "openai", apiMode },
        signal: new AbortController().signal,
      });
      try {
        const maybeIdle = (handle.agent as { whenIdle?: () => Promise<void> })?.whenIdle;
        if (typeof maybeIdle === "function") {
          try { await maybeIdle.call(handle.agent); } catch { }
        }
        const compaction = (ctx as unknown as { compaction?: CompactionLike }).compaction;
        if (!compaction?.compactNow) throw new Error("compaction service not mounted");
        const result = await compaction.compactNow(handle.agent, new AbortController().signal);
        if (!result) return null;
        return {
          messageCount: result.replacedCount ?? result.replacedSeqs?.length ?? 0,
          summary: result.summary ?? "",
        };
      } finally {
        await handle.dispose?.();
      }
    },
    async setSessionMode({ sessionId, cwd, baseUrl, model, apiKey, mode }) {
      const [{ openCordisAgent }, { getPlanModeActive }] = await Promise.all([
        import("./run-cordis-coding"),
        import("./plan-fold"),
      ]);
      const ctx = await context();
      const handle = await openCordisAgent(ctx, {
        sessionId,
        cwd,
        llmConfig: { baseUrl, model, apiKey, provider: "openai" },
      });
      try {
        const commands = (ctx as unknown as { commands?: CommandRuntimeLike }).commands;
        if (!commands) throw new Error("commands runtime unavailable");
        const result = await commands.execute(handle.agent, mode === "plan" ? "/plan" : "/plan off", [], new AbortController().signal);
        const commandResult = (result as { result?: { kind?: string; text?: string } } | undefined)?.result;
        if (commandResult?.kind !== "success") {
          throw new Error(commandResult?.text ?? "plan mode command was not accepted");
        }
        const session = (handle.agent as { session?: unknown }).session;
        const committedMode = getPlanModeActive(ctx, session) ? "plan" : "execute";
        if (committedMode !== mode) {
          throw new Error(`plan mode command did not commit ${mode}`);
        }
        return committedMode;
      } finally {
        try { await handle.dispose?.(); } catch { }
      }
    },
    async releaseSessionAgent(sessionId) {
      try {
        const ctx = await context();
        const maybeAgents = (ctx as unknown as { agents?: { get?: (id: unknown) => unknown; delete?: (id: unknown) => void; remove?: (id: unknown) => void; dispose?: (id: unknown) => void } })?.agents;
        const sid = { toString: () => sessionId } as unknown as string;
        for (const method of ["delete", "remove", "dispose", "destroy"] as const) {
          try {
            const fn = (maybeAgents as Record<string, unknown> | undefined)?.[method] as ((id: unknown) => unknown) | undefined;
            if (typeof fn === "function") { fn.call(maybeAgents, sid); break; }
          } catch { }
        }
        const agent = maybeAgents?.get?.(sid) as { dispose?: () => void } | undefined;
        agent?.dispose?.();
        } catch { }
    },
  };
}

const localAgentHost = createLocalAgentHost();

export function getAgentHost(): AgentHost {
  return localAgentHost;
}
