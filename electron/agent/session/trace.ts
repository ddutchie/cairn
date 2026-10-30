/**
 * A subagent's events as the parent's UI expects them: `subagent-trace`
 * projections under the parent session, plus approvals (children ask through
 * their parent so the human answers in one place).
 */
import { makeSessionProjection, type SessionProjection } from "../../../shared/agent/session-projection";
import type { AgentEvent } from "../events";
import type { Adapted } from "./adapter";

const oneLine = (text: string, max = 60) => text.trim().replace(/\s+/g, " ").slice(0, max);

export function createTraceAdapter(parentId: string, childId: string) {
  let started = false;
  const trace = (data: Record<string, unknown>): SessionProjection =>
    makeSessionProjection(parentId, "subagent-trace", { childId, parentSession: parentId, ...data });
  const names = new Map<string, string>();

  return (event: AgentEvent): Adapted => {
    const projections: SessionProjection[] = [];
    switch (event.type) {
      case "user/message":
        if (!started) {
          started = true;
          projections.push(trace({ trace: "status", status: "start", role: oneLine(event.content), instruction: event.content }));
        } else if (event.content.trim()) {
          projections.push(trace({ trace: "token", delta: `\n\n${event.content.trim()}` }));
        }
        break;
      case "assistant/delta": projections.push(trace({ trace: "token", delta: event.text })); break;
      case "assistant/thinking": projections.push(trace({ trace: "thought", delta: event.text })); break;
      case "assistant/message": {
        const u = event.message.usage;
        if (u) projections.push(trace({ trace: "usage", promptTokens: u.input + u.cacheRead + u.cacheWrite, completionTokens: u.output, reasoningTokens: u.reasoning ?? 0 }));
        break;
      }
      case "tool/call":
        names.set(event.callId, event.name);
        projections.push(trace({ trace: "tool-call", tool: event.name, label: event.name, callId: event.callId, args: event.args }));
        break;
      case "tool/result":
        projections.push(trace({
          trace: "tool-done", tool: names.get(event.callId) ?? event.name, callId: event.callId, ok: !event.isError,
          ...(event.isError ? { error: event.text || "tool error" } : { output: event.text }),
        }));
        break;
      case "approval/asked": {
        const a = event.ask;
        projections.push(makeSessionProjection(parentId, "approval", {
          sessionId: parentId, status: "required", callId: a.callId, nonce: a.nonce, name: a.tool, label: `Subagent: ${a.title}`, preview: a.preview,
          reason: a.reason, risk: a.risk, grants: a.grants, expiresAt: a.expiresAt,
        }));
        break;
      }
      case "approval/decided":
        projections.push(makeSessionProjection(parentId, "approval", { sessionId: parentId, status: "resolved", callId: event.callId, approved: event.approved, by: event.by }));
        break;
      case "turn/end":
        projections.push(trace({ trace: "status", status: "done", result: event.reason === "stop" ? "" : ` (${event.reason})`, ...(event.reason === "stop" ? {} : { error: event.reason }) }));
        break;
      default: break;
    }
    return { events: [], projections };
  };
}
