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
  /**
   * The mutable model-selection ref installed via installModelSelection. dsh
   * snapshots `selection.current` during each step's prompt assembly, so a
   * long-lived (retained) chat agent can change provider/model/reasoningEffort
   * between turns by mutating `selectionRef.current` — no resume needed.
   */
  selectionRef?: ModelSelectionRef;
}

/** Mutable provider/model/effort selection dsh reads per step (see installModelSelection). */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: "off" | "low" | "medium" | "high";
}
export interface ModelSelectionRef {
  current: ModelSelection | undefined;
  assembled: ModelSelection | undefined;
}

/** Open a stable DSH session by resuming its log or creating it when absent. */
export async function openCordisSessionAgent(
  ctx: Context,
  { sessionId, cwd, llmConfig, signal, createIfMissing = true }: OpenCordisSessionAgentOptions,
): Promise<CordisSessionAgentHandle> {
  const stableId = SessionId(sessionId);
  const selection: ModelSelection = {
    provider: "cairn",
    model: llmConfig.model,
    // Pass reasoning effort into the harness's model selection so it lands on the
    // request header (installModelSelection → agent/request). Only reasoning-capable
    // models are given an effort by the caller; absent = the model's own default.
    ...(llmConfig.reasoningEffort ? { reasoningEffort: llmConfig.reasoningEffort } : {}),
  };
  // The mutable ref dsh reads on every step. Retained-agent callers keep this and
  // mutate `.current` to change model/effort between turns without a resume.
  const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined };
  const base = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: unknown) => {
      installModelSelection(agentCtx as never, selectionRef as never);
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
    const handle = await ctx.agents.resume({
      ...base,
      resumeSessionId: stableId,
      signal,
    }) as CordisSessionAgentHandle;
    return { ...handle, selectionRef };
  }

  if (!createIfMissing) throw new Error(`session "${sessionId}" not found`);

  try {
    const handle = await ctx.agentLoop.createAgent(ctx, {
      ...base,
      sessionId: stableId,
      meta: { cwd },
      signal,
    } as never) as CordisSessionAgentHandle;
    return { ...handle, selectionRef };
  } catch (error) {
    // Another opener may materialize the same stable session between inspect
    // and create. Treat that race like the already-existing resume case.
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const handle = await ctx.agents.resume({
      ...base,
      resumeSessionId: stableId,
      signal,
    }) as CordisSessionAgentHandle;
    return { ...handle, selectionRef };
  }
}
