/** Folds over a record stream: provider history and projections. */
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { Rule } from "../rules";
import type { AskSpec } from "../gate";
import type { TurnEndReason } from "../events";
import { repairInterrupted } from "../repair";
import type { SessionRecord } from "./format";

/** Provider-ready history. Dangling tool calls get a synthesized result. */
export function historyFromRecords(records: readonly SessionRecord[], now?: number): Message[] {
  const messages: Message[] = [];
  for (const { event, time } of records) {
    if (event.type === "user/message") messages.push({ role: "user", content: event.content, timestamp: time });
    else if (event.type === "assistant/message") messages.push(event.message);
    else if (event.type === "tool/result") {
      messages.push({
        role: "toolResult", toolCallId: event.callId, toolName: event.name,
        content: [{ type: "text", text: event.text }], isError: event.isError, timestamp: time,
      });
    }
  }
  return repairInterrupted(messages, now);
}

export interface SessionState {
  turns: number;
  running: boolean;
  lastEnd?: TurnEndReason;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; costUsd: number };
  /** Rules granted during the session (restored into the rule store on reopen). */
  rules: Rule[];
  /** Asks with no decision yet, keyed by callId. */
  pendingAsks: Map<string, AskSpec>;
}

export function initialState(): SessionState {
  return { turns: 0, running: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }, rules: [], pendingAsks: new Map() };
}

function addUsage(acc: SessionState["usage"], u: Usage | undefined): void {
  if (!u) return;
  acc.input += u.input; acc.output += u.output; acc.cacheRead += u.cacheRead; acc.cacheWrite += u.cacheWrite;
  acc.reasoning += u.reasoning ?? 0; acc.costUsd += u.cost?.total ?? 0;
}

export function reduce(state: SessionState, { event }: SessionRecord): SessionState {
  switch (event.type) {
    case "turn/start": state.turns++; state.running = true; break;
    case "turn/end": state.running = false; state.lastEnd = event.reason; state.pendingAsks.clear(); break;
    case "assistant/message": addUsage(state.usage, event.message.usage); break;
    case "rule/added": state.rules.push(event.rule); break;
    case "approval/asked": state.pendingAsks.set(event.ask.callId, event.ask); break;
    case "approval/decided": state.pendingAsks.delete(event.callId); break;
    default: break;
  }
  return state;
}

export function foldState(records: readonly SessionRecord[]): SessionState {
  return records.reduce(reduce, initialState());
}

/** First user message, trimmed, as a fallback title. */
export function deriveTitle(records: readonly SessionRecord[], max = 60): string | undefined {
  for (const { event } of records) {
    if (event.type !== "user/message") continue;
    const line = event.content.trim().split("\n")[0] ?? "";
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return undefined;
}
