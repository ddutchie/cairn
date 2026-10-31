/**
 * AgentEvent → the renderer's existing `session:event` / `session:projection`
 * contract. The renderer folds engine-shaped events (shared/agent/session-event-fold.ts),
 * so we emit that shape rather than changing the UI. Stateful only for the
 * per-session `seq` and the tool-call args needed to enrich results.
 */
import { extractCairnRef } from "../../../shared/agent/cairn-ref";
import type { AgentEvent } from "../events";
import { makeSessionProjection, type SessionProjection } from "../../../shared/agent/session-projection";
import type { SessionEventEnvelope } from "../../../shared/agent/session-event";

export type RendererEvent = SessionEventEnvelope["event"];

export interface Adapted {
  events: RendererEvent[];
  projections: SessionProjection[];
}

export function createAdapter(sessionId: string, now: () => number = Date.now, readNote?: (noteId: string) => string | undefined) {
  let seq = 0;
  const args = new Map<string, Record<string, unknown>>();
  const ev = (type: string, data: unknown): RendererEvent => ({ type, seq: ++seq, time: now(), data });

  // Per-turn throughput from the live stream: TTFT of the turn's first stream, decode time from each
  // stream's first token to its message, and provider-reported output tokens summed over streams.
  let streamStart: number | null = null;
  let firstToken: number | null = null;
  let ttftMs: number | undefined;
  let decodeMs = 0;
  let outputTokens = 0;
  let sampled = false;
  const resetStats = () => { streamStart = null; firstToken = null; ttftMs = undefined; decodeMs = 0; outputTokens = 0; sampled = false; };
  const delta = () => {
    if (firstToken !== null) return;
    firstToken = now();
    if (ttftMs === undefined && streamStart !== null) ttftMs = Math.max(0, firstToken - streamStart);
  };
  const statsChunk = (): RendererEvent | undefined => {
    const stats: { ttftMs?: number; tokensPerSecond?: number; outputTokens?: number } = {};
    if (ttftMs !== undefined) stats.ttftMs = ttftMs;
    if (sampled && decodeMs > 0) stats.tokensPerSecond = outputTokens / (decodeMs / 1000);
    if (outputTokens > 0) stats.outputTokens = outputTokens;
    return Object.keys(stats).length ? ev("assistant/chunk", { chunk: { type: "stats", stats } }) : undefined;
  };

  return (event: AgentEvent): Adapted => {
    const events: RendererEvent[] = [];
    const projections: SessionProjection[] = [];
    switch (event.type) {
      case "turn/start": resetStats(); streamStart = now(); events.push(ev("turn/start", {})); break;
      case "assistant/delta": delta(); events.push(ev("assistant/chunk", { chunk: { type: "text-delta", text: event.text } })); break;
      case "assistant/thinking": delta(); events.push(ev("assistant/chunk", { chunk: { type: "reasoning-delta", text: event.text } })); break;
      case "assistant/message": {
        const { message } = event;
        const content = message.content.flatMap((p) =>
          p.type === "text" ? [{ type: "text", text: p.text }]
          : p.type === "thinking" ? [{ type: "reasoning", text: p.thinking }]
          : []);
        const u = message.usage;
        if (u && u.output > 0) {
          outputTokens += u.output;
          if (firstToken !== null) { decodeMs += Math.max(0, now() - firstToken); sampled = true; }
        }
        firstToken = null;
        events.push(ev("assistant/message", {
          message: { role: "assistant", content },
          // The fold expects engine's disjoint input (uncached only); pi-ai's `input` is that too.
          usage: u && { inputTokens: u.input, outputTokens: u.output, reasoningTokens: u.reasoning ?? 0, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, costUsd: u.cost?.total },
        }));
        break;
      }
      case "tool/call":
        args.set(event.callId, event.args);
        events.push(ev("tool/call", { callId: event.callId, name: event.name, args: event.args, meta: { risk: event.risk } }));
        break;
      case "tool/result": {
        streamStart = now(); // the next model request starts once the tools are back
        const cairnRef = event.isError ? undefined : extractCairnRef(event.name, event.text);
        events.push(ev("tool/result", {
          callId: event.callId, name: event.name, args: args.get(event.callId),
          ...(event.isError ? { error: event.text, ok: false } : { output: event.text, ok: true }),
          ...(cairnRef ? { meta: { cairnRef } } : {}),
        }));
        // After a note write, push fresh content so a plan's task list updates live.
        if (readNote && !event.isError && (event.name === "ensure_note" || event.name === "edit_note")) {
          try {
            const id = (JSON.parse(event.text) as { id?: unknown }).id;
            const content = typeof id === "string" ? readNote(id) : undefined;
            if (typeof id === "string" && content !== undefined) projections.push(makeSessionProjection(sessionId, "note-updated", { noteId: id, content }));
          } catch { /* non-JSON output */ }
        }
        args.delete(event.callId);
        break;
      }
      case "approval/asked": {
        const a = event.ask;
        projections.push(makeSessionProjection(sessionId, "approval", {
          sessionId, status: "required", callId: a.callId, nonce: a.nonce, name: a.tool, label: a.title, preview: a.preview,
          reason: a.reason, risk: a.risk, grants: a.grants, expiresAt: a.expiresAt,
        }));
        break;
      }
      case "retry":
        projections.push(makeSessionProjection(sessionId, "retry", { attempt: event.attempt, maxRetries: event.maxAttempts, delayMs: event.delayMs, error: event.error }));
        break;
      case "context/overflow":
        projections.push(makeSessionProjection(sessionId, "compact", { status: "start", auto: true }));
        break;
      case "compaction":
        projections.push(makeSessionProjection(sessionId, "compact-result", { messageCount: event.keepCount, summary: event.summary }));
        projections.push(makeSessionProjection(sessionId, "compact", { status: "end", auto: event.trigger !== "manual" }));
        break;
      case "auto/paused":
        projections.push(makeSessionProjection(sessionId, "error", { message: event.reason, code: "auto-paused" }));
        break;
      case "error":
        projections.push(makeSessionProjection(sessionId, "error", { message: event.message }));
        break;
      case "turn/end": {
        const st = statsChunk();
        if (st) events.push(st);
        events.push(ev("turn/end", { reason: { kind: event.reason } }));
        break;
      }
      // Recorded in the log; the UI learns of them via approval/permissions projections.
      case "approval/decided":
        // Clears the card on every transport, whoever (or whatever) decided.
        projections.push(makeSessionProjection(sessionId, "approval", { sessionId, status: "resolved", callId: event.callId, approved: event.approved, by: event.by }));
        break;
      case "session/title":
        projections.push(makeSessionProjection(sessionId, "title", { title: event.title }));
        break;
      case "goal/changed": {
        const g = event.goal;
        projections.push(makeSessionProjection(sessionId, "goal", {
          operation: event.operation,
          goal: g ? { ...g, blockedReason: g.blockedReason ? { code: "blocked", message: g.blockedReason } : undefined } : null,
        }));
        break;
      }
      case "user/message": case "rule/added": case "schedule/changed": break;
    }
    return { events, projections };
  };
}
