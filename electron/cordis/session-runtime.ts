import type { Context } from "@deepseek-ai/cordis";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import type { LLMConfig } from "../lib/llm";
import { resolveTransport, type ApiMode } from "../lib/llm-transport";
import type { Database } from "better-sqlite3";
import type { ChatRequest } from "../lib/tools";
import { cairnDbPlugin, cairnSessionPlugin, cairnUsagePlugin, cairnSubagentPlugin, cairnQuestionsPlugin } from "./cairn-plugins";

let piAiDisposer: (() => Promise<void>) | null = null;
let lastPiAiConfig: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses"; contextWindow?: number; maxTokens?: number; reasoning?: boolean } | null = null;

export interface CordisDisposerStack {
  mount: (ctx: Context, plugin: unknown, config?: unknown) => Promise<void>;
  add: (dispose: () => void) => void;
  dispose: () => void;
}

/** Mount per-turn plugins and unwind their fibers in one place. */
export function createCordisDisposerStack(): CordisDisposerStack {
  const disposers: Array<() => void> = [];
  return {
    add(dispose) { disposers.push(dispose); },
    async mount(ctx, plugin, config) {
      const fiber = ctx.plugin(plugin as never, config as never);
      disposers.push(() => {
        fiber.then((mounted) => { try { mounted.dispose(); } catch { /* noop */ } }, () => {});
      });
      await fiber;
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose(); } catch { /* noop */ }
      }
    },
  };
}

export interface CordisQuestionAdapter {
  send: (channel: string, payload: Record<string, unknown>) => void;
  registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  emitQuestions?: (requestId: string, questions: unknown[]) => void;
}

export interface MountCordisSessionPluginsOptions {
  mount: (plugin: unknown, config: unknown) => Promise<void>;
  db: Database;
  req: ChatRequest;
  sessionId: string;
  llmConfig: LLMConfig;
  signal?: AbortSignal;
  includeSessionIndex?: boolean;
  sendSubagent?: (channel: string, payload: Record<string, unknown>) => void;
  questions?: CordisQuestionAdapter;
}

/** Mount the Cairn-owned session services shared by Chat and Coding turns. */
export async function mountCordisSessionPlugins({
  mount, db, req, sessionId, llmConfig, signal, includeSessionIndex = false, sendSubagent, questions,
}: MountCordisSessionPluginsOptions): Promise<void> {
  await mount(cairnDbPlugin, { db });
  if (includeSessionIndex) {
    await mount(cairnSessionPlugin, {
      threadId: sessionId,
      workspaceId: req.workspaceId ?? "",
      projectId: req.projectId,
    });
  }
  await mount(cairnUsagePlugin, {
    threadId: sessionId,
    workspaceId: req.workspaceId ?? "",
    projectId: req.projectId,
    provider: llmConfig.provider,
    model: llmConfig.model,
    baseUrl: llmConfig.baseUrl,
  });
  if (sendSubagent) await mount(cairnSubagentPlugin, { send: sendSubagent, sessionId });
  if (questions) {
    await mount(cairnQuestionsPlugin, {
      send: questions.send,
      registerPending: questions.registerPending,
      signal,
      ...(questions.emitQuestions ? { emitQuestions: questions.emitQuestions } : {}),
    });
  }
}

/** Prepare the shared model route used by every Cairn session kind. */
export async function prepareCordisRuntime(ctx: Context, input: LLMConfig): Promise<{ llmConfig: LLMConfig; transport: ApiMode }> {
  const timing = process.env.CAIRN_TIMING === "1" || process.env.CAIRN_TIMING === "true";
  let llmConfig = input;
  if (llmConfig.provider === "localllm") {
    const { ensureLlamaServerRunning } = await import("../lib/llama-server");
    const port = await ensureLlamaServerRunning();
    llmConfig = { ...llmConfig, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }
  const t0 = timing ? Date.now() : 0;
  const transport = await resolveTransport(llmConfig.baseUrl, llmConfig.apiKey);
  if (timing) console.log(`[timing] prepareCordisRuntime: resolveTransport ${Date.now() - t0}ms`);
  const t1 = timing ? Date.now() : 0;
  await ensureAgentAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: transport.mode === "responses" ? "openai-responses" : "openai-completions",
    contextWindow: llmConfig.contextWindow,
    maxTokens: llmConfig.maxTokens,
    reasoning: llmConfig.isReasoningModel === true,
  });
  if (timing) console.log(`[timing] prepareCordisRuntime: ensureAgentAiAdapter ${Date.now() - t1}ms`);
  return { llmConfig, transport: transport.mode };
}

/** Mount or update the Cairn provider route for the current model endpoint. */
export async function ensureAgentAiAdapter(ctx: Context, config: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses"; contextWindow?: number; maxTokens?: number; reasoning?: boolean }): Promise<void> {
  const same = piAiDisposer && lastPiAiConfig
    && lastPiAiConfig.baseUrl === config.baseUrl
    && lastPiAiConfig.model === config.model
    && lastPiAiConfig.api === config.api
    && lastPiAiConfig.contextWindow === config.contextWindow
    && lastPiAiConfig.maxTokens === config.maxTokens
    && lastPiAiConfig.reasoning === config.reasoning;
  if (same) return;
  if (piAiDisposer) {
    try { await piAiDisposer(); } catch { /* noop */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  piAiDisposer = null;
  process.env.CAIRN_LLM_API_KEY = config.apiKey || "local";
  const handle = ctx.plugin(
    { name: llmPiAiName, inject: llmPiAiInject, apply: llmPiAiApply },
    { providers: { cairn: {
      api: config.api,
      baseURL: config.baseUrl,
      displayName: "Cairn",
      models: [{
        id: config.model,
        contextWindow: config.contextWindow ?? 128000,
        maxTokens: config.maxTokens ?? 32768,
        // Declare the offered reasoning levels for reasoning-capable models so
        // the harness (resolveReasoningLevel → getSupportedThinkingLevels) accepts
        // an explicit effort. Without this, a hand-declared model is treated as
        // non-reasoning (supports only "off") and any effort throws
        // UNSUPPORTED_REASONING_EFFORT. The dict maps each offered level to its
        // wire spelling; "off": null = "supported, send nothing".
        ...(config.reasoning
          ? { reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" } as const }
          : {}),
      }],
      apiKeyEnv: "CAIRN_LLM_API_KEY",
      defaultInput: ["text", "image"],
      retryPolicy: { mode: "normal", maxRetries: 5, backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } },
    } } },
  );
  await handle;
  piAiDisposer = async () => { try { const resolved = await handle; resolved.dispose(); } catch { /* noop */ } };
  lastPiAiConfig = config;
}
