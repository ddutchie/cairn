/**
 * Model routes → pi-ai. Replaces the useful ~5% of @deepseek-ai/engine-llm-pi-ai:
 * turn a Cairn route (endpoint + wire protocol + model facts) into a pi-ai
 * Model and a StreamFn, map reasoning efforts onto the model's level table, and
 * keep the quirks Cairn relied on:
 *
 *  - explicit wire protocol, never auto-probed (so a persisted session is never
 *    replayed into a different api)
 *  - Responses routes declare reasoning "off" unsupported: pi-ai's Responses
 *    client sends `reasoning.effort: "none"` when `off` is absent, which some
 *    models (muse-spark) reject; unsupported ⇒ we send no reasoning field
 *  - `maxRetries: 0` toward pi-ai — the loop owns retry so it can report it
 *  - Gemini over a gateway speaks only generateContent ("google-generative-ai")
 *
 * Because sessions persist pi-ai's own AssistantMessage, none of engine's replay
 * translation (toPiReplayState / foreignAssistant) is needed.
 */
import {
  createModels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Provider,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { StreamFn } from "./loop";

export type WireApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface ModelRoute {
  baseUrl: string;
  model: string;
  /** Empty for keyless local servers. */
  apiKey?: string;
  api: WireApi;
  contextWindow?: number;
  maxTokens?: number;
  /** Declare the model reasoning-capable (offers low/medium/high). */
  reasoning?: boolean;
  input?: ("text" | "image")[];
  headers?: Record<string, string>;
  /** USD per million tokens. Defaults to zero; Cairn prices usage itself. */
  cost?: Model<Api>["cost"];
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 32_768;

const NO_COST: Model<Api>["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const PROTOCOLS: Record<WireApi, () => unknown> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ESCALATION: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLevelMap(api: WireApi): ThinkingLevelMap {
  const map: ThinkingLevelMap = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
  if (api === "openai-responses") map.off = null;
  return map;
}

export function buildModel(route: ModelRoute): Model<Api> {
  return {
    id: route.model,
    name: route.model,
    api: route.api,
    provider: "cairn",
    baseUrl: route.baseUrl,
    input: route.input ?? ["text", "image"],
    cost: route.cost ?? NO_COST,
    contextWindow: route.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: route.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: route.reasoning === true,
    ...(route.reasoning === true ? { thinkingLevelMap: thinkingLevelMap(route.api) } : {}),
    ...(route.headers ? { headers: route.headers } : {}),
  } as Model<Api>;
}

/** Levels the model accepts, in escalation order ("off" first when allowed). */
export function supportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * The `reasoning` stream option for a requested effort. "off"/unset ⇒ none.
 * An effort the model doesn't offer is clamped to the nearest lower offered
 * level (else the nearest higher) rather than throwing mid-turn.
 */
export function reasoningOption(model: Model<Api>, effort: string | undefined): ThinkingLevel | undefined {
  if (!effort || effort === "off" || !model.reasoning) return undefined;
  const offered = supportedThinkingLevels(model).filter((l): l is ThinkingLevel => l !== "off");
  if (offered.length === 0) return undefined;
  const want = ESCALATION.indexOf(effort as ThinkingLevel);
  if (want < 0) return undefined;
  if (offered.includes(effort as ThinkingLevel)) return effort as ThinkingLevel;
  const lower = offered.filter((l) => ESCALATION.indexOf(l) < want).at(-1);
  return lower ?? offered[0];
}

export interface RoutedStream {
  model: Model<Api>;
  streamFn: StreamFn;
}

/** A model and a StreamFn bound to one route. Cheap; build per turn or cache by route. */
export function createRouteStream(route: ModelRoute): RoutedStream {
  const model = buildModel(route);
  const protocol = PROTOCOLS[route.api];
  if (!protocol) throw new Error(`Unsupported wire protocol: ${route.api}`);
  const api = protocol() as Pick<Provider, "stream" | "streamSimple">;

  const provider: Provider = {
    id: "cairn",
    name: "Cairn",
    baseUrl: route.baseUrl,
    auth: {
      apiKey: {
        name: "Cairn",
        resolve: ({ credential }: { credential?: { key?: string } }) =>
          Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: "Cairn" }),
      },
    },
    getModels: () => [model],
    stream: (...args: Parameters<Provider["stream"]>) => api.stream(...args),
    streamSimple: (...args: Parameters<Provider["streamSimple"]>) => api.streamSimple(...args),
  } as unknown as Provider;

  const models = createModels();
  models.setProvider(provider);

  // pi-ai only honours an apiKey override for providers that declare api-key
  // auth, and a keyless local server still needs a non-empty value on the wire.
  const apiKey = route.apiKey && route.apiKey.length > 0 ? route.apiKey : "local";
  const streamFn: StreamFn = (m, context, options) => models.streamSimple(m, context, { ...options, apiKey, maxRetries: 0 });
  return { model, streamFn };
}
