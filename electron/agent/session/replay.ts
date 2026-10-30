/** Log → the transcript shape `db:session:messages` returns (one bubble per user message / assistant turn). */
import type { LoadSessionMessagesResult, ReplayMessage, ReplayToolCall, SessionUsageMetrics } from "../../../shared/agent/session-wire";
import { foldState } from "./history";
import type { SessionRecord } from "./format";

export function replayFromRecords(records: readonly SessionRecord[], title?: string | null, contextWindow?: number): LoadSessionMessagesResult {
  const messages: ReplayMessage[] = [];
  let bubble: ReplayMessage | undefined;
  const calls = new Map<string, ReplayToolCall>();
  let n = 0;

  const open = (): ReplayMessage => {
    if (!bubble) { bubble = { id: `a${++n}`, role: "assistant", content: "" }; messages.push(bubble); }
    return bubble;
  };

  for (const { event } of records) {
    switch (event.type) {
      case "turn/start": bubble = undefined; break;
      case "user/message": messages.push({ id: `u${++n}`, role: "user", content: event.content }); bubble = undefined; break;
      case "assistant/message": {
        const b = open();
        for (const part of event.message.content) {
          if (part.type === "text") b.content += part.text;
          else if (part.type === "thinking") b.reasoning = (b.reasoning ?? "") + part.thinking;
        }
        break;
      }
      case "tool/call": {
        const call: ReplayToolCall = { tool: event.name, label: event.name, callId: event.callId, args: JSON.stringify(event.args) };
        calls.set(event.callId, call);
        (open().toolCalls ??= []).push(call);
        break;
      }
      case "tool/result": {
        const call = calls.get(event.callId);
        if (call) {
          if (event.isError) { call.ok = false; call.error = event.text; } else { call.ok = true; call.output = event.text; }
        }
        break;
      }
      default: break;
    }
  }

  const s = foldState(records);
  const usage: SessionUsageMetrics = {
    promptTokens: s.usage.input + s.usage.cacheRead + s.usage.cacheWrite,
    completionTokens: s.usage.output,
    reasoningTokens: s.usage.reasoning,
    cacheReadTokens: s.usage.cacheRead,
    cacheCreationTokens: s.usage.cacheWrite,
    costUsd: s.usage.costUsd || undefined,
    contextWindow,
  };
  return { messages, subagents: [], usage, title: title ?? null };
}
