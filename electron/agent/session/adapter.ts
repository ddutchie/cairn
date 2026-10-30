/**
 * AgentEvent → the renderer's existing `session:event` / `session:projection`
 * contract. The renderer folds dsh-shaped events (shared/agent/session-event-fold.ts),
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

export function createAdapter(sessionId: string, now: () => number = Date.now) {
  let seq = 0;
  const args = new Map<string, Record<string, unknown>>();
  const ev = (type: string, data: unknown): RendererEvent => ({ type, seq: ++seq, time: now(), data });

  return (event: AgentEvent): Adapted => {
    const events: RendererEvent[] = [];
    const projections: SessionProjection[] = [];
    switch (event.type) {
      case "turn/start": events.push(ev("turn/start", {})); break;
      case "assistant/delta": events.push(ev("assistant/chunk", { chunk: { type: "text-delta", text: event.text } })); break;
      case "assistant/thinking": events.push(ev("assistant/chunk", { chunk: { type: "reasoning-delta", text: event.text } })); break;
      case "assistant/message": {
        const { message } = event;
        const content = message.content.flatMap((p) =>
          p.type === "text" ? [{ type: "text", text: p.text }]
          : p.type === "thinking" ? [{ type: "reasoning", text: p.thinking }]
          : []);
        const u = message.usage;
        events.push(ev("assistant/message", {
          message: { role: "assistant", content },
          // The fold expects dsh's disjoint input (uncached only); pi-ai's `input` is that too.
          usage: u && { inputTokens: u.input, outputTokens: u.output, reasoningTokens: u.reasoning ?? 0, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, costUsd: u.cost?.total },
        }));
        break;
      }
      case "tool/call":
        args.set(event.callId, event.args);
        events.push(ev("tool/call", { callId: event.callId, name: event.name, args: event.args, meta: { risk: event.risk } }));
        break;
      case "tool/result": {
        const cairnRef = event.isError ? undefined : extractCairnRef(event.name, event.text);
        events.push(ev("tool/result", {
          callId: event.callId, name: event.name, args: args.get(event.callId),
          ...(event.isError ? { error: event.text, ok: false } : { output: event.text, ok: true }),
          ...(cairnRef ? { meta: { cairnRef } } : {}),
        }));
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
      case "turn/end": events.push(ev("turn/end", { reason: { kind: event.reason } })); break;
      // Recorded in the log; the UI learns of them via approval/permissions projections.
      case "approval/decided":
        // Clears the card on every transport, whoever (or whatever) decided.
        projections.push(makeSessionProjection(sessionId, "approval", { sessionId, status: "resolved", callId: event.callId, approved: event.approved, by: event.by }));
        break;
      case "session/title":
        projections.push(makeSessionProjection(sessionId, "title", { title: event.title }));
        break;
      case "user/message": case "rule/added": break;
    }
    return { events, projections };
  };
}
