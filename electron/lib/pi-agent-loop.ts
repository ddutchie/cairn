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
} from "./coding-tools/index";
import { executeTool } from "../ipc/chat-executor";
import type { ChatRequest, ToolArgs } from "./tools";

// ── LLM config ───────────────────────────────────────────────────────────────

export interface AgentLLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
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
  onToken:     (delta: string) => void;
  onToolStart: (name: string, label: string) => void;
  onToolEnd:   (name: string, label: string, ok: boolean) => void;
  onDone:      () => void;
  onError:     (message: string) => void;
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
];

// Cairn data tool names we expose to the coding agent (subset of chat tools)
const CAIRN_TOOL_NAMES = new Set([
  "get_active_context",
  "get_project_context_pack",
  "list_notes",
  "get_note",
  "create_note",
  "update_note",
  "patch_note",
  "append_to_note",
  "search_notes",
  "list_tasks",
  "get_task",
  "create_task",
  "update_task",
  "update_task_status",
  "search_tasks",
  "list_ready_tasks",
  "get_idea_flow",
  "create_idea_flow_node",
  "create_idea_flow_edge",
]);

// ── Fetch all tool definitions (coding + Cairn subset) ────────────────────────

import { TOOLS as ALL_CAIRN_TOOLS } from "./tools";

function getAllToolDefs() {
  const cairnSubset = ALL_CAIRN_TOOLS.filter((t) => CAIRN_TOOL_NAMES.has(t.function.name));
  return [...CODING_TOOL_DEFS, ...cairnSubset];
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
    default: {
      // Delegate to Cairn chat executor
      if (CAIRN_TOOL_NAMES.has(name)) {
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

const MAX_STEPS = 30;

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
): Promise<void> {
  const { signal } = session.abortCtrl;
  const allTools = getAllToolDefs();

  const { baseUrl, model, apiKey } = llmConfig;
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    callbacks.onError("No API key configured. Set one in Settings → AI & Chat.");
    return;
  }

  let steps = 0;

  while (steps < MAX_STEPS) {
    if (signal.aborted) { callbacks.onDone(); return; }
    steps++;

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
          temperature: 0.3,
          stream: true,
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunk = JSON.parse(jsonStr) as any;
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
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;
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

    // ── Execute each tool ─────────────────────────────────────────────────
    for (const tc of toolCalls) {
      if (signal.aborted) { callbacks.onDone(); return; }

      let args: ToolArgs = {};
      try { args = JSON.parse(tc.function.arguments) as ToolArgs; } catch { args = {}; }

      const label =
        CODING_LABELS[tc.function.name]?.(args) ??
        `${tc.function.name}`;

      callbacks.onToolStart(tc.function.name, label);

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
        );
      } catch (e) {
        ok = false;
        resultContent = `Error: ${(e as Error).message}`;
      }

      callbacks.onToolEnd(tc.function.name, label, ok);

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
    `Reached the maximum of ${MAX_STEPS} steps. Any changes made have been saved. Try a more focused request.`
  );
}
