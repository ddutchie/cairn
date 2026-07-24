/**
 * Shared live-endpoint config + reachability probe for the chat/subagent
 * benchmarks and smoke tests. Reads the repo's standard TEST_LLM_* env vars.
 *
 * Live suites are OPT-IN via a DEDICATED flag: they no-op unless the runner
 * sets `CAIRN_LIVE_TESTS=1`. Endpoint presence is deliberately NOT the trigger,
 * because the repo convention loads `.env.test` (which sets TEST_LLM_BASE_URL on
 * a developer's machine) — so keying off the endpoint would make the slow,
 * non-deterministic, network-bearing live suites run on every `npm test` for
 * anyone who has ever configured a local model. They must never gate a normal
 * test/CI run.
 *
 * Enable them with:  CAIRN_LIVE_TESTS=1 npm test
 * `CAIRN_SKIP_LIVE_TESTS=1` remains a hard override that force-skips.
 */

import { normaliseBaseUrl } from "./llm";

export const BASE_URL = normaliseBaseUrl(
  process.env.TEST_LLM_BASE_URL?.trim() || "http://localhost:1234/v1",
);
export const MODEL = process.env.TEST_LLM_MODEL?.trim() || "gpt-4o-mini";
export const API_KEY = process.env.TEST_LLM_API_KEY?.trim() || "";

/**
 * Whether the live/benchmark suites should run. OPT-IN via the dedicated
 * `CAIRN_LIVE_TESTS=1` flag only — never inferred from endpoint/env presence
 * (see the file header for why). Always false when CAIRN_SKIP_LIVE_TESTS is set.
 * Suites gate with `describe.skipIf(!LIVE_TESTS_ENABLED)`.
 */
export const LIVE_TESTS_ENABLED =
  !process.env.CAIRN_SKIP_LIVE_TESTS && process.env.CAIRN_LIVE_TESTS === "1";

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
