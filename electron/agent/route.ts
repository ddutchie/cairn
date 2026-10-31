/** Cairn endpoint config → engine ModelRoute. The wire protocol is pinned from the saved apiMode, never probed. */
import { wireApiFor, wireBaseUrlFor } from "../lib/model-pricing";
import type { ModelRoute } from "./provider";

export interface RouteConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiMode?: "responses" | "completions" | "anthropic-messages";
  contextWindow?: number;
  maxTokens?: number;
  isReasoningModel?: boolean;
  reasoningEffort?: string;
}

export function routeFromConfig(cfg: RouteConfig): ModelRoute {
  const configured = cfg.apiMode === "responses" ? "openai-responses" : cfg.apiMode === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
  const api = wireApiFor(cfg.baseUrl, cfg.model, configured);
  return {
    baseUrl: wireBaseUrlFor(cfg.baseUrl, api),
    model: cfg.model,
    apiKey: cfg.apiKey || undefined,
    api,
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens || undefined,
    reasoning: cfg.isReasoningModel === true || (!!cfg.reasoningEffort && cfg.reasoningEffort !== "off"),
  };
}
