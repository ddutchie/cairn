/**
 * one-shot — single-turn LLM helper via the shared Cordis pi-ai route.
 *
 * One-shot callers (commit messages, PR descriptions, flow summaries, etc.)
 * previously called `electron/lib/llm.ts:184 callLLM` directly. That path
 * used `resolveTransport` + `postChatCompletions` and bypassed the Cordis
 * adapter, token metering, and retry policy.
 *
 * This helper re-uses the already-mounted `cairn` pi-ai route (via
 * `ensurePiAiAdapter` at `run-cordis-loop.ts:158`) and `ctx.llm.stream`
 * (`dsh-llm` at `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:32`).
 * `provider:"cairn"` is the internal route key — its `baseURL` is the user's
 * selected endpoint (OpenAI, Rork, etc. via `run-cordis-loop.ts:188`), not a
 * vendor lock-in. Local models (`localllm`) are not covered and should keep
 * calling `callLLM` directly.
 */

import { getContext, ensurePiAiAdapter } from "./run-cordis-loop";
import "./ctx-augment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveTransport, type ApiMode } from "../lib/llm-transport";
import { recordLlmUsage } from "../lib/usage-recorder";
import type { LLMConfig } from "../lib/llm";

export interface OneShotOptions {
  systemPrompt: string;
  userPrompt: string;
  config: LLMConfig;
  /** Usage source for the usage recorder (e.g. "commit-message", "prd"). */
  source: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Run a single-turn LLM call via the Cordis pi-ai route and return the
 * accumulated text. For `localllm` it falls back to `callLLM` so on-device
 * models keep working.
 */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { systemPrompt, userPrompt, config, source, projectId, workspaceId, sessionId, maxTokens, temperature, signal } = opts;

  // On-device local LLM — also goes through the Cordis pi-ai route.
  // Ensure the llama-server is running and use its OpenAI-compatible endpoint.
  let effectiveConfig = config;
  if (config.provider === "localllm") {
    const { ensureLlamaServerRunning } = await import("../lib/llama-server");
    const port = await ensureLlamaServerRunning();
    effectiveConfig = { ...config, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }

  const ctx = await getContext();
  const transport = await resolveTransport(effectiveConfig.baseUrl, effectiveConfig.apiKey);
  const apiFor = (m: ApiMode): "openai-completions" | "openai-responses" =>
    m === "responses" ? "openai-responses" : "openai-completions";
  await ensurePiAiAdapter(ctx, {
    baseUrl: effectiveConfig.baseUrl,
    model: effectiveConfig.model,
    apiKey: effectiveConfig.apiKey,
    api: apiFor(transport.mode),
  });

  let text = "";
  let promptTokens = 0, completionTokens = 0, reasoningTokens = 0;
  const seenTypes: Record<string, number> = {};

  for await (const chunk of ctx.llm.stream({
    provider: "cairn",
    model: effectiveConfig.model,
    // dsh GenerateOptions: `system` is a dedicated top-level slot (NOT a
    // role:"system" message), and `messages` are structured Message objects with
    // ContentBlock[] content — a plain {role:"system",content:string} list yielded
    // an empty response (finish-only, no text), breaking /compact. Build a proper
    // user Message via createUserMessage and pass the system prompt separately.
    system: systemPrompt,
    messages: [createUserMessage({ content: [{ type: "text", text: userPrompt }] as never, source: { kind: "user" } })],
    ...(maxTokens ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  })) {
    if (signal?.aborted) break;
    seenTypes[chunk.type] = (seenTypes[chunk.type] ?? 0) + 1;
    if (chunk.type === "text-delta" && chunk.text) text += chunk.text;
    // Fallback: if the provider didn't stream text as deltas (e.g. /responses),
    // the final text lands in a `block-end` text ContentBlock. Capture it when
    // no deltas accumulated so /compact still gets a summary.
    else if (chunk.type === "block-end" && chunk.block?.type === "text" && chunk.block.text) {
      if (!text) text += chunk.block.text;
    }
    if (chunk.type === "usage" && chunk.usage) {
      promptTokens = chunk.usage.inputTokens ?? promptTokens;
      completionTokens = chunk.usage.outputTokens ?? completionTokens;
      reasoningTokens = chunk.usage.reasoningTokens ?? reasoningTokens;
    }
  }
  console.log("[one-shot] stream done", { source, textLen: text.length, seenTypes });

  // Record usage for the Usage view — same shape as callLLM's recordLlmUsage.
  try {
    recordLlmUsage({
      source: source as never,
      sessionId: sessionId ?? "one-shot",
      projectId, workspaceId,
      provider: effectiveConfig.provider ?? "openai",
      model: effectiveConfig.model,
      baseUrl: effectiveConfig.baseUrl,
      promptTokens, completionTokens, reasoningTokens,
    });
  } catch { /* best-effort */ }

  return text;
}
