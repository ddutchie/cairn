/**
 * runTurn(): the one agent loop. An async generator over AgentEvent — callers
 * persist and render the events; the loop owns model streaming, tool-call
 * validation, the permission pipeline (policy → reviewer → human), execution
 * and history. See docs/plans/agent-engine-design.md §1.
 *
 * Invariants:
 *  - every tool call gets exactly one tool result, however it ends (denied,
 *    invalid, blocked, aborted, crashed), so history is always valid to replay
 *  - `tool/call` is emitted before any side effect it describes
 *  - an approval is registered with the Gate before `approval/asked` is
 *    emitted, so a transport answering instantly cannot race the waiter
 */
import {
  validateToolCall,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type JsonObject,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentEvent, DecisionSource } from "./events";
import { Gate, type AskInput } from "./gate";
import { callSignature, decide, type Decision, type Mode } from "./policy";
import { repairInterrupted } from "./repair";
import { createReviewerState, recordVerdict, type Reviewer, type ReviewerState } from "./reviewer";
import { grantRule, offeredGrants, type GrantKind, type RiskInfo, type RuleStore } from "./rules";
import type { AgentTool, ToolOutput } from "./tools";

export type StreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface Profile {
  id: string;
  /** False for automation/heartbeat: an `ask` becomes a deny instead of waiting. */
  interactive: boolean;
  mode: Mode;
  deniedTools?: readonly string[];
}

export interface TurnOptions {
  sessionId: string;
  model: Model<Api>;
  streamFn: StreamFn;
  systemPrompt?: string;
  /** Provider messages so far. The loop appends to it as the turn progresses. */
  history: Message[];
  input: string;
  tools: readonly AgentTool[];
  profile: Profile;
  rules: RuleStore;
  gate: Gate;
  workspaceRoot: string;
  signal?: AbortSignal;
  maxSteps?: number;
  askTtlMs?: number;
  reviewer?: Reviewer;
  /** Pass the same object every turn of a session to keep the escalation counters. */
  reviewerState?: ReviewerState;
  /** Pass the same set every turn so a doom-loop "allow" is remembered. */
  doomAcked?: Set<string>;
  streamOptions?: Omit<SimpleStreamOptions, "signal">;
}

interface Prepared {
  call: ToolCall;
  tool?: AgentTool;
  args?: JsonObject;
  /** Set when the call will not run; the text becomes its error result. */
  refusal?: string;
}

interface Resolution {
  approved: boolean;
  refusal?: string;
}

const textOf = (out: ToolOutput): string =>
  typeof out.content === "string" ? out.content : out.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");

function resultMessage(call: ToolCall, text: string, isError: boolean, original?: ToolOutput): ToolResultMessage {
  const content = original && typeof original.content !== "string" ? original.content : [{ type: "text" as const, text }];
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, timestamp: Date.now() };
}

export async function* runTurn(o: TurnOptions): AsyncGenerator<AgentEvent> {
  const maxSteps = o.maxSteps ?? 50;
  const toolMap = new Map(o.tools.map((t) => [t.name, t] as const));
  const reviewerState = o.reviewerState ?? createReviewerState();
  const doomAcked = o.doomAcked ?? new Set<string>();
  const recent: string[] = [];

  o.history.splice(0, o.history.length, ...repairInterrupted(o.history));
  yield { type: "turn/start", sessionId: o.sessionId, profile: o.profile.id };
  o.history.push({ role: "user", content: o.input, timestamp: Date.now() } satisfies UserMessage);
  yield { type: "user/message", content: o.input };

  for (let step = 0; step < maxSteps; step++) {
    if (o.signal?.aborted) { yield { type: "turn/end", reason: "aborted" }; return; }

    let final: AssistantMessage;
    try {
      const context: Context = {
        systemPrompt: o.systemPrompt,
        messages: o.history,
        tools: o.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      };
      const stream = o.streamFn(o.model, context, { ...o.streamOptions, signal: o.signal });
      for await (const ev of stream) {
        if (ev.type === "text_delta") yield { type: "assistant/delta", text: ev.delta };
        else if (ev.type === "thinking_delta") yield { type: "assistant/thinking", text: ev.delta };
      }
      final = await stream.result();
    } catch (err) {
      if (o.signal?.aborted) { yield { type: "turn/end", reason: "aborted" }; return; }
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "turn/end", reason: "error" };
      return;
    }

    if (final.stopReason === "aborted") { yield { type: "turn/end", reason: "aborted" }; return; }
    if (final.stopReason === "error") {
      yield { type: "error", message: final.errorMessage ?? "The model request failed" };
      yield { type: "turn/end", reason: "error" };
      return;
    }

    o.history.push(final);
    yield { type: "assistant/message", message: final };

    const calls = final.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (calls.length === 0) { yield { type: "turn/end", reason: "stop" }; return; }

    const results = yield* runToolCalls(o, calls, toolMap, { recent, doomAcked, reviewerState });
    o.history.push(...results);

    if (o.signal?.aborted) { yield { type: "turn/end", reason: "aborted" }; return; }
  }
  yield { type: "turn/end", reason: "max-steps" };
}

interface TurnState {
  recent: string[];
  doomAcked: Set<string>;
  reviewerState: ReviewerState;
}

async function* runToolCalls(
  o: TurnOptions,
  calls: ToolCall[],
  toolMap: Map<string, AgentTool>,
  state: TurnState,
): AsyncGenerator<AgentEvent, ToolResultMessage[]> {
  // Phase 1: gate every call in order (asks are sequential for now).
  const prepared: Prepared[] = [];
  for (const call of calls) prepared.push(yield* prepare(o, call, toolMap, state));

  // Phase 2: run what was approved. Consecutive `parallel` tools overlap.
  const outputs = new Map<string, ToolOutput>();
  const runnable = prepared.filter((p) => !p.refusal && p.tool);
  for (let i = 0; i < runnable.length;) {
    const batch = [runnable[i]];
    if (runnable[i].tool!.concurrency === "parallel") {
      while (i + batch.length < runnable.length && runnable[i + batch.length].tool!.concurrency === "parallel") batch.push(runnable[i + batch.length]);
    }
    i += batch.length;
    await Promise.all(batch.map(async (p) => {
      if (o.signal?.aborted) { outputs.set(p.call.id, { content: "Cancelled before it ran.", isError: true }); return; }
      try {
        outputs.set(p.call.id, await p.tool!.execute(p.args, { sessionId: o.sessionId, callId: p.call.id, signal: o.signal, workspaceRoot: o.workspaceRoot }));
      } catch (err) {
        outputs.set(p.call.id, { content: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
      }
    }));
  }

  // Phase 3: emit results in call order.
  const messages: ToolResultMessage[] = [];
  for (const p of prepared) {
    const out: ToolOutput = p.refusal ? { content: p.refusal, isError: true } : outputs.get(p.call.id) ?? { content: "No result.", isError: true };
    const text = textOf(out);
    const isError = out.isError === true;
    yield { type: "tool/result", callId: p.call.id, name: p.call.name, text, isError };
    messages.push(resultMessage(p.call, text, isError, out));
  }
  return messages;
}

async function* prepare(o: TurnOptions, call: ToolCall, toolMap: Map<string, AgentTool>, state: TurnState): AsyncGenerator<AgentEvent, Prepared> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    yield { type: "tool/call", callId: call.id, name: call.name, args: call.arguments, risk: "EXEC" };
    return { call, refusal: `Unknown tool: ${call.name}` };
  }

  let args: JsonObject;
  try {
    args = validateToolCall(o.tools as AgentTool[], call) as JsonObject;
  } catch (err) {
    yield { type: "tool/call", callId: call.id, name: call.name, args: call.arguments, risk: "EXEC" };
    return { call, tool, refusal: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}` };
  }

  let risk: RiskInfo;
  try { risk = tool.risk(args); } catch { risk = { class: "EXEC" }; }
  yield { type: "tool/call", callId: call.id, name: call.name, args, risk: risk.class };

  const signature = callSignature(call.name, args);
  const decision = decide({ name: call.name, risk }, signature, {
    mode: o.profile.mode,
    deniedTools: o.profile.deniedTools ?? [],
    rules: o.rules.list(),
    workspaceRoot: o.workspaceRoot,
    recent: state.recent,
    doomAcked: state.doomAcked,
  });
  state.recent.push(signature);

  const resolution = yield* resolveDecision(o, { call, tool, args }, risk, signature, decision, state);
  return resolution.approved ? { call, tool, args } : { call, tool, args, refusal: resolution.refusal };
}

async function* resolveDecision(
  o: TurnOptions,
  p: { call: ToolCall; tool: AgentTool; args: JsonObject },
  risk: RiskInfo,
  signature: string,
  decision: Decision,
  state: TurnState,
): AsyncGenerator<AgentEvent, Resolution> {
  const { call, tool, args } = p;
  const decided = (approved: boolean, by: DecisionSource, extra: { reason?: string; ruleId?: string; grant?: GrantKind } = {}): AgentEvent =>
    ({ type: "approval/decided", callId: call.id, approved, by, ...extra });

  if (decision.kind === "allow") {
    yield decided(true, decision.by, { ruleId: decision.ruleId, reason: decision.reason });
    return { approved: true };
  }
  if (decision.kind === "deny") {
    yield decided(false, decision.by, { reason: decision.reason, ruleId: decision.ruleId });
    return { approved: false, refusal: `Denied: ${decision.reason}` };
  }

  let askReason: string;
  let askBy: DecisionSource;
  if (decision.kind === "review") {
    if (!o.reviewer || state.reviewerState.paused) {
      askReason = state.reviewerState.paused ? "Auto mode is paused after repeated blocks" : decision.reason;
      askBy = "mode";
    } else {
      const verdict = await o.reviewer({ sessionId: o.sessionId, callId: call.id, tool: call.name, args, risk, signal: o.signal }).catch(() => undefined);
      if (!verdict) {
        askReason = "The safety reviewer was unavailable";
        askBy = "reviewer";
      } else {
        const pauseReason = recordVerdict(state.reviewerState, verdict.verdict);
        if (pauseReason) yield { type: "auto/paused", reason: pauseReason };
        if (verdict.verdict === "allow") {
          yield decided(true, "reviewer", { reason: verdict.reason });
          return { approved: true };
        }
        if (verdict.verdict === "block") {
          yield decided(false, "reviewer", { reason: verdict.reason });
          return { approved: false, refusal: `Blocked by safety review: ${verdict.reason}. Find a safer approach or ask the user.` };
        }
        askReason = verdict.reason;
        askBy = "reviewer";
      }
    }
  } else {
    askReason = decision.reason;
    askBy = decision.by;
  }

  if (!o.profile.interactive) {
    const reason = `No approver is available: ${askReason}`;
    yield decided(false, "headless", { reason });
    return { approved: false, refusal: `Denied: ${reason}` };
  }

  const input: AskInput = {
    sessionId: o.sessionId,
    callId: call.id,
    tool: call.name,
    risk: risk.class,
    title: call.name,
    preview: tool.preview?.(args) ?? JSON.stringify(args),
    reason: askReason,
    grants: offeredGrants(risk),
  };
  const { ask, outcome } = o.gate.open(input, { signal: o.signal, ttlMs: o.askTtlMs });
  yield { type: "approval/asked", ask };
  const res = await outcome;

  if (res.by !== "human") {
    const reason = res.by === "timeout" ? "The approval request timed out" : "The approval request was cancelled";
    yield decided(false, res.by === "timeout" ? "timeout" : "abort", { reason });
    return { approved: false, refusal: `Denied: ${reason}` };
  }
  if (!res.approved) {
    yield decided(false, "human", { reason: "Denied by the user" });
    return { approved: false, refusal: "The user denied this tool call." };
  }
  if (askBy === "doom") state.doomAcked.add(signature);
  if (res.grant) {
    const rule = grantRule({ name: call.name, risk }, res.grant);
    o.rules.add(rule);
    yield { type: "rule/added", rule };
  }
  yield decided(true, "human", { grant: res.grant });
  return { approved: true };
}
