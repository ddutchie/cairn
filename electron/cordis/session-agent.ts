import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { LLMConfig } from "../lib/llm";

export interface OpenCordisSessionAgentOptions {
  sessionId: string;
  cwd: string;
  llmConfig: LLMConfig;
  signal?: AbortSignal;
  createIfMissing?: boolean;
}

export interface CordisSessionAgentHandle {
  agent: unknown;
  dispose?: () => Promise<void>;
}

/** Open a stable DSH session by resuming its log or creating it when absent. */
export async function openCordisSessionAgent(
  ctx: Context,
  { sessionId, cwd, llmConfig, signal, createIfMissing = true }: OpenCordisSessionAgentOptions,
): Promise<CordisSessionAgentHandle> {
  const stableId = SessionId(sessionId);
  const selection = { provider: "cairn", model: llmConfig.model };
  const base = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: unknown) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
    },
  };

  let exists = false;
  try {
    const inspection = await ctx.sessionPersistence.inspect(stableId, signal);
    exists = inspection.events.length > 0;
  } catch {
    // Missing or not-yet-materialized sessions are created below.
  }

  if (exists) {
    return await ctx.agents.resume({
      ...base,
      resumeSessionId: stableId,
      signal,
    }) as CordisSessionAgentHandle;
  }

  if (!createIfMissing) throw new Error(`session "${sessionId}" not found`);

  try {
    return await ctx.agentLoop.createAgent(ctx, {
      ...base,
      sessionId: stableId,
      meta: { cwd },
      signal,
    } as never) as CordisSessionAgentHandle;
  } catch (error) {
    // Another opener may materialize the same stable session between inspect
    // and create. Treat that race like the already-existing resume case.
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    return await ctx.agents.resume({
      ...base,
      resumeSessionId: stableId,
      signal,
    }) as CordisSessionAgentHandle;
  }
}
