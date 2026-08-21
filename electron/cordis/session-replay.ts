/**
 * Cairn — session replay helpers (dsh as source of truth).
 *
 * Shared logic for rebuilding UI message history from a dsh JSONL session log
 * via the canonical surface (`foldSurface` + `deriveEventMessage`). Used by BOTH
 * the chat load path (electron/ipc/chat-session.ts) and the pi-agent/coding load
 * path (electron/ipc/pi-session-handlers.ts), so the two surfaces stay in lockstep
 * (session-as-truth, not the duplicated SQLite tables).
 *
 * The dsh surface (scratch/dsh-repo/packages/core/session/src/surface.ts:14) is
 * exactly `user/message` + `assistant/message` + `tool/result`, with `surfaceOp`
 * append/replace + compaction handling. `deriveEventMessage` is the per-node
 * projection. We fold once, project each node, then collapse the per-step
 * assistant nodes into a single per-turn bubble (Cairn's UI model), attaching
 * `tool/result` outputs to their `tool-call` chips so nothing renders stuck.
 */

import { foldSurface, deriveEventMessage, type SessionEvent } from "@deepseek-ai/dsh-session";

/** A generic derived message block (post foldSurface + deriveEventMessage). */
type DerivedBlock = { type: string; text?: string; id?: string; name?: string; arguments?: string; toolCallId?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
type DerivedMessage = { id: string; role: string; content: DerivedBlock[]; source?: { kind?: string; form?: string; model?: string } };

/** A UI-agnostic tool-call record (superset of chat + pi-agent shapes). */
export interface ReplayToolCall {
  tool: string;
  label: string;
  callId?: string;
  args?: string;
  output?: string;
  ok?: boolean;
  error?: string;
  /** presentationMeta persisted on the tool/result event (dsh writes it at
   *  event.data.meta). Rich toolviews (dsh-visualize) render their card from
   *  this; absent → generic text rendering. */
  meta?: Record<string, unknown>;
}

/** A UI-agnostic replayed message (both chat + pi-agent map from this). */
export interface ReplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  reasoningItems?: Array<Record<string, unknown>>;
  reasoningModel?: string;
  toolCalls?: ReplayToolCall[];
}

/** A replayed subagent trace (child session). */
export interface ReplaySubagent {
  childId: string;
  role: string;
  instruction: string;
  content: string;
  reasoning?: string;
  toolCalls?: ReplayToolCall[];
  running: false;
  result?: string;
}

function getMessageSource(msg: { source?: unknown }): { kind?: string; form?: string; model?: string } | undefined {
  return msg.source as { kind?: string; form?: string; model?: string } | undefined;
}

/** Fold a raw event log to the ordered derived messages the model saw. */
export function deriveMessagesFromEvents(events: readonly SessionEvent[]): DerivedMessage[] {
  const { nodes } = foldSurface(events);
  return nodes
    .map((seq) => deriveEventMessage(events[seq]))
    .filter((m): m is NonNullable<ReturnType<typeof deriveEventMessage>> => m !== null) as unknown as DerivedMessage[];
}

/**
 * Collapse derived messages into per-turn UI messages: buffer reasoning/tool-call-
 * only assistant steps and attach them (with their tool/result outputs) to the
 * next text assistant. Snapshot (`form:snapshot`) user turns are dropped.
 */
/**
 * Extract persisted presentationMeta from raw tool/result events: dsh writes it
 * at event.data.meta (sibling of message), keyed by the result's callId.
 */
export function metaByCallIdFromEvents(events: readonly SessionEvent[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if ((e as { type?: string }).type !== "tool/result") continue;
    const d = e.data as { meta?: unknown; message?: { source?: { callId?: string } } } | undefined;
    const callId = d?.message?.source?.callId;
    if (callId && d.meta && typeof d.meta === "object") map.set(callId, d.meta as Record<string, unknown>);
  }
  return map;
}

export function collapseDerivedToMessages(
  derived: readonly DerivedMessage[],
  metaByCallId?: ReadonlyMap<string, Record<string, unknown>>,
): ReplayMessage[] {
  const out: ReplayMessage[] = [];
  let pendingToolResults: Array<{ callId?: string; output?: string; ok?: boolean; error?: string; meta?: Record<string, unknown> }> = [];
  let carryoverToolCalls: ReplayToolCall[] = [];

  const flushResultsInto = (calls: ReplayToolCall[]) => {
    if (!pendingToolResults.length || !calls.length) return;
    for (const tr of pendingToolResults) {
      const idx = calls.findIndex((tc) => tc.callId === tr.callId);
      if (idx !== -1) calls[idx] = { ...calls[idx], output: tr.ok === false ? undefined : tr.output, ok: tr.ok, error: tr.error, ...(tr.meta ? { meta: tr.meta } : {}) };
    }
    pendingToolResults = [];
  };

  for (const m of derived) {
    const src = getMessageSource(m);
    if (m.role === "user" && src?.kind === "plugin" && src?.form === "snapshot") continue;

    if (m.role === "user") {
      const isToolResult = (m.content ?? []).some((b) => b.type === "tool-result");
      if (isToolResult) {
        for (const tr of (m.content ?? []).filter((b) => b.type === "tool-result")) {
          const output = tr.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
          const meta = tr.toolCallId ? metaByCallId?.get(tr.toolCallId) : undefined;
          pendingToolResults.push({ callId: tr.toolCallId, output, ok: !tr.isError, error: tr.isError ? (output || "tool error") : undefined, ...(meta ? { meta } : {}) });
        }
        continue;
      }
      const text = (m.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
      if (!text.trim()) continue;
      out.push({ id: String(m.id), role: "user", content: text });
      continue;
    }

    if (m.role === "assistant") {
      const text = (m.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
      // Multiple reasoning blocks in one turn are joined with a separator so
      // one block's end never glues onto the next block's start.
      const reasoning = (m.content ?? []).filter((b) => b.type === "reasoning" && b.text).map((b) => b.text ?? "").join("\n\n");
      const reasoningItems = (m.content ?? []).filter((b) => b.type === "reasoning" && b.text) as unknown as Array<Record<string, unknown>>;
      const toolCallsRaw = (m.content ?? []).filter((b) => b.type === "tool-call");
      const toolCalls: ReplayToolCall[] = toolCallsRaw.map((c) => ({ tool: c.name ?? "tool", label: c.name ?? "tool", callId: c.id, args: c.arguments }));

      if (!text.trim() && toolCalls.length) {
        carryoverToolCalls.push(...toolCalls);
        continue;
      }
      if (!text.trim() && !reasoning.trim() && toolCalls.length === 0) continue;

      const mergedCalls = [...carryoverToolCalls, ...toolCalls];
      carryoverToolCalls = [];
      flushResultsInto(mergedCalls);
      out.push({
        id: String(m.id),
        role: "assistant",
        content: text || "",
        reasoning: reasoning || undefined,
        reasoningItems: reasoningItems.length ? reasoningItems : undefined,
        reasoningModel: (m.source as { model?: string })?.model,
        toolCalls: mergedCalls.length ? mergedCalls : undefined,
      });
      continue;
    }

    if (m.role === "tool") {
      for (const tr of (m.content ?? []).filter((b) => b.type === "tool-result")) {
        const output = tr.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
        pendingToolResults.push({ callId: tr.toolCallId, output, ok: !tr.isError, error: tr.isError ? (output || "tool error") : undefined });
      }
      continue;
    }
  }
  // Any trailing carryover tool calls with no following text assistant — surface
  // them on a final empty assistant so the chips aren't lost.
  if (carryoverToolCalls.length) {
    flushResultsInto(carryoverToolCalls);
    out.push({ id: `${out.length}-trailing`, role: "assistant", content: "", toolCalls: carryoverToolCalls });
  }
  return out;
}

/** Build a subagent trace from a child session's derived messages. */
export function childDerivedToSubagent(derived: readonly DerivedMessage[], childId: string): ReplaySubagent | null {
  let instruction = "";
  let content = "";
  let reasoning = "";
  const toolCalls: ReplayToolCall[] = [];
  const toolCallsById = new Map<string, number>();

  for (const m of derived) {
    if (m.role === "user") {
      const isToolResult = (m.content ?? []).some((b) => b.type === "tool-result");
      if (isToolResult) {
        for (const tr of (m.content ?? []).filter((b) => b.type === "tool-result")) {
          const out = tr.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
          const idx = tr.toolCallId ? toolCallsById.get(tr.toolCallId) : undefined;
          if (idx !== undefined) toolCalls[idx] = { ...toolCalls[idx], output: tr.isError ? undefined : (out || "{}"), ok: !tr.isError, error: tr.isError ? (out || "tool error") : undefined };
        }
        continue;
      }
      if (!instruction) {
        const txt = (m.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
        if (txt.trim() && !txt.startsWith("Current runtime context")) instruction = txt.trim();
      }
    }
    if (m.role === "tool") {
      for (const tr of (m.content ?? []).filter((b) => b.type === "tool-result")) {
        const out = tr.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
        const idx = tr.toolCallId ? toolCallsById.get(tr.toolCallId) : undefined;
        if (idx !== undefined) toolCalls[idx] = { ...toolCalls[idx], output: tr.isError ? undefined : (out || "{}"), ok: !tr.isError, error: tr.isError ? (out || "tool error") : undefined };
      }
    }
    if (m.role === "assistant") {
      content += (m.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
      reasoning += (m.content ?? []).filter((b) => b.type === "reasoning" && b.text).map((b) => b.text ?? "").join("");
      for (const tc of (m.content ?? []).filter((b) => b.type === "tool-call")) {
        if (tc.id) toolCallsById.set(tc.id, toolCalls.length);
        toolCalls.push({ tool: tc.name ?? "tool", label: tc.name ?? "tool", callId: tc.id, args: tc.arguments, output: "{}", ok: true });
      }
    }
  }
  if (!instruction && !content && toolCalls.length === 0) return null;
  return {
    childId,
    role: "subagent",
    instruction: instruction || "",
    content: content || "",
    reasoning: reasoning || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    running: false,
    result: content || undefined,
  };
}

/** Read the `subagent/descriptor` label from a child's raw events (not a surface node). */
export function descriptorLabelFromEvents(events: readonly SessionEvent[]): string {
  for (const ev of events as unknown as Array<{ type: string; data: { label?: string } }>) {
    if (ev.type === "subagent/descriptor" && ev.data?.label) return ev.data.label;
  }
  return "";
}

/**
 * Given a persistence backend + a parent session id, load the parent's derived
 * messages and any subagent children (origin==='subagent', parentSession===id),
 * returning the collapsed messages with the most-recent subagent attached to the
 * dispatching assistant. Shared by chat + pi-agent load paths.
 */
export async function loadSessionMessages(
  pers: {
    inspect: (id: unknown) => Promise<{ header: unknown; events: readonly unknown[] }>;
    list?: () => Promise<Array<{ id: unknown; origin?: string; parentSession?: unknown; createdAt?: number; meta?: { origin?: string; parentSession?: unknown; createdAt?: number } }>>;
  },
  liveSessions: (() => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }>) | undefined,
  sessionId: string,
): Promise<{ messages: ReplayMessage[]; subagents: ReplaySubagent[] }> {
  const inspection = await pers.inspect(sessionId);
  const events = (inspection?.events ?? []) as readonly SessionEvent[];
  if (!events || events.length === 0) return { messages: [], subagents: [] };
  const messages = collapseDerivedToMessages(deriveMessagesFromEvents(events), metaByCallIdFromEvents(events));

  // Collect subagent children (durable list + live in-memory not yet flushed)
  let list: Array<{ id: unknown; origin?: string; parentSession?: unknown; createdAt?: number; meta?: { origin?: string; parentSession?: unknown; createdAt?: number } }> = [];
  try { list = pers.list ? await pers.list() : []; } catch { /* ignore */ }
  try {
    const live = liveSessions?.() ?? [];
    for (const s of live) {
      const h = s.header ?? s;
      if (!list.some((x) => String(x.id) === String(s.id))) {
        list.push({ id: s.id, origin: (h as { origin?: string }).origin, parentSession: (h as { parentSession?: unknown }).parentSession, createdAt: (h as { createdAt?: number }).createdAt });
      }
    }
  } catch { /* ignore live */ }

  const childHeaders = list.filter((h) => {
    const origin = h.origin ?? h.meta?.origin;
    const parent = h.parentSession ?? h.meta?.parentSession;
    return origin === "subagent" && String(parent) === String(sessionId);
  });
  // Dedup by child id (the durable pers.list() + live ctx.sessions.list() can
  // both return the same child, which would double the block).
  const seenChildIds = new Set<string>();
  const uniqueChildHeaders = childHeaders.filter((h) => {
    const id = String(h.id);
    if (seenChildIds.has(id)) return false;
    seenChildIds.add(id);
    return true;
  });

  // Build each child's ReplaySubagent (all of them, oldest-first so their order
  // matches the parent's subagent tool-calls in dispatch order). Each child's
  // instruction === the parent subagent tool-call `prompt` arg, so we correlate
  // by prompt-match, falling back to dispatch order.
  const built: Array<{ createdAt: number; instruction: string; sub: ReplaySubagent }> = [];
  if (uniqueChildHeaders.length > 0) {
    for (const ch of uniqueChildHeaders) {
      try {
        const childInsp = await pers.inspect(ch.id);
        const childEvents = (childInsp?.events ?? []) as readonly SessionEvent[];
        if (!childEvents || childEvents.length === 0) continue;
        const childDerived = deriveMessagesFromEvents(childEvents);
        const label = descriptorLabelFromEvents(childEvents);
        const sub = childDerivedToSubagent(childDerived, String(ch.id));
        if (sub) {
          const promptInstruction = sub.instruction; // full first-user prompt (dispatch prompt)
          if (label) { sub.role = label; if (!sub.instruction) sub.instruction = label; }
          built.push({ createdAt: Number(ch.createdAt ?? ch.meta?.createdAt ?? 0), instruction: promptInstruction, sub });
        }
      } catch { /* skip failed child */ }
    }
  }
  built.sort((a, b) => a.createdAt - b.createdAt);

  // Attach each subagent to the assistant that dispatched it, matched by the
  // child's first-user prompt === the parent `subagent` tool-call `prompt` arg.
  // Only subagents that correlate to a `subagent` dispatch chip visible in the
  // current (post-compaction) messages are shown — a thread accumulates one child
  // per turn/test, and older orphans (whose dispatching assistant was compacted
  // away, or from a prior cleared-but-not-purged run) must NOT be dumped onto the
  // last assistant (that produced duplicate blocks for the same descriptor).
  const attachedSubs: ReplaySubagent[] = [];
  if (built.length > 0) {
    const remaining = [...built];
    for (const m of messages) {
      if (m.role !== "assistant" || !m.toolCalls) continue;
      const dispatchChips = m.toolCalls.filter((tc) => tc.tool === "subagent");
      if (dispatchChips.length === 0) continue;
      const attachedHere: ReplaySubagent[] = [];
      for (const chip of dispatchChips) {
        let prompt = "";
        try { prompt = (JSON.parse(chip.args ?? "{}") as { prompt?: string }).prompt ?? ""; } catch { /* ignore */ }
        // Prefer an exact/prefix prompt match; else take the earliest remaining.
        let idx = prompt ? remaining.findIndex((b) => b.instruction && (b.instruction === prompt.trim() || b.instruction.startsWith(prompt.trim().slice(0, 80)))) : -1;
        if (idx === -1) idx = remaining.length > 0 ? 0 : -1;
        if (idx !== -1 && remaining[idx]) { attachedHere.push(remaining[idx].sub); attachedSubs.push(remaining[idx].sub); remaining.splice(idx, 1); }
      }
      // Hide the dispatch chips on this host — the blocks are their UI.
      m.toolCalls = m.toolCalls.filter((tc) => tc.tool !== "subagent");
      if (m.toolCalls.length === 0) m.toolCalls = undefined;
      const host = m as ReplayMessage & { subagents?: ReplaySubagent[] };
      host.subagents = [...(host.subagents ?? []), ...attachedHere];
    }
    // Leftover children with no matching dispatch in the visible transcript are
    // orphans (compacted-away turns / stale pre-purge runs) — do NOT attach them.
  }
  const subagents = attachedSubs;

  return { messages, subagents };
}
