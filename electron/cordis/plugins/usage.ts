import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import "../ctx-augment";
import type { UsageSource } from "../../db/usage-queries";
import { recordUsage } from "../host-store";
import { contextPressureTokens } from "../../../shared/agent/context-pressure";

// ── cairn-usage ─────────────────────────────────────────────────────────────
export interface CairnUsageConfig {
  threadId: string;
  workspaceId: string;
  projectId?: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  /**
   * Which feature this session's usage belongs to, for the Usage view's
   * by-source breakdown. Previously hardcoded to "chat", which mis-attributed
   * every coding and automation turn. Subagent turns are re-tagged at record
   * time (see below) using the `*-subagent` counterpart.
   */
  source: UsageSource;
}

/**
 * Record token/cost usage from dsh usage chunks and messages into `llm_usage`.
 *
 * This is the SINGLE writer for every Cordis session kind (chat, coding,
 * automation). It used to be one of three — `ipc/chat.ts` also wrote a per-turn
 * row and `lib/heartbeat-runner.ts` a per-event row — so chat and automation
 * turns were counted two or three times over.
 *
 * One row per model REQUEST, carrying that request's OWN tokens. The previous
 * version accumulated (`prompt = max(...)`, `completion += ...`) and wrote a row
 * on every usage event, so a 4-step turn produced four rows of running totals;
 * since `queryUsageOverview` SUMs rows, a single turn's prompt tokens were
 * counted ~4x and its cost inflated to match. Per-request rows sum correctly:
 * you are billed for the prefill of every request.
 */
export function cairnUsagePlugin(ctx: Context, config: CairnUsageConfig): void {
  const { threadId, workspaceId, projectId, provider, model, baseUrl, source } = config;

  // Named rather than `typeof u`: a self-referential annotation narrows to never.
  type DshUsage = {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    /** dsh's name for cache-creation tokens. */
    cacheWriteTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  };

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    let u: DshUsage | undefined = undefined;

    // dsh ≥0.1.5 reports per-attempt usage on the settled assistant/message
    // (the `assistant/chunk` usage deltas no longer exist). Every message
    // with usage is its own row — one row per request, never merged.
    if (event.type === "assistant/message") {
      const msgUsage = (event.data as { usage?: DshUsage }).usage;
      if (msgUsage) {
        u = msgUsage;
      }
    }

    if (!u) return;

    // dsh usage is DISJOINT: inputTokens is uncached input only, cached input
    // arrives as cacheReadTokens / cacheWriteTokens. The row's promptTokens is
    // the full billed input (the cost estimator and the Usage view's "% of
    // input" both treat cache tokens as a share of it), so sum all three. The
    // old `cacheRead > input` heuristic undercounted whenever input ≥ cacheRead.
    const promptTokens = contextPressureTokens(u);
    const cacheCreationTokens = typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : u.cacheCreationTokens;
    const completionTokens = u.outputTokens ?? 0;
    const reasoningTokens = u.reasoningTokens ?? 0;
    // dsh emits usage events that carry no counts (e.g. the synthetic
    // breakdown event the chat runner injects for the Context Ring). Writing
    // them produced rows of all-zeros that inflate the row count and show up as
    // empty entries in Recent usage.
    if (promptTokens === 0 && completionTokens === 0 && reasoningTokens === 0) return;

    // Subagent children run on their own dsh session under the same context, so
    // their usage arrives here too. Attribute it to the `*-subagent` source
    // instead of silently booking it against the parent feature.
    const isChild = (session as { header?: { origin?: string } }).header?.origin === "subagent";
    const resolvedSource: UsageSource = isChild
      ? (source === "chat" ? "chat-subagent" : "coding-subagent")
      : source;

    // Via the HostStore seam's standalone recorder (the store method delegates
    // to the same global handle; this plugin never needed ctx beyond `.on`,
    // so it stays untouched for `{ on }`-only harnesses).
    recordUsage({
      source: resolvedSource,
      sessionId: threadId,
      projectId,
      workspaceId,
      provider,
      model,
      baseUrl,
      promptTokens,
      completionTokens,
      reasoningTokens,
      ...(typeof u.cacheReadTokens === "number" ? { cacheReadTokens: u.cacheReadTokens } : {}),
      ...(typeof cacheCreationTokens === "number" ? { cacheCreationTokens } : {}),
      ...(typeof u.costUsd === "number" ? { costUsd: u.costUsd } : {}),
    });
  });
}
