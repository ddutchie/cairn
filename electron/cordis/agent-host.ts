import type { Context } from "@deepseek-ai/cordis";
import { getContext, getSessionRoot } from "./cordis-context";
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
import { buildSystemPrompt, getCachedConfig } from "./host-store";
import type { OneShotOptions } from "./one-shot";
import type { ContextRingResult } from "./run-cordis-loop";
import type { SubagentCatalogView, SubagentScope } from "./subagent-control";

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

export interface ExecuteCommandInput extends AgentSessionModel {
  sessionId: string;
  cwd: string;
  line: string;
}

export interface CommandExecutionResult {
  kind?: string;
  text?: string;
  mode?: "plan" | "execute";
}

export interface SystemPromptPreview {
  text: string;
  sections: Array<{ name: string; order: number; text: string; index: number }>;
  contexts: Array<{ name: string; order: number; text: string }>;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description?: string }>;
  variables: Record<string, string | undefined>;
  cairnSystemLive?: boolean;
  error?: string;
}

export interface AgentHost {
  readGoalSnapshot(sessionId: string): Promise<GoalWire | null>;
  putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedbackItemWire>;
  getMessageFeedback(sessionId: string, messageId: string): Promise<MessageFeedbackItemWire | null>;
  listSchedules(sessionId: string): Promise<ScheduleWire[]>;
  readPermissionsSnapshot(sessionId: string): Promise<PermissionsSelect>;
  loadSessionMessages(sessionId: string): Promise<LoadSessionMessagesResult>;
  readContextRing(sessionId: string): Promise<ContextRingResult>;
  listSubagentChildren(parentSessionId: string, scope?: SubagentScope | AbortSignal, signal?: AbortSignal): Promise<SubagentCatalogView>;
  interruptSubagentChild(parentSessionId: string, childId: string): Promise<{ accepted: true }>;
  messageSubagentChild(parentSessionId: string, childId: string, text: string, signal?: AbortSignal): Promise<{ messageId: string }>;
  listCommands(): Promise<Array<{ name: string; description?: string }>>;
  compactChatSession(threadId: string, model: Partial<AgentSessionModel>): Promise<{ ok: boolean; compacted: boolean; error?: string; summaryText?: string }>;
  executeCommand(input: ExecuteCommandInput): Promise<CommandExecutionResult>;
  previewSystemPrompt(cwd: string): Promise<SystemPromptPreview>;
  getGlobalTools(): Promise<Array<{ name: string; description?: string }>>;
  compactSession(input: CompactSessionInput): Promise<CompactSessionResult | null>;
  setSessionMode(input: SetSessionModeInput): Promise<"plan" | "execute">;
  readSessionTitle(sessionId: string): Promise<string | null>;
  renameSessionTitle(sessionId: string, title: string): Promise<string>;
  releaseSessionAgent(sessionId: string): Promise<void>;
  listSessionChildIds(parentSessionId: string): Promise<string[]>;
  clearChatSessionAgents(threadId: string, subagentIds?: string[]): Promise<void>;
  runOneShot(options: OneShotOptions): Promise<string>;
}

interface CommandRuntimeLike {
  execute: (agent: unknown, line: string, images: unknown[], signal?: AbortSignal) => Promise<unknown>;
  list?: () => Array<{ name: string; description?: string }>;
}

interface CompactionLike {
  compactNow: (agent: unknown, signal: AbortSignal) => Promise<{ replacedCount?: number; replacedSeqs?: unknown[]; summary?: string } | null>;
}

interface AgentCollection {
  get?: (id: unknown) => unknown;
  delete?: (id: unknown) => unknown;
  remove?: (id: unknown) => unknown;
  dispose?: (id: unknown) => unknown;
  destroy?: (id: unknown) => unknown;
  list?: () => unknown;
  entries?: () => Iterable<[unknown, unknown]>;
  [key: string]: unknown;
}

function agentCollection(ctx: Context): AgentCollection | undefined {
  return (ctx as unknown as { agents?: AgentCollection }).agents;
}

function tryReleaseAgent(agents: AgentCollection | undefined, id: unknown): boolean {
  if (!agents || typeof agents !== "object") return false;
  for (const method of ["delete", "remove", "dispose", "destroy"] as const) {
    try {
      const fn = agents[method];
      if (typeof fn === "function") { fn.call(agents, id); return true; }
    } catch { }
  }
  try {
    const agent = agents.get?.(id) as { dispose?: () => void } | undefined;
    agent?.dispose?.();
    return true;
  } catch { }
  return false;
}

function collectAgentIds(agents: AgentCollection): string[] {
  const ids: string[] = [];
  if (agents instanceof Map) {
    for (const key of (agents as Map<unknown, unknown>).keys()) ids.push(String(key));
    return ids;
  }
  if (Array.isArray(agents.keys)) return ids;
  ids.push(...Object.keys(agents));
  const listed = agents.list?.();
  if (Array.isArray(listed)) ids.push(...listed.map(String));
  const entries = agents.entries?.();
  if (entries) for (const [key] of entries) ids.push(String(key));
  return ids;
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
    async readContextRing(sessionId) {
      const { readContextRingWithContext } = await import("./run-cordis-loop");
      return readContextRingWithContext(await context(), sessionId);
    },
    async listSubagentChildren(parentSessionId, scope = "children", signal) {
      const { listSubagentChildrenWithContext } = await import("./subagent-control");
      return listSubagentChildrenWithContext(await context(), parentSessionId, scope, signal);
    },
    async interruptSubagentChild(parentSessionId, childId) {
      const { interruptSubagentChildWithContext } = await import("./subagent-control");
      return interruptSubagentChildWithContext(await context(), parentSessionId, childId);
    },
    async messageSubagentChild(parentSessionId, childId, text, signal) {
      const { messageSubagentChildWithContext } = await import("./subagent-control");
      return messageSubagentChildWithContext(await context(), parentSessionId, childId, text, signal);
    },
    async listCommands() {
      const ctx = await context();
      const commands = (ctx as unknown as { commands?: CommandRuntimeLike }).commands;
      return commands?.list?.() ?? [];
    },
    async compactChatSession(threadId, model) {
      const { compactChatSession } = await import("./cairn-commands");
      return compactChatSession(context, threadId, model);
    },
    async executeCommand({ sessionId, cwd, baseUrl, model, apiKey, line }) {
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
        const output = await commands.execute(handle.agent, line, [], new AbortController().signal) as { result?: { kind?: string; text?: string } } | undefined;
        const result = output?.result ?? output as { kind?: string; text?: string } | undefined;
        const commandName = line.trim().replace(/^\//, "").split(/\s+/, 1)[0];
        let mode: "plan" | "execute" | undefined;
        if (commandName === "plan" && result?.kind === "success") {
          mode = getPlanModeActive(ctx, (handle.agent as { session?: unknown }).session) ? "plan" : "execute";
        }
        return { kind: result?.kind, text: result?.text, mode };
      } finally {
        try { await handle.dispose?.(); } catch { }
      }
    },
    async previewSystemPrompt(cwd) {
      const ctx = await context();
      const sys = (ctx as unknown as {
        systemPrompt?: {
          assemble: (c: { scope?: unknown; signal?: AbortSignal }) => Promise<unknown>;
          section: (s: { name: string; order: number; text: string }) => () => void;
        };
      }).systemPrompt;
      if (!sys) return { text: "", sections: [], contexts: [], skills: [], tools: [], variables: {}, error: "systemPrompt service unavailable" };
      let disposeSection: (() => void) | undefined;
      let cairnSystemLive = false;
      try {
        disposeSection = sys.section({ name: "cairn:system", order: -100, text: buildSystemPrompt({ message: "", threadId: "preview", projectId: "", workspaceId: "" } as never) });
      } catch {
        cairnSystemLive = true;
      }
      try {
        const assembly = (await sys.assemble({ signal: undefined })) as {
          sections: Array<{ name: string; order: number; text: string | ((c: { scope?: unknown }) => string) }>;
          contexts: Array<{ name: string; order: number; text: string | ((c: { scope?: unknown }) => string) }>;
          variables: Record<string, string | undefined>;
        };
        const { renderPrompt } = await import("@deepseek-ai/dsh-system-prompt");
        const textOf = (value: string | ((c: { scope?: unknown }) => string)) => typeof value === "function" ? value({}) : value;
        const text = renderPrompt(assembly as unknown as Parameters<typeof renderPrompt>[0]);
        const sections = assembly.sections.map((section, index) => ({ name: section.name, order: index, text: textOf(section.text), index }));
        const contexts = assembly.contexts.map((contextEntry) => ({ name: contextEntry.name, order: contextEntry.order, text: textOf(contextEntry.text) }));
        let skills: Array<{ name: string; description: string }> = [];
        try {
          const service = (ctx as unknown as { skills?: { list: (options: { cwd: string }) => Promise<Array<{ name: string; description: string }>> } }).skills;
          if (service) skills = await service.list({ cwd });
        } catch { }
        const tools: Array<{ name: string; description?: string }> = [];
        try {
          const service = (ctx as unknown as { tools?: { view: (value?: unknown) => { visible: Map<string, unknown> } } }).tools;
          for (const [name, definition] of service?.view?.()?.visible ?? []) {
            tools.push({ name, description: (definition as { description?: string } | undefined)?.description });
          }
          tools.sort((a, b) => a.name.localeCompare(b.name));
        } catch { }
        return { text, sections, contexts, skills, tools, variables: assembly.variables ?? {}, cairnSystemLive };
      } finally {
        try { disposeSection?.(); } catch { }
      }
    },
    async getGlobalTools() {
      const ctx = await context();
      const tools: Array<{ name: string; description?: string }> = [];
      try {
        const service = (ctx as unknown as { tools?: { view: (value?: unknown) => { visible: Map<string, unknown> } } }).tools;
        for (const [name, definition] of service?.view?.()?.visible ?? []) {
          tools.push({ name, description: (definition as { description?: string } | undefined)?.description });
        }
        tools.sort((a, b) => a.name.localeCompare(b.name));
      } catch { }
      return tools;
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
        return { messageCount: result.replacedCount ?? result.replacedSeqs?.length ?? 0, summary: result.summary ?? "" };
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
        if (commandResult?.kind !== "success") throw new Error(commandResult?.text ?? "plan mode command was not accepted");
        const committedMode = getPlanModeActive(ctx, (handle.agent as { session?: unknown }).session) ? "plan" : "execute";
        if (committedMode !== mode) throw new Error(`plan mode command did not commit ${mode}`);
        return committedMode;
      } finally {
        try { await handle.dispose?.(); } catch { }
      }
    },
    async readSessionTitle(sessionId) {
      const ctx = await context();
      const session = (ctx as unknown as { sessions?: { get: (id: unknown) => unknown } }).sessions?.get?.(sessionId as never) as { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] } | undefined;
      const liveEvents = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events;
      if (liveEvents && liveEvents.length > 0) {
        const { foldSessionTitle } = await import("./plugins/session-title");
        const snapshot = foldSessionTitle(liveEvents as never);
        if (snapshot) return snapshot.title as string;
      }
      const registry = (ctx as unknown as { sessionProjections?: { stateOf: (value: unknown, key: string) => unknown } }).sessionProjections;
      if (session && registry) {
        const value = registry.stateOf(session as never, "title" as never) as string | null | undefined;
        if (value) return value;
      }
      const persistence = (ctx as unknown as { sessionPersistence?: { inspect: (id: unknown) => Promise<{ events: readonly unknown[] }> } }).sessionPersistence;
      if (persistence) {
        try {
          const inspection = await persistence.inspect(sessionId);
          const { foldSessionTitle } = await import("./plugins/session-title");
          const snapshot = foldSessionTitle(inspection.events as never);
          if (snapshot) return snapshot.title as string;
        } catch { }
      }
      return null;
    },
    async renameSessionTitle(sessionId, title) {
      const ctx = await context();
      const sessions = (ctx as unknown as { sessions?: { get: (id: unknown) => unknown } }).sessions;
      let live = sessions?.get?.(sessionId as never) as { id: unknown } | undefined;
      if (!live) {
        const { openCordisAgent } = await import("./run-cordis-coding");
        const cwd = getSessionRoot().replace(/[/\\]sessions[/\\]?$/, "") || process.cwd();
        const config = getCachedConfig().agentConfig ?? {};
        try {
          const handle = await openCordisAgent(ctx, { sessionId, cwd, llmConfig: { baseUrl: config.baseUrl ?? "", model: config.model ?? "gpt-5.6-luna", apiKey: config.apiKey ?? "", provider: "openai" } });
          live = (handle.agent as { session?: unknown }).session as { id: unknown } | undefined ?? sessions?.get?.(sessionId as never) as { id: unknown } | undefined;
          try { await handle.dispose?.(); } catch { }
        } catch { }
      }
      if (!live) throw new Error(`session "${sessionId}" is not live`);
      const service = (ctx as unknown as { sessionTitle?: { rename: (value: unknown, nextTitle: string) => { title: string } } }).sessionTitle;
      if (!service?.rename) throw new Error("sessionTitle service not mounted");
      return service.rename(live as never, title).title;
    },
    async releaseSessionAgent(sessionId) {
      try {
        const agents = agentCollection(await context());
        tryReleaseAgent(agents, { toString: () => sessionId } as unknown as string);
      } catch { }
    },
    async listSessionChildIds(parentSessionId) {
      try {
        const persistence = (await context() as unknown as { sessionPersistence?: { list?: () => Promise<Array<{ id: unknown; origin?: string; parentSession?: unknown; meta?: { origin?: string; parentSession?: unknown } }>> } }).sessionPersistence;
        const list = persistence?.list ? await persistence.list() : [];
        return list.filter((entry) => {
          const origin = entry.origin ?? entry.meta?.origin;
          const parent = entry.parentSession ?? entry.meta?.parentSession;
          return origin === "subagent" && String(parent) === String(parentSessionId);
        }).map((entry) => String(entry.id));
      } catch { }
      return [];
    },
    async clearChatSessionAgents(threadId, subagentIds = []) {
      try {
        const agents = agentCollection(await context());
        if (!agents || typeof agents !== "object") return;
        const stableId = `chat-${threadId}`;
        const prefix = `chat-${threadId}-`;
        for (const id of [stableId, { toString: () => stableId }, threadId, { toString: () => threadId }, ...subagentIds.flatMap((id) => [id, { toString: () => id }])]) {
          tryReleaseAgent(agents, id);
        }
        for (const id of collectAgentIds(agents)) {
          if (id === threadId || id === stableId || id.startsWith(prefix) || id.startsWith(threadId) || id.startsWith(stableId) || subagentIds.includes(id)) tryReleaseAgent(agents, id);
        }
      } catch { }
    },
    async runOneShot(options) {
      const { runOneShotWithContext } = await import("./one-shot");
      return runOneShotWithContext(await context(), options);
    },
  };
}

const localAgentHost = createLocalAgentHost();

export function getAgentHost(): AgentHost {
  return localAgentHost;
}
