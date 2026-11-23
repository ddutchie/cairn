/** Folds over a record stream: provider history and projections. */
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { Rule } from "../rules";
import type { AskSpec } from "../gate";
import type { GoalState, ScheduleEntry, TurnEndReason } from "../events";
import { buildContextView } from "../context";
import type { SessionRecord } from "./format";

/** Provider-ready history (compactions applied; dangling tool calls repaired). */
export function historyFromRecords(records: readonly SessionRecord[], now?: number): Message[] {
  return buildContextView(records, now);
}

export interface SessionState {
  turns: number;
  compactions: number;
  running: boolean;
  lastEnd?: TurnEndReason;
  /** Totals across every model request in the session (cost, spend); NOT the context size. */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; costUsd: number };
  /** The most recent request's usage: its prompt side is the current context size. */
  lastUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  /** Rules granted during the session (restored into the rule store on reopen). */
  rules: Rule[];
  /** Asks with no decision yet, keyed by callId. */
  pendingAsks: Map<string, AskSpec>;
}

export function initialState(): SessionState {
  return { turns: 0, compactions: 0, running: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }, rules: [], pendingAsks: new Map() };
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
    case "assistant/message": {
      const u = event.message.usage;
      addUsage(state.usage, u);
      // A request that reported nothing (a stub or an empty reply) says nothing about the context size.
      if (u && u.input + u.output + u.cacheRead + u.cacheWrite > 0) state.lastUsage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning ?? 0 };
      break;
    }
    case "compaction": state.compactions++; break;
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

/** The title a person set, if any (a rename; records without a source predate auto titles and count as one). */
export function userTitle(records: readonly SessionRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i].event;
    if (e.type === "session/title" && e.source !== "auto") return e.title;
  }
  return undefined;
}

/** Whether any title, set by a person or by the model, has been recorded. */
export function hasTitle(records: readonly SessionRecord[]): boolean {
  return records.some((r) => r.event.type === "session/title");
}

/** What naming a session needs: the first messages a person typed, the first reply, and the titles so far. */
export interface TitleInputs {
  /** Prompts a person typed, oldest first (goal rounds, reminders and blocked prompts left out). */
  humanMessages: string[];
  /** The text of the first assistant message. */
  firstReply?: string;
  /** Auto titles recorded so far. */
  autoTitles: number;
  /** A title a person set (rename). */
  userTitle?: string;
}

export function titleInputs(records: readonly SessionRecord[]): TitleInputs {
  const humanMessages: string[] = [];
  let firstReply: string | undefined;
  let autoTitles = 0;
  for (const { event } of records) {
    if (event.type === "user/message" && !event.blocked && !event.synthetic && !event.agentAuthored && event.content.trim()) humanMessages.push(event.content);
    else if (event.type === "assistant/message" && firstReply === undefined) {
      const text = event.message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (text) firstReply = text;
    } else if (event.type === "session/title" && event.source === "auto") autoTitles++;
  }
  return { humanMessages, firstReply, autoTitles, userTitle: userTitle(records) };
}

/** The latest title a person set, else the latest auto title, else the first user message, trimmed. */
export function deriveTitle(records: readonly SessionRecord[], max = 60): string | undefined {
  const pinned = userTitle(records);
  if (pinned) return pinned;
  for (let i = records.length - 1; i >= 0; i--) {
    const e = records[i].event;
    if (e.type === "session/title") return e.title;
  }
  for (const { event } of records) {
    if (event.type !== "user/message" || event.blocked) continue;
    const line = event.content.trim().split("\n")[0] ?? "";
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return undefined;
}

/** The current goal: the last `goal/changed` wins, and a clear leaves none. */
export function foldGoal(records: readonly SessionRecord[]): GoalState | null {
  let goal: GoalState | null = null;
  for (const { event } of records) if (event.type === "goal/changed") goal = event.goal;
  return goal;
}

/** Reminders that were added and have neither fired nor been cancelled. */
export function foldSchedules(records: readonly SessionRecord[]): ScheduleEntry[] {
  const open = new Map<string, ScheduleEntry>();
  for (const { event } of records) {
    if (event.type !== "schedule/changed") continue;
    if (event.operation === "add") open.set(event.schedule.id, event.schedule);
    else open.delete(event.schedule.id);
  }
  return [...open.values()];
}
