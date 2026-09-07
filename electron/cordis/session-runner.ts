import type { Context } from "@deepseek-ai/cordis";
import type { Database } from "better-sqlite3";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import { createCordisDisposerStack, mountCordisSessionPlugins, prepareCordisRuntime, type CordisDisposerStack, type CordisQuestionAdapter } from "./session-runtime";
import type { CordisSessionAgentHandle } from "./session-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createHostStore, dlog } from "./host-store";
import type { SessionProfileId } from "../../shared/agent/session-profile";
import type { UsageSource } from "../db/usage-queries";

export interface CordisSessionProfile<T> {
  ctx: Context;
  db: Database;
  req: ChatRequest;
  sessionId: string;
  profileId: SessionProfileId;
  cwd?: string;
  workspaceId?: string;
  projectId?: string;
  llmConfig: LLMConfig;
  signal?: AbortSignal;
  includeSessionIndex?: boolean;
  sendSubagent?: (channel: string, payload: Record<string, unknown>) => void;
  questions?: CordisQuestionAdapter;
  /** Forward the raw DSH event before any Cairn presentation projection. */
  onSessionEvent?: (event: SessionEvent) => void;
  /**
   * Usage-view attribution. Defaults from `profileId`; automation runs reuse the
   * coding profile but must be booked as "automation", so they pass it through.
   */
  usageSource?: UsageSource;
  /** Mount mode-specific services and register mode-specific tools. */
  setup: (runtime: { llmConfig: LLMConfig; resources: CordisDisposerStack; mount: (plugin: unknown, config?: unknown) => Promise<void> }) => Promise<void>;
  open: (runtime: { llmConfig: LLMConfig }) => Promise<CordisSessionAgentHandle>;
  run: (runtime: { agent: CordisSessionAgentHandle["agent"]; llmConfig: LLMConfig; resources: CordisDisposerStack; mount: (plugin: unknown, config?: unknown) => Promise<void> }) => Promise<T>;
  /** Chat keeps its ReactLoopAgent alive for the next turn; Coding disposes it. */
  retainAgent?: boolean;
}

/**
 * Shared DSH ReactLoopAgent lifecycle. Profiles own capabilities and event
 * policy, while this helper owns the ordering and teardown that must remain the
 * same for every session kind.
 */
export async function runCordisSession<T>(profile: CordisSessionProfile<T>): Promise<T> {
  createHostStore(profile.db).upsertSessionProfile(profile.sessionId, profile.profileId, {
    cwd: profile.cwd,
    workspaceId: profile.workspaceId,
    projectId: profile.projectId,
  });
  // Remounts the pi-ai adapter whenever the model route changes (see
  // ensureAgentAiAdapter) and starts the local llama server for provider
  // "localllm" — both are multi-second costs paid before the turn starts, so
  // they get their own log line rather than hiding inside the caller's total.
  const runtimeStart = Date.now();
  const prepared = await prepareCordisRuntime(profile.ctx, profile.llmConfig);
  const runtimeMs = Date.now() - runtimeStart;
  if (runtimeMs > 250) {
    dlog("cordis-session", "prepareCordisRuntime was slow", {
      sessionId: profile.sessionId, profile: profile.profileId, ms: runtimeMs, provider: profile.llmConfig.provider,
    });
  }
  const resources = createCordisDisposerStack();
  const mount = (plugin: unknown, config?: unknown) => resources.mount(profile.ctx, plugin, config);
  let handle: CordisSessionAgentHandle | undefined;

  try {
    if (profile.onSessionEvent) {
      const disposeEvents = profile.ctx.on("session/event", (session, event) => {
        if (String((session as { id?: unknown }).id) !== profile.sessionId) return;
        profile.onSessionEvent?.(event);
      });
      resources.add(disposeEvents);
    }
    await mountCordisSessionPlugins({
      mount,
      db: profile.db,
      req: profile.req,
      sessionId: profile.sessionId,
      llmConfig: prepared.llmConfig,
      signal: profile.signal,
      includeSessionIndex: profile.includeSessionIndex,
      sendSubagent: profile.sendSubagent,
      questions: profile.questions,
      usageSource: profile.usageSource ?? (profile.profileId === "chat" ? "chat" : "coding-agent"),
    });
    await profile.setup({ llmConfig: prepared.llmConfig, resources, mount });
    handle = await profile.open({ llmConfig: prepared.llmConfig });
    return await profile.run({ agent: handle.agent, llmConfig: prepared.llmConfig, resources, mount });
  } finally {
    if (!profile.retainAgent) {
      try { await handle?.dispose?.(); } catch { /* best-effort agent teardown */ }
    }
    // Awaited: fiber unload is async and the next turn re-registers the same
    // tool/prompt-section names — fire-and-forget disposal races the next
    // mount ("already registered"). See CordisDisposerStack.disposeAsync.
    await resources.disposeAsync();
  }
}
