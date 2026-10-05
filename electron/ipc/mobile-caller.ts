/**
 * Requests that reach a handler through the Mobile Access bridge
 * (`electron/lib/mobile-server.ts`) carry {@link MOBILE_CALLER} on their event.
 * The allowlist in `mobile-access.ts` decides which channels the phone may call;
 * this module limits what an allowed agent request may ask for.
 *
 * A phone may start an agent turn, but it must not be able to:
 *   - pick its own approval policy or approval mode (e.g. "allow-all" / "auto"),
 *     which would skip the nonce-gated approvals it can never answer;
 *   - pair a stored key reference with a base URL of its choosing, which would
 *     send the resolved key to that URL;
 *   - choose the directory a coding session runs in;
 *   - rewrite the desktop's cached connection settings.
 */

import { normaliseBaseUrl } from "../lib/llm";
import type { CachedConfig } from "../lib/config-cache";

/** Set by the Mobile Access bridge on the event it hands to handlers. */
export const MOBILE_CALLER = Symbol("cairn.mobileCaller");

export function isMobileCaller(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as Record<symbol, unknown>)[MOBILE_CALLER] === true;
}

export interface Connection {
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  apiMode?: string;
}

/** Every connection the desktop has saved: the active chat + agent ones and the provider list. */
export function knownConnections(config: CachedConfig): Connection[] {
  return [
    config.aiConfig,
    config.agentConfig,
    ...(config.aiConfig?.savedProviders ?? []),
  ].filter((c): c is Connection => !!c && typeof c.baseUrl === "string" && c.baseUrl.trim() !== "");
}

const sameUrl = (a: string, b: string) => normaliseBaseUrl(a) === normaliseBaseUrl(b);

function isKnown(conn: Connection, known: Connection[]): boolean {
  if (!conn.baseUrl?.trim()) return false;
  return known.some((k) => sameUrl(k.baseUrl!, conn.baseUrl!) && (k.apiKey ?? "") === (conn.apiKey ?? ""));
}

/**
 * The connection a phone request may use: its own when that exact base URL +
 * key pair is saved on the desktop, otherwise `fallback` (the desktop's active
 * connection for this surface). The model and tuning fields are kept.
 */
export function pinMobileConnection<C extends Connection & { autoApprove?: boolean; mode?: unknown }>(
  config: C | undefined,
  known: Connection[],
  fallback: Connection | undefined,
): C {
  const out = { ...(config ?? {}) } as C;
  delete out.autoApprove;
  delete out.mode;
  if (isKnown(out, known)) return out;
  delete out.baseUrl;
  delete out.apiKey;
  delete out.provider;
  delete out.apiMode;
  if (fallback?.baseUrl) out.baseUrl = fallback.baseUrl;
  if (fallback?.apiKey) out.apiKey = fallback.apiKey;
  if (fallback?.provider) out.provider = fallback.provider;
  if (fallback?.apiMode) out.apiMode = fallback.apiMode;
  return out;
}

/** The desktop's active agent connection, with the saved provider's apiMode when known. */
export function agentFallback(config: CachedConfig): Connection | undefined {
  const agent = config.agentConfig;
  if (!agent) return undefined;
  const saved = config.aiConfig?.savedProviders?.find((p) => p.id === agent.activeProviderId);
  return { baseUrl: agent.baseUrl, apiKey: agent.apiKey, apiMode: saved?.apiMode };
}

/**
 * Strip what a phone may not choose from an agent request: approval policy,
 * approval mode, an unsaved connection, and the working directory (replaced
 * by `storedCwd`, the session row's cwd; `undefined` when there is none).
 */
export function sanitizeMobileRequest<R extends { cwd?: string; approvalPolicy?: unknown; config?: Connection & { autoApprove?: boolean; mode?: unknown } }>(
  req: R,
  opts: { config: CachedConfig; fallback: Connection | undefined; storedCwd: string | undefined },
): R {
  const out = { ...req };
  delete out.approvalPolicy;
  out.cwd = opts.storedCwd as R["cwd"];
  out.config = pinMobileConnection(req.config, knownConnections(opts.config), opts.fallback);
  return out;
}

/**
 * Bridge-level pass over a phone request's arguments: a `config` on the first
 * argument is always an LLM connection on the channels a phone may call (chat
 * compaction and summaries, Idea Flow summaries, the AI helpers, agent turns),
 * so pin it to a saved connection before any handler resolves its key.
 */
export function pinMobileArgs(args: unknown[], config: CachedConfig): unknown[] {
  const [first, ...rest] = args;
  if (typeof first !== "object" || first === null || Array.isArray(first)) return args;
  const req = first as { config?: unknown };
  if (typeof req.config !== "object" || req.config === null) return args;
  const pinned = pinMobileConnection(req.config as Connection, knownConnections(config), config.aiConfig);
  return [{ ...req, config: pinned }, ...rest];
}
