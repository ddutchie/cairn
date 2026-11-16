/**
 * Shared LLM connection defaults.
 *
 * Single home for the default OpenAI-compatible endpoint + model. Imported by
 * the main process (`electron/lib/llm-config.ts`) and the renderer
 * (`src/lib/constants.ts`) so the two sides can never drift apart.
 *
 * Pure: no Node/Electron APIs — importable from main, renderer and tests.
 */

/** Default OpenAI-compatible base URL (trailing-slash-free). */
export const DEFAULT_LLM_BASE_URL = "https://api.openai.com";

/** Default chat/coding model id. */
export const DEFAULT_LLM_MODEL = "gpt-5.6-luna";

/** Default LLM connection (base URL + model). No key — keyless means local. */
export const DEFAULT_LLM = {
  baseUrl: DEFAULT_LLM_BASE_URL,
  model: DEFAULT_LLM_MODEL,
} as const;
