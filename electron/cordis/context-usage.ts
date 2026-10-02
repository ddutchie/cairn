/**
 * Context Ring usage — built from the harness's own token accounting.
 *
 * dsh-token-meter (mounted in cordis-context) already maintains, per session:
 *   - `contextPressure`: the provider-reported prompt size of the latest
 *     request (input + cache read + cache write — dsh usage is disjoint) plus
 *     the surface priced since then, and the context window;
 *   - `contextBreakdown`: system / tools / messages, with a heuristic price for
 *     every node still on the model-visible surface. Compaction and pruning
 *     remove nodes, so the breakdown never counts content that left context.
 *
 * The ring needs one thing the meter doesn't split: "messages" into
 * conversation / tool outputs / skills. Each surviving node carries its event
 * seq, so it is classified by the event it came from. Slices are then scaled
 * so they sum to the real prompt size (the meter's prices are heuristic; the
 * provider count is exact).
 *
 * Live sessions read the registry's state directly. Idle / reloaded sessions
 * fold the persisted log through the SAME registered definitions (no second
 * estimator), so live and reload rings agree.
 */

import type { Context } from "@deepseek-ai/cordis";
import { contextPressureTokens } from "../../shared/agent/context-pressure";
import { estimateCostUsd } from "./host-store";

export interface SessionUsageBreakdown {
  systemPrompt: number;
  tools: number;
  skills: number;
  toolOutputs: number;
  conversation: number;
}

export interface SessionUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  contextLimit?: number;
  contextWindow?: number;
  breakdown?: SessionUsageBreakdown;
}

type AnyEvent = { type: string; seq?: number; data?: unknown };

/** Folded `contextPressure` state (dsh-token-meter stateVersion 5). */
interface PressureState {
  contextWindow?: number;
  pressureTokens?: number;
  surfaceTokens?: number;
  sampledSurfaceTokens?: number;
}

/** Folded `contextBreakdown` state (dsh-token-meter stateVersion 5). */
interface BreakdownState {
  nodes?: Array<{ seq: number; heuristicTokens: number; system: boolean }>;
  breakdown?: { systemTokens?: number; toolsTokens?: number; messageTokens?: number };
}

interface RegistryLike {
  stateOf?: (session: unknown, key: string) => unknown;
  /** Not a public API — read defensively for the offline fold. */
  registrations?: Map<string, { def?: { init?: (header: unknown, inherited: number) => unknown; apply?: (state: unknown, event: unknown) => unknown } }>;
}

type Bucket = "systemPrompt" | "skills" | "toolOutputs" | "conversation";

/** Which ring slice a surviving surface node belongs to. */
export function classifyNode(event: AnyEvent | undefined, system: boolean): Bucket {
  if (system || event?.type === "system/message") return "systemPrompt";
  if (event?.type === "tool/result") return "toolOutputs";
  if (event?.type === "user/message") {
    const kind = (event.data as { source?: { kind?: unknown } } | undefined)?.source?.kind;
    if (typeof kind === "string" && kind !== "user") {
      // Injected context: skill catalogs / skill bodies → skills; other
      // instructions (AGENTS.md, workspace context) read as system prompt.
      return kind.includes("skill") ? "skills" : "systemPrompt";
    }
  }
  return "conversation";
}

/** Latest settled usage (assistant/message.data.usage), newest first. */
function latestUsage(eventAt: (seq: number) => AnyEvent | undefined, lastSeq: number): Record<string, unknown> | undefined {
  // Settled steps are near the tail; bound the walk so a usage-less log stays cheap.
  for (let seq = lastSeq, n = 0; seq >= 0 && n < 2000; seq--, n++) {
    const ev = eventAt(seq);
    if (ev?.type !== "assistant/message") continue;
    const u = (ev.data as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (u) return u;
  }
  return undefined;
}

function modelOf(eventAt: (seq: number) => AnyEvent | undefined, lastSeq: number): string | undefined {
  for (let seq = lastSeq, n = 0; seq >= 0 && n < 2000; seq--, n++) {
    const ev = eventAt(seq);
    if (ev?.type !== "assistant/message") continue;
    const model = (ev.data as { message?: { source?: { model?: unknown } } } | undefined)?.message?.source?.model;
    if (typeof model === "string" && model) return model;
  }
  return undefined;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Combine the meter's folded states into the ring's metrics. Pure — the live
 * and offline paths differ only in where the states and events come from.
 */
export function buildSessionUsage(input: {
  pressure?: PressureState;
  breakdown?: BreakdownState;
  eventAt: (seq: number) => AnyEvent | undefined;
  lastSeq: number;
}): SessionUsageMetrics | undefined {
  const { pressure, breakdown, eventAt, lastSeq } = input;
  const nodes = breakdown?.nodes ?? [];
  const heuristic: Record<Bucket, number> = { systemPrompt: 0, skills: 0, toolOutputs: 0, conversation: 0 };
  for (const node of nodes) heuristic[classifyNode(eventAt(node.seq), node.system)] += num(node.heuristicTokens);
  const tools = num(breakdown?.breakdown?.toolsTokens);
  const heuristicTotal = heuristic.systemPrompt + heuristic.skills + heuristic.toolOutputs + heuristic.conversation + tools;

  // Real prompt size: the provider's count for the latest request, plus the
  // surface priced since it was sampled (tool results not yet sent).
  const sampled = num(pressure?.pressureTokens);
  const projected = sampled > 0 ? Math.max(0, sampled + num(pressure?.surfaceTokens) - num(pressure?.sampledSurfaceTokens)) : 0;
  const promptTokens = projected || heuristicTotal;
  if (promptTokens === 0 && nodes.length === 0) return undefined;

  // Scale heuristic slices onto the real total so they sum to it.
  const scale = heuristicTotal > 0 ? promptTokens / heuristicTotal : 0;
  const slice = (v: number) => Math.round(v * scale);
  const breakdownOut: SessionUsageBreakdown = {
    systemPrompt: slice(heuristic.systemPrompt),
    tools: slice(tools),
    skills: slice(heuristic.skills),
    toolOutputs: slice(heuristic.toolOutputs),
    conversation: slice(heuristic.conversation),
  };

  const u = latestUsage(eventAt, lastSeq);
  const completionTokens = num(u?.outputTokens);
  const cacheReadTokens = typeof u?.cacheReadTokens === "number" ? u.cacheReadTokens : undefined;
  const cacheCreationTokens = typeof u?.cacheWriteTokens === "number" ? u.cacheWriteTokens : undefined;
  let costUsd = typeof u?.costUsd === "number" ? u.costUsd : undefined;
  if (costUsd === undefined && u) {
    const model = modelOf(eventAt, lastSeq);
    if (model) costUsd = estimateCostUsd(model, contextPressureTokens(u), completionTokens, cacheReadTokens ?? 0, cacheCreationTokens ?? 0);
  }
  const contextWindow = num(pressure?.contextWindow) || undefined;
  return {
    promptTokens,
    completionTokens,
    ...(typeof u?.reasoningTokens === "number" ? { reasoningTokens: u.reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(contextWindow ? { contextLimit: contextWindow, contextWindow } : {}),
    breakdown: breakdownOut,
  };
}

function registryOf(ctx: Context): RegistryLike | undefined {
  return (ctx as unknown as { sessionProjections?: RegistryLike }).sessionProjections;
}

/** Ring metrics for a resident session, straight from the registry's state. */
export function readLiveSessionUsage(ctx: Context, session: unknown): SessionUsageMetrics | undefined {
  const registry = registryOf(ctx);
  const s = session as { eventAt?: (seq: number) => AnyEvent | undefined; seq?: number } | null | undefined;
  if (!registry?.stateOf || !s || typeof s.eventAt !== "function") return undefined;
  try {
    const pressure = registry.stateOf(session, "contextPressure") as PressureState | undefined;
    const breakdown = registry.stateOf(session, "contextBreakdown") as BreakdownState | undefined;
    if (!pressure && !breakdown) return undefined;
    const eventAt = s.eventAt.bind(s);
    return buildSessionUsage({ pressure, breakdown, eventAt: (seq) => eventAt(seq as never), lastSeq: (typeof s.seq === "number" ? s.seq : 0) - 1 });
  } catch {
    return undefined;
  }
}

/**
 * Ring metrics for a persisted log (idle / reloaded session): replay it
 * through the token meter's registered definitions. Undefined when the
 * registry or the meter's units aren't available.
 */
export function foldSessionUsageOffline(ctx: Context, events: readonly AnyEvent[], header: unknown = {}): SessionUsageMetrics | undefined {
  if (events.length === 0) return undefined;
  const regs = registryOf(ctx)?.registrations;
  const fold = (key: string): unknown => {
    const def = regs?.get?.(key)?.def;
    if (typeof def?.init !== "function" || typeof def.apply !== "function") return undefined;
    try {
      let state = def.init(header, 0);
      for (const ev of events) state = def.apply(state, ev);
      return state;
    } catch {
      return undefined;
    }
  };
  const pressure = fold("contextPressure") as PressureState | undefined;
  const breakdown = fold("contextBreakdown") as BreakdownState | undefined;
  if (!pressure && !breakdown) return undefined;
  const bySeq = new Map<number, AnyEvent>();
  let lastSeq = -1;
  for (const ev of events) {
    if (typeof ev.seq === "number") { bySeq.set(ev.seq, ev); if (ev.seq > lastSeq) lastSeq = ev.seq; }
  }
  return buildSessionUsage({ pressure, breakdown, eventAt: (seq) => bySeq.get(seq), lastSeq });
}

/**
 * A synthetic `assistant/chunk` usage event carrying the ring metrics for the
 * renderer's live fold. `promptTokens` (not `inputTokens`) marks the count as
 * already the full context size, so the renderer doesn't re-add cache tokens.
 */
export function usageChunkEvent(usage: SessionUsageMetrics | undefined): AnyEvent | null {
  if (!usage?.breakdown) return null;
  return {
    type: "assistant/chunk",
    seq: -1,
    data: {
      chunk: {
        type: "usage",
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.costUsd,
          breakdown: usage.breakdown,
        },
      },
    },
  };
}
