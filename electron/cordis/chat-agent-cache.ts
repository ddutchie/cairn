/**
 * Cairn — module-scoped cache for LIVE dsh chat agents, keyed by threadId.
 *
 * A chat agent is persistent across turns (unlike the coding agent, which
 * runs one loop per session:prompt). Keeping the agent alive lets the next
 * turn's followup message use `agent.steer()` instead of a fresh resume —
 * cheaper, and it preserves the streaming subscription.
 *
 * Previously stored on globalThis with an ad-hoc `(globalThis as any).
 * __cairnChatAgents` cast at every touch site. Consolidating here keeps
 * the shape declared once and lets the touch sites read/write with plain
 * property access (no casts).
 */

import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

/** The subset of an agent's public surface we actually use in chat. */
export interface ChatAgentEntry {
  /** Cordis agent handle from `ctx.agents.resume(...)`. */
  handle?: Record<PropertyKey, unknown>;
  /** The underlying agent object (dsh's Agent). */
  agent?: Record<PropertyKey, unknown>;
  /**
   * Mutable model-selection ref installed via installModelSelection. dsh reads
   * `selectionRef.current` during each step's prompt assembly, so mutating it
   * between turns changes the retained agent's provider/model/reasoningEffort
   * without a resume. Set when the agent is opened.
   */
  selectionRef?: { current: { provider: string; model: string; reasoningEffort?: "off" | "low" | "medium" | "high" } | undefined; assembled: unknown };
  /** Live session — carries the event log used for the Context Ring + replay. */
  session?: Pick<Session, "id" | "seq"> & { events: readonly SessionEvent[] };
  /** Send a follow-up user message onto the live turn (dsh's agent.steer). */
  followup?: (msg: unknown) => void;
  /** Wait for the agent's current work to settle before we send another turn. */
  whenIdle?: () => Promise<void>;
}

// Kept on globalThis so hot-module reloads don't nuke live agents (the
// module identity changes on HMR; globalThis survives).
const GLOBAL_KEY = "__cairnChatAgents" as const;

interface GlobalWithCache {
  [GLOBAL_KEY]?: Map<string, ChatAgentEntry>;
}

function getGlobalStore(): GlobalWithCache {
  return globalThis as unknown as GlobalWithCache;
}

/** Read the shared cache map, allocating on first use. */
export function getChatAgentCache(): Map<string, ChatAgentEntry> {
  const g = getGlobalStore();
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/** Non-allocating peek — returns undefined when the cache doesn't exist yet. */
export function peekChatAgentCache(): Map<string, ChatAgentEntry> | undefined {
  return getGlobalStore()[GLOBAL_KEY];
}
