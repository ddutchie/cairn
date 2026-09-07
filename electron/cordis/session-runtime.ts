import type { Context } from "@deepseek-ai/cordis";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import { APP_IDENTITY } from "@deepseek-ai/dsh-llm";
import { CAIRN_APP_IDENTITY, createHostStore, ensureLocalLlmPort } from "./host-store";
import type { LLMConfig } from "../lib/llm";
import { type ApiMode } from "../lib/llm-transport";
import type { Database } from "better-sqlite3";
import type { ChatRequest } from "../lib/tools";
import type { UsageSource } from "../db/usage-queries";
import { cairnDbPlugin, cairnSessionPlugin, cairnUsagePlugin, cairnSubagentPlugin, cairnQuestionsPlugin } from "./cairn-plugins";

// White-label the DSH harness attribution: every provider request via
// dsh-llm-pi-ai merges `attributionHeaders()` (→ `User-Agent`) last.
// Mutating the shared APP_IDENTITY object makes the harness send
// `cairn/<version> (+https://github.com/ddutchie/cairn)` instead of
// `deepseek-harness/<dsh-version>`. Works even after pi-ai is imported
// because both imports share the same module instance (Node cache /
// esbuild dedupe). See node_modules/@deepseek-ai/dsh-llm/lib/index.js:766
// and node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1601.
APP_IDENTITY.product = CAIRN_APP_IDENTITY.product;
APP_IDENTITY.version = CAIRN_APP_IDENTITY.version;
APP_IDENTITY.url = CAIRN_APP_IDENTITY.url;

let piAiDisposer: (() => Promise<void>) | null = null;
let lastPiAiConfig: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses" | "anthropic-messages"; contextWindow?: number; maxTokens?: number; reasoning?: boolean } | null = null;

export interface CordisDisposerStack {
  mount: (ctx: Context, plugin: unknown, config?: unknown) => Promise<void>;
  add: (dispose: () => unknown) => void;
  dispose: () => void;
  /**
   * Awaited teardown. Cordis fiber disposal is ASYNC (unload runs over
   * microtasks); the fire-and-forget `dispose()` leaves the previous turn's
   * tool/prompt-section registrations alive long enough for the next turn's
   * mounts to throw "already registered" (dsh 0.1.2-alpha.4+ enforces unique
   * names via NamedEntries). Always prefer this at turn end.
   */
  disposeAsync: () => Promise<void>;
}

/** Mount per-turn plugins and unwind their fibers in one place. */
export function createCordisDisposerStack(): CordisDisposerStack {
  const disposers: Array<() => unknown> = [];
  const runOne = async (dispose: () => unknown): Promise<void> => {
    try { await dispose(); } catch { /* noop */ }
  };
  return {
    add(dispose) { disposers.push(dispose); },
    async mount(ctx, plugin, config) {
      const fiber = ctx.plugin(plugin as never, config as never);
      disposers.push(() => fiber.then(
        (mounted) => mounted.dispose() as unknown,
        () => {},
      ));
      await fiber;
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try { void runOne(dispose); } catch { /* noop */ }
      }
    },
    async disposeAsync() {
      const pending = disposers.splice(0).reverse();
      for (const dispose of pending) {
        await runOne(dispose);
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
  /** Usage-view attribution for this session's rows. */
  usageSource: UsageSource;
}

/** Mount the Cairn-owned session services shared by Chat and Coding turns. */
export async function mountCordisSessionPlugins({
  mount, db, req, sessionId, llmConfig, signal, includeSessionIndex = false, sendSubagent, questions, usageSource,
}: MountCordisSessionPluginsOptions): Promise<void> {
  await mount(cairnDbPlugin, { db, host: createHostStore(db) });
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
    source: usageSource,
  });
  if (sendSubagent) await mount(cairnSubagentPlugin, { send: sendSubagent, sessionId });
  if (questions) {
    await mount(cairnQuestionsPlugin, {
      sessionId,
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
    const port = await ensureLocalLlmPort();
    llmConfig = { ...llmConfig, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }
  // Explicit wire protocol — Cairn never auto-probes for the Cordis path. The
  // provider pins apiMode (default "completions"); mapping it directly keeps the
  // api STABLE across restarts so the resumed session log's replay state (tagged
  // with the api it was written under) is never replayed into a different api.
  const piApi = llmConfig.apiMode === "responses" ? "openai-responses"
    : llmConfig.apiMode === "anthropic-messages" ? "anthropic-messages"
    : "openai-completions";
  const t1 = timing ? Date.now() : 0;
  await ensureAgentAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: piApi,
    contextWindow: llmConfig.contextWindow,
    maxTokens: llmConfig.maxTokens,
    reasoning: llmConfig.isReasoningModel === true,
  });
  if (timing) console.log(`[timing] prepareCordisRuntime: ensureAgentAiAdapter ${Date.now() - t1}ms`);
  // `transport` is the OpenAI-wire mode used by the chat runner's legacy
  // responses→completions fallback; anthropic-messages has no OpenAI fallback so
  // it reports "completions" there (the fallback simply won't trigger for it).
  const transport: ApiMode = llmConfig.apiMode === "responses" ? "responses" : "completions";
  return { llmConfig, transport };
}

/** Mount or update the Cairn provider route for the current model endpoint. */
export async function ensureAgentAiAdapter(ctx: Context, config: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses" | "anthropic-messages"; contextWindow?: number; maxTokens?: number; reasoning?: boolean }): Promise<void> {
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
