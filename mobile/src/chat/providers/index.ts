/**
 * Provider auto-selection.
 *
 * Respects the user's provider preference (ai-config), then falls back:
 *   1. If pref is "apple" and the device supports on-device Apple Intelligence → Apple.
 *   2. If pref is "openai" and an OpenAI key is configured → OpenAI.
 *   3. OpenAI-compatible — if the user configured a base URL + API key in-app.
 *   4. On-device Apple — as a last-resort fallback whenever it's available
 *      (works offline, no key), even when it wasn't the explicit preference.
 *   5. Neither → throw NoProviderError so the UI can prompt the user to add a
 *      key in Settings (or enable Apple Intelligence).
 */

import { getProviderPref, resolveOpenAIConfig, type OpenAIConfig } from "../ai-config";
import { ensureAiConsent } from "../ai-consent";
import {
  appleOnDeviceProvider,
  appleProvider,
  isAppleOnDeviceAvailable,
  isAppleServerProviderAvailable,
} from "./apple";
import { makeOpenAIProvider } from "./openai";
import { makeResponsesProvider, supportsResponses } from "./responses";
import { endpointProtocolForModel } from "../models-dev";
import type { WireProtocol } from "@cairn/shared/models/model-catalog";
import type { ChatProvider } from "./types";

export * from "./types";

/** Thrown when no AI backend is configured (no OpenAI key, no Apple Intelligence). */
export class NoProviderError extends Error {
  constructor() {
    super(
      "No AI provider configured. Enable Apple Intelligence, or add an OpenAI-compatible base URL and API key in Settings.",
    );
    this.name = "NoProviderError";
  }
}

/** The chosen model only speaks a protocol this app has no client for yet. */
export class UnsupportedModelProtocolError extends Error {
  constructor(model: string, protocol: Exclude<WireProtocol, "completions" | "responses">) {
    const api = protocol === "anthropic-messages" ? "Anthropic Messages" : "Gemini";
    super(`${model} only works over the ${api} API, which Cairn on iPhone doesn't support yet. Pick another model in AI settings.`);
    this.name = "UnsupportedModelProtocolError";
  }
}

/**
 * The Apple provider to use, if any: Private Cloud Compute (user-facing) when
 * available, else the on-device model when the dev flag exposes it. null when
 * neither is available.
 */
function appleProviderOrNull(): ChatProvider | null {
  if (isAppleServerProviderAvailable()) return appleProvider;
  if (isAppleOnDeviceAvailable()) return appleOnDeviceProvider;
  return null;
}

/**
 * Pick the OpenAI-compatible provider for a config: the Responses API when the
 * endpoint serves `/responses` (OpenAI/Azure, or anything the probe discovers),
 * else Chat Completions. The probe is a single cheap request and never throws.
 */
async function openaiCompatible(config: OpenAIConfig): Promise<ChatProvider> {
  // Every chat / note-AI request to a third-party endpoint passes here: ask once
  // per host before anything is sent (throws AiConsentDeclinedError on decline).
  await ensureAiConsent(config.baseUrl);
  // OpenCode serves each model over exactly one protocol (models.dev records
  // which), so the model decides — no probe, which can't see the model anyway.
  const protocol = await endpointProtocolForModel(config.baseUrl, config.model);
  if (protocol === "responses") return makeResponsesProvider(config);
  if (protocol === "completions") return makeOpenAIProvider(config);
  if (protocol) throw new UnsupportedModelProtocolError(config.model, protocol);
  if (await supportsResponses(config.baseUrl, config.apiKey, config.model)) {
    return makeResponsesProvider(config);
  }
  return makeOpenAIProvider(config);
}

/**
 * Resolve the active provider. Honours the user's preference first (Apple →
 * PCC when available, else dev on-device; OpenAI when configured), then a
 * configured OpenAI, then Apple as a fallback, else NoProviderError. Async because reading the API key touches the keychain.
 */
export async function resolveProvider(): Promise<ChatProvider> {
  const apple = appleProviderOrNull();
  const pref = getProviderPref();

  if (pref === "apple") {
    if (apple) return apple;
    // Preferred Apple but unavailable (older OS / not entitled / disabled) — fall through.
  } else if (pref === "openai") {
    const openai = await resolveOpenAIConfig();
    if (openai) return openaiCompatible(openai);
    // Preferred OpenAI but not configured — fall back below.
  }

  // Fallback order: configured OpenAI → Apple (PCC or dev on-device).
  const openai = await resolveOpenAIConfig();
  if (openai) return openaiCompatible(openai);
  if (apple) return apple;
  throw new NoProviderError();
}

/** Whether any provider is usable right now (for gating the composer). */
export async function hasProvider(): Promise<boolean> {
  if (appleProviderOrNull()) return true;
  return (await resolveOpenAIConfig()) != null;
}
