/**
 * Cairn Native Agent Loop
 *
 * A stateful multi-turn tool-call loop. Reuses streamCompletion from llm.ts
 * (OpenAI-compatible). Each session keeps its own message history in the
 * PiAgentSession object managed by the IPC handler.
 *
 * Events emitted (via callbacks, forwarded to renderer over IPC):
 *   onToken(delta)              — streaming text chunk
 *   onToolStart(name, label)    — tool execution beginning
 *   onToolEnd(name, label, ok)  — tool execution finished
 *   onDone()                    — turn complete, no more tool calls
 *   onError(message)            — unrecoverable error
 */

import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import { isLocalEndpoint } from "./llm";
import {
  readTool,  readToolDefinition,
  writeTool, writeToolDefinition,
  editTool,  editToolDefinition,
  bashTool,  bashToolDefinition,
  grepTool,  grepToolDefinition,
  findTool,  findToolDefinition,
  lsTool,    lsToolDefinition,
  spawnSubagentDefinition, spawnSubagentTool,
} from "./coding-tools/index";
import { executeTool } from "../ipc/chat-executor";
import type { ChatRequest, ToolArgs } from "./tools";

// ── LLM config ───────────────────────────────────────────────────────────────

export interface AgentLLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Maximum tool-call iterations per turn. Defaults to 20. */
  maxSteps: number;
  /** Sampling temperature. Plan mode overrides this to 0.1 for determinism. */
  temperature: number;
}

// ── Message types ─────────────────────────────────────────────────────────────

export interface AgentUserMessage    { role: "user";      content: string }
export interface AgentAssistantMsg   { role: "assistant"; content: string | null; tool_calls?: ToolCallSpec[] }
export interface AgentToolResultMsg  { role: "tool";      tool_call_id: string; content: string }

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMsg
  | AgentToolResultMsg;

interface ToolCallSpec {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ── Tool label helper ─────────────────────────────────────────────────────────

const CODING_LABELS: Record<string, (args: ToolArgs) => string> = {
  read:  (a) => `Reading ${a.path as string}`,
  write: (a) => `Writing ${a.path as string}`,
  edit:  (a) => `Editing ${a.path as string}`,
  bash:  (a) => `$ ${(a.command as string).slice(0, 60)}${(a.command as string).length > 60 ? "…" : ""}`,
  grep:  (a) => `Searching for "${a.pattern as string}"`,
  find:  (a) => `Finding "${a.pattern as string}"`,
  ls:    (a) => `Listing ${(a.path as string) ?? "."}`,
};

// ── Events interface ──────────────────────────────────────────────────────────

export interface AgentLoopCallbacks {
  onToken:         (delta: string) => void;
  onToolsReady:    () => void;
  /** Fired during SSE streaming as soon as a tool call name is first seen.
   *  The chip should appear in "pending" state immediately — before execution. */
  onToolPending:   (name: string, callId: string) => void;
  /** callId links back to the pending chip created by onToolPending (if any). */
  onToolStart:     (name: string, label: string, callId?: string) => void;
  /** callId links back to the same chip created by onToolPending / updated by onToolStart. */
  onToolEnd:       (name: string, label: string, ok: boolean, output: string, callId?: string) => void;
  onStepStart:     () => void;
  onUsage:         (promptTokens: number, completionTokens: number) => void;
  onDone:          () => void;
  onError:         (message: string) => void;
  /** Fired when the agent writes a note in plan mode — carries the note ID */
  onPlanNoteFound?: (noteId: string) => void;
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface PiAgentSession {
  messages: AgentMessage[];
  abortCtrl: AbortController;
}

// ── All tool definitions ──────────────────────────────────────────────────────

const CODING_TOOL_DEFS = [
  readToolDefinition,
  writeToolDefinition,
  editToolDefinition,
  bashToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  lsToolDefinition,
  spawnSubagentDefinition,
];

// Cairn data tool names exposed to the coding agent.
// get_cairn_context is excluded (see AGENT_EXCLUDED_TOOLS) — agents use
// get_project_context_pack instead. Delete tools are intentionally omitted
// to prevent autonomous destructive actions.
const CAIRN_TOOL_NAMES = new Set([
  // ── Context / read ──────────────────────────────────────────────────────────
  "get_active_context",
  "get_project_context_pack",
  "get_neighbors",
  // ── Notes ───────────────────────────────────────────────────────────────────
  "get_note",
  "ensure_note",
  "patch_note",
  "append_to_note",
  "search_notes",
  // ── Tasks ───────────────────────────────────────────────────────────────────
  "get_task",
  "create_task",
  "update_task",
  "bulk_update_task_status",
  "search_tasks",
  "list_ready_tasks",
  "link_note_to_task",
  // ── Tags ────────────────────────────────────────────────────────────────────
  "create_tag",
  // ── Idea Flow ───────────────────────────────────────────────────────────────
  "get_idea_flow",
  "get_idea_flow_rules",
  "create_idea_flow_node",
  "update_idea_flow_node",
  "create_idea_flow_edge",
  "layout_idea_flow",
  // ── Renderer-side only — main process no-ops; renderer renders an inline QuestionForm.
  "ask_questions",
]);

// Tools available in plan mode — read-only + PRD note write only.
const PLAN_MODE_ALLOWED = new Set([
  // coding read-only
  "read", "grep", "find", "ls",
  // Cairn read
  "get_active_context", "get_project_context_pack",
  "get_note", "search_notes",
  "get_task", "search_tasks", "list_ready_tasks",
  // Cairn write — PRD note only (idempotent upsert)
  "ensure_note",
  // Renderer-side: renders inline question form
  "ask_questions",
]);

// ── Fetch all tool definitions (coding + Cairn subset) ────────────────────────

import { TOOLS as ALL_CAIRN_TOOLS } from "./tools";

function getAllToolDefs(mode: "plan" | "execute" = "execute") {
  const cairnSubset = ALL_CAIRN_TOOLS.filter((t) => CAIRN_TOOL_NAMES.has(t.function.name));
  const all = [...CODING_TOOL_DEFS, ...cairnSubset];
  if (mode === "plan") {
    return all.filter((t) => PLAN_MODE_ALLOWED.has(t.function.name));
  }
  return all;
}

// ── Execute a single tool call ────────────────────────────────────────────────

async function executeSingleTool(
  name: string,
  args: ToolArgs,
  cwd: string,
  signal: AbortSignal,
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  llmConfig: AgentLLMConfig,
  onUpdate: (output: string) => void,
  sessionId: string,
  send: (channel: string, payload: unknown) => void,
  getWin?: () => BrowserWindow | null,
): Promise<string> {
  switch (name) {
    case "read":  return readTool(args as Parameters<typeof readTool>[0],  cwd);
    case "write": return writeTool(args as Parameters<typeof writeTool>[0], cwd);
    case "edit":  return editTool(args as Parameters<typeof editTool>[0],  cwd);
    case "bash":  return bashTool(
      args as Parameters<typeof bashTool>[0],
      cwd,
      { signal, onUpdate }
    );
    case "grep":  return grepTool(args as Parameters<typeof grepTool>[0], cwd);
    case "find":  return findTool(args as Parameters<typeof findTool>[0], cwd);
    case "ls":    return lsTool(args as Parameters<typeof lsTool>[0],    cwd);
    case "spawn_subagent": return spawnSubagentTool(
      args as Parameters<typeof spawnSubagentTool>[0],
      cwd,
      llmConfig,
      db,
      req,
      workspacePath,
      sessionId,
      send,
      getWin,
    );
    default: {
      // Delegate to Cairn chat executor
      if (CAIRN_TOOL_NAMES.has(name)) {
        // ask_questions is a renderer-side tool — emit the questions as an IPC event
        // so PiAgentPane can render an inline QuestionForm. The tool result is a no-op
        // acknowledgement; the user's answers arrive as the next sendPrompt call.
        if (name === "ask_questions" && Array.isArray((args as { questions?: unknown }).questions)) {
          send("pi-agent:ask-questions", { sessionId, questions: (args as { questions: unknown[] }).questions });
        }
        const result = await executeTool(
          db, req, workspacePath,
          { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey },
          name, args,
          undefined,
        );
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(
  session: PiAgentSession,
  systemPrompt: string,
  cwd: string,
  llmConfig: AgentLLMConfig,
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  callbacks: AgentLoopCallbacks,
  getWin?: () => BrowserWindow | null,
  sessionId?: string,
  send?: (channel: string, payload: unknown) => void,
  mode: "plan" | "execute" = "execute",
): Promise<void> {
  const { signal } = session.abortCtrl;
  const allTools = getAllToolDefs(mode);

  const { baseUrl, model, apiKey, maxSteps, temperature: configTemp } = llmConfig;
  // Plan mode always uses 0.1 for deterministic analysis regardless of user setting
  const temperature = mode === "plan" ? 0.1 : (configTemp ?? 0.3);
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    callbacks.onError("No API key configured. Set one in Settings → AI & Chat.");
    return;
  }

  let steps = 0;

  while (steps < maxSteps) {
    if (signal.aborted) { callbacks.onDone(); return; }
    steps++;
    // From step 2 onwards, signal the renderer to finalise the previous
    // assistant message and start a fresh one for this turn's tokens.
    if (steps > 1) callbacks.onStepStart();

    // Build messages array for this request
    const messages: AgentMessage[] = [
      { role: "user", content: systemPrompt } as AgentUserMessage,
      ...session.messages,
    ];

    // ── Stream assistant response ─────────────────────────────────────────
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model,
          messages,
          tools: allTools,
          tool_choice: "auto",
          max_tokens: 8192,
          temperature,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (e) {
      if (signal.aborted) { callbacks.onDone(); return; }
      callbacks.onError(`Cannot reach AI endpoint: ${(e as Error).message}`);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      callbacks.onError(`AI error (${response.status}): ${text.slice(0, 300)}`);
      return;
    }

    // ── Parse SSE stream, accumulate tool calls ───────────────────────────
    const reader = response.body?.getReader();
    if (!reader) { callbacks.onError("No response stream"); return; }

    const decoder = new TextDecoder();
    let contentBuffer = "";
    const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();
    // callId assigned per tool during streaming — reused at execution time
    const streamCallIds: Map<number, string> = new Map();
    let toolsReadyFired = false;
    let streamDone = false;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") {
          // Mark done and break the inner loop — the outer while condition
          // catches this on the next iteration so we don't call reader.read() again.
          streamDone = true;
          break;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunk = JSON.parse(jsonStr) as any;

          // Usage chunk — sent as the final SSE chunk when stream_options.include_usage is set.
          // It has an empty choices array and a top-level usage object.
          if (chunk.usage) {
            const pt = chunk.usage.prompt_tokens ?? 0;
            const ct = chunk.usage.completion_tokens ?? 0;
            callbacks.onUsage(pt, ct);
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Text token
          if (delta.content) {
            contentBuffer += delta.content;
            callbacks.onToken(delta.content);
          }

          // Tool call chunks
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              const isNew = !toolCallBuffers.has(idx);
              if (isNew) {
                toolCallBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;

              // As soon as we have the tool name, fire pending chip — mirrors pi's
              // approach of creating the chip during streaming, not post-stream.
              if (isNew && buf.name) {
                if (!toolsReadyFired) {
                  callbacks.onToolsReady();
                  toolsReadyFired = true;
                }
                const callId = `${buf.name}:${Date.now()}:${idx}`;
                streamCallIds.set(idx, callId);
                callbacks.onToolPending(buf.name, callId);
              }
            }
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }

    // ── No tool calls → turn complete ─────────────────────────────────────
    if (toolCallBuffers.size === 0) {
      session.messages.push({ role: "assistant", content: contentBuffer });
      callbacks.onDone();
      return;
    }

    // ── Build tool call list from accumulated buffers ─────────────────────
    const toolCalls: ToolCallSpec[] = Array.from(toolCallBuffers.entries())
      .sort(([a], [b]) => a - b)
      .map(([, buf]) => ({
        id: buf.id,
        type: "function" as const,
        function: { name: buf.name, arguments: buf.args },
      }));

    // Persist assistant message with tool_calls
    session.messages.push({
      role: "assistant",
      content: contentBuffer || null,
      tool_calls: toolCalls,
    });

    // ── Ensure renderer has a streaming message (fallback if onToolsReady
    //    wasn't fired during streaming, e.g. endpoint doesn't stream tool names).
    if (!toolsReadyFired) callbacks.onToolsReady();

    // ── Execute each tool ─────────────────────────────────────────────────
    for (const [tcIdx, tc] of toolCalls.entries()) {
      if (signal.aborted) { callbacks.onDone(); return; }

      let args: ToolArgs = {};
      try { args = JSON.parse(tc.function.arguments) as ToolArgs; } catch { args = {}; }

      const label =
        CODING_LABELS[tc.function.name]?.(args) ??
        `${tc.function.name}`;

      // Pass the callId assigned during streaming so the renderer updates the
      // existing pending chip rather than creating a duplicate.
      const pendingCallId = streamCallIds.get(tcIdx);
      callbacks.onToolStart(tc.function.name, label, pendingCallId);

      // Yield to the event loop so the renderer can process the onToolStart IPC
      // message and render the running spinner before the (potentially synchronous)
      // tool execution blocks the main process event loop.
      await new Promise<void>((r) => setImmediate(r));

      let resultContent: string;
      let ok = true;
      try {
        resultContent = await executeSingleTool(
          tc.function.name,
          args,
          cwd,
          signal,
          db,
          req,
          workspacePath,
          llmConfig,
          (output) => callbacks.onToolStart(tc.function.name, `${label}: ${output.slice(-80)}`),
          sessionId ?? "",
          send ?? (() => {}),
          getWin,
        );
      } catch (e) {
        ok = false;
        resultContent = `Error: ${(e as Error).message}`;
      }

      callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId);

      // In plan mode only, notify the renderer when the agent writes the PRD note.
      // Suppressed in execute mode to avoid overwriting planNoteId after approval.
      if (mode === "plan" && ok && tc.function.name === "ensure_note") {
        try {
          const parsed = JSON.parse(resultContent) as { id?: string };
          if (parsed?.id) callbacks.onPlanNoteFound?.(parsed.id);
        } catch { /* non-JSON output — ignore */ }
      }

      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultContent,
      });
    }
    // Loop continues → next LLM call with tool results appended
  }

  // Exceeded max steps
  callbacks.onError(
    `Reached the maximum of ${maxSteps} steps. Any changes made have been saved. Try a more focused request.`
  );
}
