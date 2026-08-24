import type { Context } from "@deepseek-ai/cordis";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import type { LLMConfig } from "../lib/llm";
import { ensureLlamaServerRunning } from "../lib/llama-server";
import { resolveTransport, type ApiMode } from "../lib/llm-transport";

let piAiDisposer: (() => Promise<void>) | null = null;
let lastPiAiConfig: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses"; contextWindow?: number; maxTokens?: number } | null = null;

/** Prepare the shared model route used by every Cairn session kind. */
export async function prepareCordisRuntime(ctx: Context, input: LLMConfig): Promise<{ llmConfig: LLMConfig; transport: ApiMode }> {
  let llmConfig = input;
  if (llmConfig.provider === "localllm") {
    const port = await ensureLlamaServerRunning();
    llmConfig = { ...llmConfig, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }
  const transport = await resolveTransport(llmConfig.baseUrl, llmConfig.apiKey);
  await ensureAgentAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: transport.mode === "responses" ? "openai-responses" : "openai-completions",
    contextWindow: llmConfig.contextWindow,
    maxTokens: llmConfig.maxTokens,
  });
  return { llmConfig, transport: transport.mode };
}

/** Mount or update the Cairn provider route for the current model endpoint. */
export async function ensureAgentAiAdapter(ctx: Context, config: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses"; contextWindow?: number; maxTokens?: number }): Promise<void> {
  const same = piAiDisposer && lastPiAiConfig
    && lastPiAiConfig.baseUrl === config.baseUrl
    && lastPiAiConfig.model === config.model
    && lastPiAiConfig.api === config.api
    && lastPiAiConfig.contextWindow === config.contextWindow
    && lastPiAiConfig.maxTokens === config.maxTokens;
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
      models: [{ id: config.model, contextWindow: config.contextWindow ?? 128000, maxTokens: config.maxTokens ?? 32768 }],
      apiKeyEnv: "CAIRN_LLM_API_KEY",
      defaultInput: ["text", "image"],
      retryPolicy: { mode: "normal", maxRetries: 5, backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } },
    } } },
  );
  await handle;
  piAiDisposer = async () => { try { const resolved = await handle; resolved.dispose(); } catch { /* noop */ } };
  lastPiAiConfig = config;
}
