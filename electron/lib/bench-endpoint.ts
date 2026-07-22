/**
 * Shared live-endpoint config + reachability probe for the chat/subagent
 * benchmarks and smoke tests. Reads the repo's standard TEST_LLM_* env vars.
 * Live suites gate on `endpointUp()` (and CAIRN_SKIP_LIVE_TESTS) so they no-op
 * cleanly when no endpoint is configured.
 */

import { normaliseBaseUrl } from "./llm";

export const BASE_URL = normaliseBaseUrl(
  process.env.TEST_LLM_BASE_URL?.trim() || "http://localhost:1234/v1",
);
export const MODEL = process.env.TEST_LLM_MODEL?.trim() || "gpt-4o-mini";
export const API_KEY = process.env.TEST_LLM_API_KEY?.trim() || "";

/** True if the given (or default) endpoint is reachable. */
export async function endpointUp(url: string = BASE_URL, key: string = API_KEY): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}
