/** Log → the transcript shape `db:session:messages` returns (one bubble per user message / assistant turn). */
import { extractCairnRef } from "../../../shared/agent/cairn-ref";
import type { ContextRingState, LoadSessionMessagesResult, ReplayMessage, ReplaySubagent, ReplayToolCall, SessionTodoItem, SessionUsageMetrics } from "../../../shared/agent/session-wire";
import { foldState } from "./history";
import type { SessionRecord } from "./format";

/** Whose thinking is in the context: per `provider::model`, how many turns and reasoning blocks it contributed. */
function foldContextRing(records: readonly SessionRecord[]): ContextRingState | undefined {
  const byModel: ContextRingState["byModel"] = {};
  let currentModel: string | null = null;
  for (const { event } of records) {
    if (event.type !== "assistant/message") continue;
    const key = `${event.message.provider}::${event.message.model}`;
    const entry = (byModel[key] ??= { turns: 0, reasoningBlocks: 0, reasoningChars: 0, replayedBlocks: 0, degradedBlocks: 0 });
    entry.turns++;
    for (const part of event.message.content) {
      if (part.type !== "thinking") continue;
      entry.reasoningBlocks++;
      entry.reasoningChars += part.thinking.length;
    }
    currentModel = key;
  }
  return currentModel ? { currentModel, byModel } : undefined;
}

/** The latest `todo_write` list, in the shape the todos panel reads. */
function foldTodos(records: readonly SessionRecord[]): SessionTodoItem[] | undefined {
  let todos: SessionTodoItem[] | undefined;
  for (const { event } of records) {
    if (event.type !== "tool/call" || event.name !== "todo_write") continue;
    const list = (event.args as { todos?: Array<{ content?: string; status?: SessionTodoItem["status"] }> }).todos;
    if (Array.isArray(list)) todos = list.map((t, i) => ({ id: String(i + 1), title: t.content ?? "", status: t.status ?? "pending" }));
  }
  return todos;
}

/** A subagent's log as the trace block the transcript shows. */
function toSubagent(id: string, records: readonly SessionRecord[]): ReplaySubagent | undefined {
  const { messages } = replayFromRecords(records);
  const instruction = messages.find((m) => m.role === "user")?.content;
  if (instruction === undefined) return undefined;
  const assistant = messages.filter((m) => m.role === "assistant");
  const content = assistant.map((m) => m.content).filter(Boolean).join("\n\n");
  const reasoning = assistant.map((m) => m.reasoning).filter(Boolean).join("\n\n");
  const toolCalls = assistant.flatMap((m) => m.toolCalls ?? []);
  return {
    childId: id, role: instruction.trim().replace(/\s+/g, " ").slice(0, 60), instruction, content,
    ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { toolCalls } : {}),
    running: false, result: assistant.at(-1)?.content || undefined,
  };
}

const DISPATCH_TOOLS = new Set(["subagent", "delegate"]);

/** Hang each child on the assistant bubble that dispatched it, matching by prompt and falling back to order. */
function attachSubagents(messages: ReplayMessage[], children: ReadonlyArray<{ id: string; records: readonly SessionRecord[] }>): ReplaySubagent[] {
  const remaining = children.flatMap((c) => { const sub = toSubagent(c.id, c.records); return sub ? [sub] : []; });
  const attached: ReplaySubagent[] = [];
  for (const m of messages) {
    const chips = m.toolCalls?.filter((tc) => DISPATCH_TOOLS.has(tc.tool)) ?? [];
    if (m.role !== "assistant" || !chips.length) continue;
    const here: ReplaySubagent[] = [];
    for (const chip of chips) {
      let prompt = "";
      try { prompt = (JSON.parse(chip.args ?? "{}") as { prompt?: string }).prompt?.trim() ?? ""; } catch { /* use order */ }
      let i = prompt ? remaining.findIndex((r) => r.instruction.trim().endsWith(prompt) || r.instruction.trim().startsWith(prompt.slice(0, 80))) : -1;
      if (i < 0) i = remaining.length ? 0 : -1;
      if (i >= 0) { const [sub] = remaining.splice(i, 1); here.push(sub); attached.push(sub); }
    }
    // The block replaces the dispatch chips.
    m.toolCalls = m.toolCalls!.filter((tc) => !DISPATCH_TOOLS.has(tc.tool));
    if (!m.toolCalls.length) m.toolCalls = undefined;
    (m as ReplayMessage & { subagents?: ReplaySubagent[] }).subagents = here;
  }
  return attached;
}

export function replayFromRecords(
  records: readonly SessionRecord[],
  title?: string | null,
  contextWindow?: number,
  children: ReadonlyArray<{ id: string; records: readonly SessionRecord[] }> = [],
): LoadSessionMessagesResult {
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
          if (event.isError) { call.ok = false; call.error = event.text; } else {
            call.ok = true; call.output = event.text;
            const ref = extractCairnRef(event.name, event.text);
            if (ref) call.cairnRef = ref;
          }
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
  const subagents = attachSubagents(messages, children);
  return { messages, subagents, usage, contextRing: foldContextRing(records), todos: foldTodos(records), title: title ?? null };
}
