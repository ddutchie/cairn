/**
 * Cairn — Subagent chat variant (experimental)
 *
 * A dispatch → research + write architecture for the in-app chat, built to be
 * benchmarked against the single-agent `runToolLoop` (electron/lib/chat-loop.ts).
 *
 *   Dispatch agent  — thin orchestrator. Tools: research, write. Delegates.
 *   Research agent  — READ-ONLY tool subset. Returns a compact findings brief.
 *   Writing agent   — WRITE tool subset. Receives the brief, performs mutations.
 *
 * Each subagent runs the shared `runToolLoop` with a `toolsOverride` restricting
 * the advertised tool array (fewer prompt tokens/turn) and a fresh message
 * history (context isolation). Only the subagent's final message returns to the
 * dispatcher, keeping the parent context lean — the same principle the Pi coding
 * agent's spawn_subagent uses.
 *
 * This module is NOT wired into production IPC. It exists so the benchmark
 * harness can drive a faithful subagent variant using the real tool executor.
 */

import type { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import type { OpenAIMessage } from "./llm";
import { TOOLS, type ChatRequest } from "./tools";
import { runToolLoop, type RunToolLoopResult } from "./chat-loop";

/** Loosely-typed OpenAI function tool — the synthetic dispatch tools ("research",
 *  "write") aren't in the schema-derived `typeof TOOLS` union, so we widen. */
type ChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

// ── Tool partitioning ─────────────────────────────────────────────────────────

/** Read-only tools the research subagent is allowed to advertise. */
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_active_context",
  "get_project_context_pack",
  "get_note",
  "get_task",
  "search_notes",
  "search_notes_semantic",
  "search_tasks",
  "search_tasks_semantic",
  "list_ready_tasks",
  "list_overdue_tasks",
  "list_tasks_due",
  "list_folders",
  "list_templates",
  "get_knowledge_graph",
  "get_neighbors",
  "get_semantic_neighbors",
  "get_idea_flow",
]);

/** Write tools the writing subagent is allowed to advertise. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_active_context",
  "get_note",
  "ensure_note",
  "append_to_note",
  "patch_note",
  "rename_note",
  "bulk_move_notes",
  "create_task",
  "update_task",
  "bulk_update_task_status",
  "create_tag",
  "tag_note",
  "tag_task",
  "link_note_to_task",
  "unlink_note_from_task",
  "instantiate_template",
  "suggest_connections",
  "create_idea_flow_node",
  "create_idea_flow_edge",
]);

/**
 * STRICT write set — mutation-only, NO read tools. Used to test the "pure write
 * access" failure mode: on a failed patch the writer cannot get_note/search to
 * self-correct, so the failure must escalate to the dispatcher (ping-pong).
 */
export const WRITE_TOOL_NAMES_STRICT: ReadonlySet<string> = new Set([
  "get_active_context",
  "ensure_note",
  "append_to_note",
  "patch_note",
  "rename_note",
  "bulk_move_notes",
  "create_task",
  "update_task",
  "bulk_update_task_status",
  "create_tag",
  "tag_note",
  "tag_task",
  "link_note_to_task",
  "unlink_note_from_task",
  "instantiate_template",
  "suggest_connections",
  "create_idea_flow_node",
  "create_idea_flow_edge",
]);

function filterTools(allowed: ReadonlySet<string>): ChatTool[] {
  return (TOOLS as unknown as ChatTool[]).filter((t) => allowed.has(t.function.name));
}

// ── Synthetic dispatch tools ────────────────────────────────────────────────

const DISPATCH_TOOLS: ChatTool[] = [
  {
    type: "function" as const,
    function: {
      name: "research",
      description:
        "Delegate a read-only research task to a focused sub-agent. The sub-agent can search and read notes, tasks, the knowledge graph and idea flow, then returns a concise findings brief. Use this to gather everything you need BEFORE writing. Provide a specific, self-contained instruction.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "What to research. Be specific about what to find and what to include in the brief.",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write",
      description:
        "Delegate a write task to a focused sub-agent that can create/modify notes and tasks, apply tags, and link items. Pass along any findings the writer needs (IDs, titles, themes) in the instruction — the writer does NOT see the research brief automatically. Provide a specific, self-contained instruction.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "What to write/modify, including the concrete content and any IDs/titles the writer needs.",
          },
        },
        required: ["instruction"],
      },
    },
  },
];

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface SubagentMetrics {
  /** SUM of prompt tokens across the dispatcher + every subagent turn (total cost). */
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /**
   * The DISPATCHER's own context usage — the prompt tokens on its last turn.
   * This is what the main/total ContextRing should show: the dispatcher only
   * ever holds the system prompt + the subagent briefs fed back, NOT the raw
   * tool outputs the subagents processed. Much smaller than `promptTokens`.
   */
  dispatcherPromptTokens: number;
  dispatcherCompletionTokens: number;
  dispatcherReasoningTokens: number;
  toolCalls: number;
  toolErrors: number;
  subagentRuns: number;
  /** How many times the dispatcher invoked the WRITE subagent. >1 = ping-pong. */
  writeInvocations: number;
  /** How many times the dispatcher invoked the RESEARCH subagent. */
  researchInvocations: number;
}

export interface SubagentRunResult {
  content: string;
  reasoning: string;
  metrics: SubagentMetrics;
}

interface DispatchConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  provider?: string;
}

/**
 * Streaming callbacks so the renderer can show a live, expandable trace of each
 * subagent (mirrors the Pi coding agent's pi-agent:subagent pattern). All events
 * carry a `childId` so the UI can group them under the right subagent block.
 */
export interface SubagentEvents {
  /** A subagent started. role is "research" | "write". */
  onSubagentStart?: (e: { childId: string; role: string; instruction: string }) => void;
  /** A subagent finished; `result` is the brief returned to the dispatcher. */
  onSubagentDone?: (e: { childId: string; role: string; result: string }) => void;
  /** A content token streamed by a subagent. */
  onSubagentToken?: (e: { childId: string; delta: string }) => void;
  /** A reasoning/thinking token streamed by a subagent. */
  onSubagentThought?: (e: { childId: string; delta: string }) => void;
  /** A tool call started inside a subagent. */
  onSubagentToolCall?: (e: { childId: string; tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void;
  /** A tool call finished inside a subagent. */
  onSubagentToolCallDone?: (e: { childId: string; tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; output?: string; callId?: string }) => void;
  /** Latest token usage for a subagent (its OWN context window) — drives its ring. */
  onSubagentUsage?: (e: { childId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number }) => void;
}

const DISPATCH_SYSTEM_PROMPT = (date: string) =>
  `You are the Cairn AI dispatcher — an orchestrator embedded in a note-taking and project-management app. Today is ${date}.

You do NOT read or write the workspace directly. You accomplish tasks by delegating to two sub-agents:
- **research(instruction)** — a read-only agent that searches and reads notes/tasks/graph and returns a findings brief.
- **write(instruction)** — an agent that creates/modifies notes and tasks. It does NOT see research output unless you include it in the instruction.

Workflow:
1. For anything requiring knowledge of the workspace, call \`research\` first with a specific instruction.
2. When you need to create/modify anything, call \`write\` and PASS the concrete content + any note/task IDs and titles the writer needs (copy them from the research brief).
3. For trivial writes that need no lookup, you may call \`write\` directly.
4. When done, give the user a brief, concrete confirmation. Keep replies concise markdown.`;

const RESEARCH_SYSTEM_PROMPT = (date: string) =>
  `You are a focused research sub-agent inside Cairn. Today is ${date}.
Use the read-only tools to gather what the instruction asks for. Call get_active_context first to obtain workspaceId/projectId/columnId; never invent IDs.
Return a CONCISE findings brief: the relevant note/task titles WITH their IDs, the key themes/facts, and anything the caller needs to act. Do not write or modify anything.`;

const WRITE_SYSTEM_PROMPT = (date: string) =>
  `You are a focused writing sub-agent inside Cairn. Today is ${date}.
Use the write tools to carry out the instruction exactly. Call get_active_context first if you need IDs; never invent IDs. Prefer the IDs/titles supplied in the instruction. After acting, briefly confirm what you did.`;

/**
 * Run one subagent turn via the shared runToolLoop with a restricted tool set
 * and a fresh history. Accumulates usage/tool metrics into `metrics`.
 */
async function runSubagent(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  cfg: DispatchConfig,
  systemPrompt: string,
  instruction: string,
  allowedTools: ReadonlySet<string>,
  metrics: SubagentMetrics,
  getWin?: () => BrowserWindow | null,
  argMutator?: (name: string, args: Record<string, unknown>) => Record<string, unknown>,
  childId?: string,
  events?: SubagentEvents,
): Promise<string> {
  metrics.subagentRuns += 1;
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: instruction },
  ];

  const result = await runToolLoop(
    db,
    req,
    workspacePath,
    cfg.baseUrl,
    cfg.model,
    cfg.apiKey,
    messages,
    (e) => {
      metrics.toolCalls += 1;
      if (childId) events?.onSubagentToolCall?.({ childId, tool: e.tool, label: e.label, args: e.args, callId: e.callId });
    },
    undefined,
    getWin,
    cfg.provider,
    (pt, ct, rt) => {
      // Accumulate into the total-cost figures…
      metrics.promptTokens += pt; metrics.completionTokens += ct; if (rt) metrics.reasoningTokens += rt;
      // …and report THIS subagent's own context window (its latest prompt size)
      // so the renderer can give it a dedicated ring. prompt_tokens is the size
      // of the context this turn, not a running sum — take the latest value.
      if (childId) events?.onSubagentUsage?.({ childId, promptTokens: pt, completionTokens: ct, reasoningTokens: rt });
    },
    (e) => {
      // Count tool errors by sniffing the JSON output for an error field.
      if (e.output) {
        try { if (JSON.parse(e.output)?.error) metrics.toolErrors += 1; } catch { /* non-JSON output */ }
      }
      if (childId) events?.onSubagentToolCallDone?.({ childId, tool: e.tool, cairnRef: e.cairnRef, output: e.output, callId: e.callId });
    },
    childId ? (delta) => events?.onSubagentToken?.({ childId, delta }) : undefined,
    childId ? (delta) => events?.onSubagentThought?.({ childId, delta }) : undefined,
    [],
    filterTools(allowedTools) as unknown as typeof TOOLS,
    argMutator,
  );

  const content = result.content.trim();
  if (content) return content;

  // Weak models frequently stop after their last tool call and emit an empty
  // final turn — the runToolLoop history has all the gathered tool outputs but
  // no synthesised brief. Force ONE more turn with tool_choice:"none" and an
  // explicit nudge to write the findings. This is the standard "force final
  // answer" pattern and rescues most empty-output cases on small models.
  if (metrics.toolCalls > 0 || messages.some((m) => m.role === "tool")) {
    const forced = await forceFinalAnswer(cfg, messages, metrics);
    if (forced.trim()) {
      if (childId) events?.onSubagentToken?.({ childId, delta: forced.trim() });
      return forced.trim();
    }
  }

  return "(sub-agent produced no output)";
}

/**
 * Do one non-streaming completion with tools DISABLED, nudging the model to
 * produce its final text answer from the conversation gathered so far. Used to
 * recover when a subagent stopped without emitting its brief/confirmation.
 */
async function forceFinalAnswer(
  cfg: DispatchConfig,
  messages: OpenAIMessage[],
  metrics: SubagentMetrics,
): Promise<string> {
  const nudged: OpenAIMessage[] = [
    ...messages,
    {
      role: "user",
      content:
        "Based on everything you have gathered above, write your final answer now as plain text. " +
        "Do NOT call any tools. If you were researching, produce the concise findings brief " +
        "(relevant titles WITH ids, key themes/facts). If you were writing, confirm what you did.",
    },
  ];

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  try {
    const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: nudged,
        tool_choice: "none",
        max_tokens: 4096,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!response.ok) return "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    if (data.usage) {
      metrics.promptTokens += data.usage.prompt_tokens ?? 0;
      metrics.completionTokens += data.usage.completion_tokens ?? 0;
      metrics.reasoningTokens += data.usage.completion_tokens_details?.reasoning_tokens ?? 0;
    }
    return (data.choices?.[0]?.message?.content as string) ?? "";
  } catch {
    return "";
  }
}

/**
 * Dispatch loop: advertises only `research` and `write`. When the model calls
 * one, we spawn the matching subagent and feed its final answer back as the
 * tool result. Mirrors runToolLoop's streaming/tool-call parsing but with a
 * 2-tool array and synthetic tool handling.
 */
export interface DispatchOptions {
  /** Tool set for the writing subagent. Defaults to WRITE_TOOL_NAMES (includes get_note). */
  writeTools?: ReadonlySet<string>;
  /** Tool set for the research subagent. Defaults to RESEARCH_TOOL_NAMES. */
  researchTools?: ReadonlySet<string>;
  /** Test/benchmark seam: transform tool args before execution (e.g. fault injection). */
  argMutator?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
  /** Streaming callbacks for a live, expandable subagent trace in the UI. */
  events?: SubagentEvents;
}

export async function runDispatchLoop(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  cfg: DispatchConfig,
  getWin?: () => BrowserWindow | null,
  opts?: DispatchOptions,
): Promise<SubagentRunResult> {
  const writeTools = opts?.writeTools ?? WRITE_TOOL_NAMES;
  const researchTools = opts?.researchTools ?? RESEARCH_TOOL_NAMES;
  const argMutator = opts?.argMutator;
  const events = opts?.events;
  let subSeq = 0;
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const metrics: SubagentMetrics = {
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    dispatcherPromptTokens: 0, dispatcherCompletionTokens: 0, dispatcherReasoningTokens: 0,
    toolCalls: 0, toolErrors: 0, subagentRuns: 0,
    writeInvocations: 0, researchInvocations: 0,
  };

  const messages: OpenAIMessage[] = [
    { role: "system", content: DISPATCH_SYSTEM_PROMPT(date) },
    ...(req.history ?? []).map((m) => {
      const out: OpenAIMessage = { role: m.role, content: m.content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    }),
    { role: "user", content: req.message },
  ];

  const maxSteps = req.config?.maxSteps ?? 12;
  const temperature = req.config?.temperature ?? 0.3;
  let finalContent = "";
  let finalReasoning = "";

  for (let round = 0; round < maxSteps; round++) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools: DISPATCH_TOOLS,
        tool_choice: "auto",
        max_tokens: 4096,
        temperature,
        stream: false,
        stream_options: undefined,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return { content: `Dispatch endpoint error (${response.status}): ${errText.slice(0, 300)}`, reasoning: finalReasoning, metrics };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    if (data.usage) {
      const pt = data.usage.prompt_tokens ?? 0;
      const ct = data.usage.completion_tokens ?? 0;
      const rt = data.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      // Total-cost figures accumulate across all turns…
      metrics.promptTokens += pt;
      metrics.completionTokens += ct;
      metrics.reasoningTokens += rt;
      // …but the dispatcher's CONTEXT is the latest turn's prompt size (system
      // prompt + subagent briefs fed back), NOT a running sum. This is what the
      // main/total ContextRing should reflect — the dispatcher never holds the
      // raw tool outputs the subagents processed.
      metrics.dispatcherPromptTokens = pt;
      metrics.dispatcherCompletionTokens += ct;
      metrics.dispatcherReasoningTokens += rt;
    }

    const choice = data.choices?.[0];
    const assistantMsg = choice?.message as OpenAIMessage & { reasoning?: string } | undefined;
    if (!assistantMsg) {
      return { content: "No response from dispatch model.", reasoning: finalReasoning, metrics };
    }
    if (assistantMsg.reasoning) finalReasoning += assistantMsg.reasoning;

    // Strip reasoning before pushing back into history.
    const { reasoning: _r, ...msgClean } = assistantMsg;

    if (!msgClean.tool_calls?.length) {
      finalContent = (msgClean.content ?? "").trim();
      messages.push(msgClean);
      // Weak models can end the dispatch turn with empty content even after
      // subagents did real work. Force a final synthesis from the gathered
      // subagent results rather than returning nothing.
      if (!finalContent && metrics.subagentRuns > 0) {
        finalContent = (await forceFinalAnswer(cfg, messages, metrics)).trim();
      }
      return { content: finalContent, reasoning: finalReasoning, metrics };
    }

    messages.push(msgClean);
    for (const call of msgClean.tool_calls) {
      metrics.toolCalls += 1;
      let args: { instruction?: string } = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep empty */ }
      const instruction = args.instruction ?? "";

      let subResult: string;
      if (call.function.name === "research") {
        metrics.researchInvocations += 1;
        const childId = `${req.threadId}:sub:${subSeq++}`;
        events?.onSubagentStart?.({ childId, role: "research", instruction });
        subResult = await runSubagent(
          db, req, workspacePath, cfg, RESEARCH_SYSTEM_PROMPT(date),
          instruction, researchTools, metrics, getWin, argMutator, childId, events,
        );
        events?.onSubagentDone?.({ childId, role: "research", result: subResult });
      } else if (call.function.name === "write") {
        metrics.writeInvocations += 1;
        const childId = `${req.threadId}:sub:${subSeq++}`;
        events?.onSubagentStart?.({ childId, role: "write", instruction });
        subResult = await runSubagent(
          db, req, workspacePath, cfg, WRITE_SYSTEM_PROMPT(date),
          instruction, writeTools, metrics, getWin, argMutator, childId, events,
        );
        events?.onSubagentDone?.({ childId, role: "write", result: subResult });
      } else {
        subResult = JSON.stringify({ error: `Unknown dispatch tool: ${call.function.name}` });
        metrics.toolErrors += 1;
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: subResult });
    }
  }

  return {
    content: finalContent || "Dispatcher reached the maximum number of steps.",
    reasoning: finalReasoning,
    metrics,
  };
}

// Reference (keeps RunToolLoopResult imported for type parity with chat-loop).
export type { RunToolLoopResult };
