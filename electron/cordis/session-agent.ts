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
  // Eagerly mount the pi-ai route for the summariser (compaction) before the
  // agent is created/resumed, so a `/compact` invocation that later calls
  // `ctx.compaction.compactNow(invocation.agent)` as-is already has the
  // correct apiMode-pinned adapter. Upstream dsh-command-compact does not
  // re-resolve apiMode per turn; Cairn pins it from the saved provider so
  // replay is stable.
  try {
    const { ensureAgentAiAdapter } = await import("./session-runtime");
    const api = llmConfig.apiMode === "responses"
      ? "openai-responses" as const
      : llmConfig.apiMode === "anthropic-messages"
        ? "anthropic-messages" as const
        : "openai-completions" as const;
    await ensureAgentAiAdapter(ctx, {
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model,
      apiKey: llmConfig.apiKey,
      api,
      contextWindow: llmConfig.contextWindow,
      maxTokens: llmConfig.maxTokens,
      reasoning: llmConfig.isReasoningModel === true,
    });
  } catch (err) {
    console.warn("[cordis] openCordisSessionAgent ensureAgentAiAdapter failed:", err instanceof Error ? err.message : err);
  }
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // zstd-only backend throws encodingMismatch when a legacy plaintext .jsonl exists.
    // Treat that as "exists but wrong encoding" — migrate by removing the conflicting
    // artifact so a fresh zstd log can be created (legacy transcript is best-effort
    // preserved via the archive migration v49 path; losing it is preferable to a
    // hard encodingMismatch that blocks all future turns on this session).
    if (msg.includes("but this backend is configured for compression") || msg.includes("encodingMismatch")) {
      console.warn(`[cordis] session "${sessionId}" encoding mismatch — cleaning conflicting artifact:`, msg);
      try {
        const { getSessionRoot } = await import("./cordis-context");
        const { default: fs } = await import("node:fs");
        const { default: path } = await import("node:path");
        // Scan both encodings under all roots (primary + fallback) and remove the
        // plaintext variant so the zstd backend can proceed.
        const { SessionId: SID } = await import("@deepseek-ai/dsh-session");
        void SID;
        const roots = [getSessionRoot(), path.join(process.cwd(), ".cairn-sessions")].filter((r, i, a) => r && a.indexOf(r) === i);
        for (const root of roots) {
          try {
            const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d: { name: string }) => d.name);
            for (const proj of dirs) {
              const base = path.join(root, proj, String(stableId));
              for (const p of [path.join(base, "session.jsonl"), base + ".jsonl"]) {
                try { if (fs.existsSync(p)) { const st = fs.statSync(p); if (st.isFile()) fs.unlinkSync(p); else fs.rmSync(p, { recursive: true, force: true }); } } catch { /* ignore */ }
              }
            }
          } catch { /* ignore */ }
        }
      } catch { /* best-effort migration */ }
    }
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
