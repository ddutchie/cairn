/**
 * One-shot completions: a single model call with no tools or session (commit
 * messages, PR descriptions, flow summaries, PRDs). Goes through the same route
 * and stream as the loop, so protocol pinning and usage accounting match.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { recordLlmUsage } from "../lib/usage-recorder";
import type { LLMConfig } from "../lib/llm";
import { createRouteStream } from "./provider";
import { routeFromConfig } from "./route";

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
 * Rejects when the model call fails or returns nothing. A caller abort resolves
 * with whatever text had arrived.
 */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { systemPrompt, userPrompt, config, source, projectId, workspaceId, sessionId, maxTokens, temperature, signal } = opts;
  const { model, streamFn } = createRouteStream(routeFromConfig(config));

  const stream = streamFn(model, { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] }, {
    signal,
    ...(maxTokens ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  });
  for await (const ev of stream) void ev;
  const result: AssistantMessage = await stream.result();

  try {
    recordLlmUsage({
      source: source as never,
      sessionId: sessionId ?? "one-shot",
      projectId, workspaceId,
      provider: config.provider ?? "openai",
      model: config.model,
      baseUrl: config.baseUrl,
      promptTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      completionTokens: result.usage.output,
      reasoningTokens: (result.usage as { reasoning?: number }).reasoning ?? 0,
      cacheReadTokens: result.usage.cacheRead,
      cacheCreationTokens: result.usage.cacheWrite,
    } as never);
  } catch { /* best-effort */ }

  const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (result.stopReason === "error") throw new Error(result.errorMessage || "Model request failed.");
  if (result.stopReason === "aborted") return text;
  if (!text.trim()) throw new Error("The model returned an empty response.");
  return text;
}
