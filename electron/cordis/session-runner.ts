import type { Context } from "@deepseek-ai/cordis";
import type { Database } from "better-sqlite3";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import { createCordisDisposerStack, mountCordisSessionPlugins, prepareCordisRuntime, type CordisDisposerStack, type CordisQuestionAdapter } from "./session-runtime";
import type { CordisSessionAgentHandle } from "./session-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { upsertSessionProfile } from "../db/queries";
import type { SessionProfileId } from "../../shared/agent/session-profile";

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
  upsertSessionProfile(profile.db, {
    sessionId: profile.sessionId,
    profile: profile.profileId,
    cwd: profile.cwd,
    workspaceId: profile.workspaceId,
    projectId: profile.projectId,
  });
  const prepared = await prepareCordisRuntime(profile.ctx, profile.llmConfig);
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
    });
    await profile.setup({ llmConfig: prepared.llmConfig, resources, mount });
    handle = await profile.open({ llmConfig: prepared.llmConfig });
    return await profile.run({ agent: handle.agent, llmConfig: prepared.llmConfig, resources, mount });
  } finally {
    if (!profile.retainAgent) {
      try { await handle?.dispose?.(); } catch { /* best-effort agent teardown */ }
    }
    resources.dispose();
  }
}
