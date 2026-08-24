import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { LLMConfig } from "../lib/llm";

export interface OpenCordisSessionAgentOptions {
  sessionId: string;
  cwd: string;
  llmConfig: LLMConfig;
  signal?: AbortSignal;
}

export interface CordisSessionAgentHandle {
  agent: unknown;
  dispose?: () => Promise<void>;
}

/** Open a stable DSH session by resuming its log or creating it when absent. */
export async function openCordisSessionAgent(
  ctx: Context,
  { sessionId, cwd, llmConfig, signal }: OpenCordisSessionAgentOptions,
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

  return await ctx.agentLoop.createAgent(ctx, {
    ...base,
    sessionId: stableId,
    meta: { cwd },
    signal,
  } as never) as CordisSessionAgentHandle;
}
