import { readToolResult } from "../tool-result-message";
import type { Context } from "@deepseek-ai/cordis";
import { onAssistantStream } from "../assistant-stream-frames";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import "../ctx-augment";
import { contextPressureTokens } from "../../../shared/agent/context-pressure";
import { eventText, eventReasoning } from "./session";
import { toolCallTitle, sendProjection } from "./shared";

// ── cairn-subagent ───────────────────────────────────────────────────────────
export interface CairnSubagentConfig {
  /** Emit a Cairn IPC event (threadId already tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  sessionId: string;
}

/**
 * Map dsh subagent children (sessions with header.origin === 'subagent') onto
 * Cairn's shared `session:subagent*` IPC vocabulary so the renderer's live subagent
 * traces work over the dsh engine. dsh subagents are general child agents with
 * their own session logs; the role label is the child's delegation label.
 */
export function cairnSubagentPlugin(ctx: Context, config: CairnSubagentConfig): void {
  const { send, sessionId } = config;
  const started = new Set<string>();
  const callName = new Map<string, string>();
  // Track whether a child streamed text / reasoning as deltas, so the final
  // assistant/message doesn't re-emit the same content (which duplicated the
  // brief) and so a reasoning block never lands in the token stream (the brief).
  const streamedText = new Set<string>();
  const streamedReasoning = new Set<string>();

  // Live child deltas (dsh ≥0.1.5): `assistant/chunk` session events no
  // longer exist — deltas arrive as `agent/assistant-stream` dispatch frames.
  // Same session scoping as the event bridge below (children of this mount's
  // session only); keeps streamedText/Reasoning current so the final
  // assistant/message gap-fill doesn't duplicate the brief.
  onAssistantStream(
    ctx,
    (_id, header) =>
      header?.origin === "subagent" &&
      (header?.parentSession == null || String(header.parentSession) === sessionId),
    {
      onText: (text, info) => {
        const childId = String(info.agentSessionId);
        const parentSession =
          info.header?.parentSession != null ? String(info.header.parentSession) : undefined;
        streamedText.add(childId);
        sendProjection(send, sessionId, "subagent-trace", { trace: "token", childId, parentSession, delta: text });
      },
      onReasoning: (text, info) => {
        const childId = String(info.agentSessionId);
        const parentSession =
          info.header?.parentSession != null ? String(info.header.parentSession) : undefined;
        streamedReasoning.add(childId);
        sendProjection(send, sessionId, "subagent-trace", { trace: "thought", childId, parentSession, delta: text });
      },
    },
  );

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    const header = (session as { header?: { origin?: string; parentSession?: unknown } }).header;
    const isChild = header?.origin === "subagent";
    if (!isChild) return;

    const childId = String(session.id);
    // Parent session id (the calling chat thread OR coding-agent session).
    // Included in every emitted event so the renderer can filter events for
    // the pane it drives — historically this was omitted, and AgentChatPane
    // fell back to a `${sessionId}:sub:` prefix scheme that nothing emitted,
    // making every coding-agent subagent trace unreachable at runtime.
    const parentSession = header?.parentSession != null ? String(header.parentSession) : undefined;

    // Filter at the SOURCE: this plugin is mounted per-turn on the SHARED
    // singleton context, so without this guard every concurrently-running
    // thread's plugin instance would see (and re-emit) every child's events —
    // O(threads × children) redundant IPC, correctness resting solely on the
    // renderer's downstream `parentSession === sessionId` guard. Emit only for
    // children of the session this instance drives. (dsh's own rule: enforce a
    // decision in the operation that makes it.)
    if (parentSession !== undefined && parentSession !== sessionId) return;

    // New turns stream fresh deltas — without this reset, a continuable
    // child's second turn would be skipped as "already streamed".
    if (event.type === "turn/start") {
      streamedText.delete(childId);
      streamedReasoning.delete(childId);
      return;
    }

    if (event.type === "user/message") {
      // The child's first non-snapshot user/message is the delegated prompt.
      // Skip the runtime-context snapshot (form:snapshot) so the instruction is
      // the actual task, not "Current runtime context…". Use eventText (handles
      // both data.message.content and data.content shapes) — the previous inline
      // read of data.message.content returned undefined for the append-surface
      // shape, so the instruction fell back to "subagent".
      const src = (event.data as { message?: { source?: { kind?: string; form?: string } }; source?: { kind?: string; form?: string } }).message?.source
        ?? (event.data as { source?: { kind?: string; form?: string } }).source;
      if (src?.form === "snapshot") return;
      if (!started.has(childId)) {
        started.add(childId);
        const full = eventText(event).trim();
        const instruction = full || "subagent";
        const role = full ? full.slice(0, 60) : "subagent";
         sendProjection(send, sessionId, "subagent-trace", { trace: "status", status: "start", childId, parentSession, role, instruction });
      } else {
        // Any later non-snapshot user/message is a follow-up turn: model
        // send_message (source kind "agent-message", either direction) or a
        // host→child prompt via the message action (source kind "user").
        // Surface it in the trace brief so the transcript shows the
        // conversation, not just the delegation endpoints. The durable source
        // is preserved on the logged event; only the text is projected.
        const text = eventText(event).trim();
        if (text) sendProjection(send, sessionId, "subagent-trace", { trace: "token", childId, parentSession, delta: `\n\n${text}` });
      }
      return;
    }

    if (event.type === "tool/call") {
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
       sendProjection(send, sessionId, "subagent-trace", { trace: "tool-call", childId, parentSession, tool: d.name, label: toolCallTitle(d.name, d.arguments), callId: d.callId, args });
      return;
    }

    if (event.type === "tool/result") {
      const result = readToolResult((event.data as { message?: unknown }).message);
      const callId = result?.callId;
      const isError = result?.isError === true;
      const output = result?.output ?? "";
      const tool = callId ? (callName.get(callId) ?? "tool") : "tool";
       sendProjection(send, sessionId, "subagent-trace", { trace: "tool-done",
        childId, parentSession, tool, callId,
        ok: !isError, error: isError ? (output || "tool error") : undefined,
        output: isError ? undefined : output,
      });
      return;
    }

    if (event.type === "assistant/message") {
      const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }).usage;
      if (usage) {
         sendProjection(send, sessionId, "subagent-trace", { trace: "usage",
          childId, parentSession,
          promptTokens: contextPressureTokens(usage),
          completionTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
        });
      }
      // Fill gaps ONLY: if deltas already streamed the text/reasoning, don't
      // re-emit (that duplicated the brief). Text goes to the token stream (the
      // brief); the reasoning block goes to the thought stream — never mix them,
      // or chain-of-thought leaks into the FINDINGS BRIEF.
      if (!streamedText.has(childId)) {
        const text = eventText(event);
          if (text) sendProjection(send, sessionId, "subagent-trace", { trace: "token", childId, parentSession, delta: text });
      }
      if (!streamedReasoning.has(childId)) {
        const { reasoning } = eventReasoning(event);
          if (reasoning) sendProjection(send, sessionId, "subagent-trace", { trace: "thought", childId, parentSession, delta: reasoning });
      }
      return;
    }

    if (event.type === "turn/end") {
      const reason = (event.data as { reason?: { kind?: string } }).reason;
      const result = reason?.kind === "completed" ? "" : ` (${reason?.kind ?? "error"})`;
       sendProjection(send, sessionId, "subagent-trace", { trace: "status", status: "done", childId, parentSession, result, error: reason?.kind === "completed" ? undefined : reason?.kind });
      return;
    }
  });
}
