/**
 * Cairn — Provider credit/balance lookup (Electron side).
 *
 * Pure parsing + descriptor resolution live in shared/chat/provider-credits.ts
 * (shared with mobile). This module re-exports them and hosts the fetch-based
 * `probeCredits` probe (global fetch — Electron main process). Used by the
 * `ai:fetchKeyInfo` IPC handler and by the live credit-endpoint integration
 * test (which feeds it the local manifest).
 */

import { parseCredits, type CreditInfo } from "../../shared/chat/provider-credits";

export {
  sameEndpoint,
  resolveCreditSpec,
  parseCredits,
  parseOpenRouterCredits,
  parseDeepSeekCredits,
  parseOpenAiGrantsCredits,
  parseNeuralwattCredits,
} from "../../shared/chat/provider-credits";
export type { CreditInfo } from "../../shared/chat/provider-credits";

/** Result of a single live credit-endpoint probe. */
export interface CreditProbe {
  /** HTTP status, or 0 when the request failed/aborted before a response. */
  status: number;
  /** Parsed credits on a 2xx response; null otherwise. */
  info: CreditInfo | null;
  /** Short failure description when `status` is 0. */
  error?: string;
}

/**
 * Hit a provider credit/balance endpoint and parse the response per `shape`.
 * Never throws — network failures / non-2xx / unparseable bodies all degrade
 * to `{ status, info: null }` so callers can hide the credits display.
 */
export async function probeCredits(
  url: string,
  apiKey: string,
  shape: string,
  signal?: AbortSignal
): Promise<CreditProbe> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (err) {
    return {
      status: 0,
      info: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) return { status: res.status, info: null };
  try {
    return { status: res.status, info: parseCredits(shape, (await res.json()) as unknown) };
  } catch (err) {
    return {
      status: res.status,
      info: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
