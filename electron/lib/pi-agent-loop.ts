/**
 * Cairn Native Agent Loop
 *
 * A stateful multi-turn tool-call loop (OpenAI-compatible streaming).
 * Each session keeps its own message history in the PiAgentSession object
 * managed by the IPC handler.
 *
 * Events emitted (via callbacks, forwarded to renderer over IPC):
 *   onToken(delta)              — streaming text chunk
 *   onToolStart(name, label)    — tool execution beginning
 *   onToolEnd(name, label, ok)  — tool execution finished
 *   onDone()                    — turn complete, no more tool calls
 *   onError(message)            — unrecoverable error
 *   onRetry?(attempt, max, delayMs, error) — transient error, retrying
 */

import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import { isLocalEndpoint, calculatePromptBreakdown, scaleBreakdown, type TokenBreakdown } from "./llm";
import {
  readTool,  readToolDefinition,
  writeTool, writeToolDefinition,
  editTool,  editToolDefinition,
  bashTool,  bashToolDefinition,
  grepTool,  grepToolDefinition,
  findTool,  findToolDefinition,
  lsTool,    lsToolDefinition,
  spawnSubagentDefinition, spawnSubagentTool,
  skillTool, makeSkillToolDefinition,
} from "./coding-tools/index";
import { executeTool } from "../ipc/chat-executor";
import type { ChatRequest, ToolArgs } from "./tools";
import type { SkillMeta } from "./skills";

// ── LLM config ───────────────────────────────────────────────────────────────

export interface AgentLLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Maximum tool-call iterations per turn. Defaults to 20. */
  maxSteps: number;
  /** Sampling temperature. Plan mode overrides this to 0.1 for determinism. */
  temperature: number;
  /** Maximum automatic retries on transient errors (429/5xx). Defaults to 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Doubles each attempt. Defaults to 2000. */
  baseRetryDelayMs?: number;
  /**
   * Model context window size in tokens. Used by the sliding-window pruner to
   * decide when to trim old messages. Defaults to 128000.
   */
  contextWindow?: number;
  /** Whether to automatically approve tool calls or prompt the user. */
  autoApprove?: boolean;
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

// ── Per-session infrastructure context ───────────────────────────────────────

/**
 * Stable, per-session infrastructure that every tool needs.
 * Passed as a single object instead of individual positional parameters.
 */
export interface AgentToolContext {
  /** Working directory for all file-system tool calls. */
  cwd: string;
  /** SQLite database handle for Cairn tool execution. */
  db: Database.Database;
  /** ChatRequest used to scope Cairn tool calls (threadId, projectId, etc.). */
  req: ChatRequest;
  /** Absolute path to the Electron workspace root (for note file writes). */
  workspacePath: string;
  /** Session ID — used to scope IPC events and subagent child IDs. */
  sessionId: string;
  /** Send an IPC event to the renderer window. */
  send: (channel: string, payload: unknown) => void;
  /** Returns the current BrowserWindow (may be null if destroyed). */
  getWin?: () => BrowserWindow | null;
  /**
   * Discovered skills for this session. Passed to the `skill` tool so it can
   * load the full body of a SKILL.md on demand. Defaults to empty array.
   */
  skills?: SkillMeta[];
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
  onUsage:         (promptTokens: number, completionTokens: number, breakdown?: TokenBreakdown) => void;
  onDone:          () => void;
  onError:         (message: string) => void;
  /** Fired when a tool call needs user confirmation before execution. */
  onToolConfirmRequired?: (name: string, label: string, callId: string) => void;
  /** Fired when the agent writes a note in plan mode — carries the note ID */
  onPlanNoteFound?: (noteId: string) => void;
  /**
   * Fired before each automatic retry attempt on a transient error.
   * The renderer can show a countdown ("Retrying in Xs…") in the status area.
   */
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: string) => void;
  /**
   * Optional transform applied to session.messages before each LLM call.
   * Does NOT mutate session.messages — only affects what is sent to the model.
   * Use for context pruning, injection, or summarisation.
   */
  transformContext?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  /**
   * Called after each turn's tool results are appended, before the next LLM
   * call. Return true to stop the loop cleanly (fires onDone, not onError).
   * Useful for semantic stop conditions e.g. "task card reached Done column".
   */
  shouldStop?: (messages: AgentMessage[]) => boolean | Promise<boolean>;
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface PiAgentSession {
  messages: AgentMessage[];
  abortCtrl: AbortController;
  /** Most recent prompt_tokens count from the last onUsage callback. Updated each turn. */
  lastPromptTokens?: number;
  /**
   * Compaction transformer for this session. Stored here so the cachedSummary
   * inside it survives across multiple pi-agent:prompt calls on the same session.
   * Built once on first use and reused; the signal is updated via abortCtrl each turn.
   */
  compactionTransformer?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
}

export const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

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
  "semantic_search_notes",
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
  // ── Codebase Semantic Indexer ───────────────────────────────────────────────
  "codebase_reindex",
  "codebase_search_symbols",
  "codebase_get_symbol_definition",
  "codebase_get_references",
  "codebase_get_file_symbols",
]);

// Tools available in plan mode — read-only + PRD note write only.
const PLAN_MODE_ALLOWED = new Set([
  // coding read-only
  "read", "grep", "find", "ls",
  // Cairn read
  "get_active_context", "get_project_context_pack",
  "get_note", "search_notes",
  "get_task", "search_tasks", "list_ready_tasks",
  "semantic_search_notes",
  // codebase search (read-only)
  "codebase_search_symbols", "codebase_get_symbol_definition",
  "codebase_get_references", "codebase_get_file_symbols",
  // Cairn write — PRD note only (idempotent upsert)
  "ensure_note",
  // Renderer-side: renders inline question form
  "ask_questions",
  // Skills — allowed in both modes so agents can load workflow instructions
  "skill",
]);

// ── Fetch all tool definitions (coding + Cairn subset) ────────────────────────

import { TOOLS as ALL_CAIRN_TOOLS } from "./tools";

function getAllToolDefs(mode: "plan" | "execute" = "execute", skills: SkillMeta[] = []) {
  const cairnSubset = ALL_CAIRN_TOOLS.filter((t) => CAIRN_TOOL_NAMES.has(t.function.name));
  // Only include the skill tool when at least one skill is available
  const skillDef = skills.length > 0 ? [makeSkillToolDefinition(skills)] : [];
  const all = [...CODING_TOOL_DEFS, ...skillDef, ...cairnSubset];
  if (mode === "plan") {
    return all.filter((t) => PLAN_MODE_ALLOWED.has(t.function.name));
  }
  return all;
}

// ── Retry helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when an HTTP status + body string indicates a transient error
 * that is worth retrying. Never retries auth/bad-request errors.
 */
function isRetryableError(status: number, body: string): boolean {
  if (status === 400 || status === 401 || status === 403) return false;
  if (status === 429 || status >= 500) return true;
  return /overloaded|rate.?limit|service.?unavailable|server.?error|connection.?error|fetch failed|timed?.?out/i.test(body);
}

/**
 * Abortable sleep. Rejects with an AbortError if signal fires before the delay.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

// ── Context pruning ───────────────────────────────────────────────────────────

/**
 * Default transformContext implementation.
 *
 * When the last recorded promptTokens exceeds 80 % of the configured context
 * window, trims the oldest messages while preserving:
 *   - The first user message (the original request).
 *   - The most recent KEEP_TURNS assistant+tool pairs.
 *   - Any tool-result messages whose tool_call_id is still referenced by a
 *     kept assistant message (orphan prevention).
 * A synthetic marker message is injected at the trim boundary so the model
 * knows context was abbreviated.
 */
const KEEP_TURNS = 8;
const CONTEXT_TRIM_THRESHOLD = 0.80;

function buildSlidingWindowPruner(
  session: PiAgentSession,
  contextWindow: number,
): (messages: AgentMessage[]) => AgentMessage[] {
  return (messages: AgentMessage[]): AgentMessage[] => {
    const lastPromptTokens = session.lastPromptTokens ?? 0;
    if (lastPromptTokens === 0 || lastPromptTokens < contextWindow * CONTEXT_TRIM_THRESHOLD) {
      return messages;
    }

    const keepIds = new Set<string>(); // tool_call_ids referenced by kept assistant msgs
    let keptTurns = 0;
    let keepFromIdx = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        keptTurns++;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) keepIds.add(tc.id);
        }
        keepFromIdx = i;
        if (keptTurns >= KEEP_TURNS) break;
      }
    }

    const firstUser = messages.find((m) => m.role === "user");
    const tail = messages.slice(keepFromIdx);

    // Keep any orphaned tool-result messages before the tail whose call_id is still referenced
    const extraToolResults = messages.slice(1, keepFromIdx).filter(
      (m) => m.role === "tool" && keepIds.has((m as AgentToolResultMsg).tool_call_id),
    );

    const marker: AgentUserMessage = {
      role: "user",
      content: "[Earlier context trimmed to fit the context window. The full conversation history is preserved in session storage.]",
    };

    const pruned: AgentMessage[] = [];
    if (firstUser) pruned.push(firstUser);
    pruned.push(marker);
    pruned.push(...extraToolResults);
    pruned.push(...tail);

    return pruned;
  };
}

// ── Execute a single tool call ────────────────────────────────────────────────

async function executeSingleTool(
  name: string,
  args: ToolArgs,
  signal: AbortSignal,
  onUpdate: (output: string) => void,
  toolCtx: AgentToolContext,
  llmConfig: AgentLLMConfig,
): Promise<string> {
  const { cwd, db, req, workspacePath, sessionId, send, getWin: _getWin } = toolCtx;

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
    case "skill": return skillTool(
      args as Parameters<typeof skillTool>[0],
      toolCtx.skills ?? [],
    );
    case "spawn_subagent": return spawnSubagentTool(
      args as Parameters<typeof spawnSubagentTool>[0],
      toolCtx,
      llmConfig,
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
        return typeof result === "string" ? result : JSON.stringify(result);
      }
      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
//
// INVARIANT: within the Electron main process, always call runAgentLoop via
// runSession() in electron/ipc/pi-agent.ts — never directly. runSession()
// ensures the compaction transformer is built once per session and the correct
// IPC callbacks are wired. Direct callers bypass compaction and the note-update
// side effect in onToolEnd.
//
// The function is exported so pi-agent-loop.test.ts can call it directly with
// a mock toolCtx (no real Electron window). This is the only intended direct
// call site outside of runSession().

export async function runAgentLoop(
  session: PiAgentSession,
  systemPrompt: string,
  llmConfig: AgentLLMConfig,
  callbacks: AgentLoopCallbacks,
  toolCtx: AgentToolContext,
  mode: "plan" | "execute" = "execute",
): Promise<void> {
  const { signal } = session.abortCtrl;
  const allTools = getAllToolDefs(mode, toolCtx.skills ?? []);

  const {
    baseUrl, model, apiKey, maxSteps, temperature: configTemp,
    maxRetries    = 3,
    baseRetryDelayMs = 2000,
    contextWindow = 128_000,
  } = llmConfig;

  // Plan mode always uses 0.1 for deterministic analysis regardless of user setting
  const temperature = mode === "plan" ? 0.1 : (configTemp ?? 0.3);
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    callbacks.onError("No API key configured. Set one in Settings → AI & Chat.");
    return;
  }

  // Build the context pruner — closes over session so it sees live lastPromptTokens
  const pruner = callbacks.transformContext
    ?? buildSlidingWindowPruner(session, contextWindow);

  let steps = 0;

  while (steps < maxSteps) {
    if (signal.aborted) { callbacks.onDone(); return; }
    steps++;
    // From step 2 onwards, signal the renderer to finalise the previous
    // assistant message and start a fresh one for this turn's tokens.
    if (steps > 1) callbacks.onStepStart();

    // Build messages array — apply context pruning.
    // systemPrompt passes as `system:` in the request body (not as a user message).
    const contextMessages = await pruner([...session.messages]);

    // ── Stream assistant response ─────────────────────────────────────────
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    // Retry loop — wraps the fetch + !response.ok check
    let response: Response | null = null;
    let retryAttempt = 0;

    while (true) {
      if (signal.aborted) { callbacks.onDone(); return; }

      let fetchError: string | null = null;
      try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model,
            system: systemPrompt,
            messages: contextMessages,
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
        fetchError = (e as Error).message;
      }

      // Determine if we should retry
      const status = response?.status ?? 0;
      let bodyText = "";
      if (response && !response.ok) {
        bodyText = await response.text().catch(() => response!.statusText);
      }

      const shouldRetry =
        fetchError !== null
          ? /overloaded|rate.?limit|service.?unavailable|server.?error|connection.?error|fetch failed|timed?.?out/i.test(fetchError)
          : (response && !response.ok && isRetryableError(status, bodyText));

      if (!shouldRetry) break; // success or non-retryable error — exit retry loop

      if (retryAttempt >= maxRetries) {
        const errMsg = fetchError
          ? `Cannot reach AI endpoint after ${maxRetries} retries: ${fetchError}`
          : `AI error (${status}) after ${maxRetries} retries: ${bodyText.slice(0, 300)}`;
        callbacks.onError(errMsg);
        return;
      }

      retryAttempt++;
      const delayMs = baseRetryDelayMs * 2 ** (retryAttempt - 1);
      callbacks.onRetry?.(retryAttempt, maxRetries, delayMs, fetchError ?? bodyText.slice(0, 200));

      try {
        await sleep(delayMs, signal);
      } catch {
        callbacks.onDone();
        return;
      }

      response = null; // reset for next attempt
    }

    // Non-retryable hard errors
    if (!response) {
      callbacks.onError("Cannot reach AI endpoint. Check your network and API settings.");
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => response!.statusText);
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
          streamDone = true;
          break;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chunk = JSON.parse(jsonStr) as any;

          // Usage chunk — sent as the final SSE chunk when stream_options.include_usage is set.
          if (chunk.usage) {
            const pt = chunk.usage.prompt_tokens ?? 0;
            const ct = chunk.usage.completion_tokens ?? 0;
            session.lastPromptTokens = pt;
            let breakdown: TokenBreakdown | undefined;
            try {
              const rawBreakdown = calculatePromptBreakdown(systemPrompt, contextMessages, allTools);
              breakdown = scaleBreakdown(rawBreakdown, pt);
            } catch (err) {
              console.error("[pi-agent] failed to calculate breakdown:", err);
            }
            callbacks.onUsage(pt, ct, breakdown);
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            contentBuffer += delta.content;
            callbacks.onToken(delta.content);
          }

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

              // Fire pending chip as soon as we see the tool name during streaming
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

    session.messages.push({
      role: "assistant",
      content: contentBuffer || null,
      tool_calls: toolCalls,
    });

    if (!toolsReadyFired) callbacks.onToolsReady();

    // ── Execute tools in parallel ─────────────────────────────────────────
    // All tools in a turn fire concurrently. Results are appended to
    // session.messages in original source order regardless of completion order.
    // onToolEnd fires as each tool finishes (may be out of order for UI updates).
    // The file mutex in file-mutex.ts serialises concurrent writes to the same path.
    if (signal.aborted) { callbacks.onDone(); return; }

    type ToolOutcome = { tcIdx: number; tc: ToolCallSpec; ok: boolean; resultContent: string; pendingCallId?: string };

    const toolPromises: Promise<ToolOutcome>[] = toolCalls.map(async (tc, tcIdx): Promise<ToolOutcome> => {
      let args: ToolArgs = {};
      try { args = JSON.parse(tc.function.arguments) as ToolArgs; } catch { args = {}; }

      const label = CODING_LABELS[tc.function.name]?.(args) ?? tc.function.name;
      const pendingCallId = streamCallIds.get(tcIdx);
      callbacks.onToolStart(tc.function.name, label, pendingCallId);

      // Yield to the event loop so the IPC layer dispatches the onToolStart event
      // to the renderer before execution begins — this makes the chip appear in
      // "running" state immediately rather than jumping straight to "done".
      // A two-way IPC handshake (renderer acks → loop continues) would be more
      // robust but isn't worth the added complexity here.
      await new Promise<void>((r) => setImmediate(r));

      let resultContent: string = "";
      let ok = true;

      if (llmConfig.autoApprove === false) {
        const callKey = pendingCallId || tc.id;
        callbacks.onToolConfirmRequired?.(tc.function.name, label, callKey);
        const approved = await new Promise<boolean>((resolve) => {
          const onAbort = () => {
            pendingApprovals.delete(callKey);
            resolve(false);
          };
          if (signal.aborted) {
            resolve(false);
            return;
          }
          signal.addEventListener("abort", onAbort);
          pendingApprovals.set(callKey, {
            resolve: (val) => {
              signal.removeEventListener("abort", onAbort);
              resolve(val);
            }
          });
        });
        if (!approved) {
          ok = false;
          resultContent = "Blocked: tool call rejected by user";
          callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId);
          return { tcIdx, tc, ok, resultContent, pendingCallId };
        }
      }

      try {
        resultContent = await executeSingleTool(
          tc.function.name,
          args,
          signal,
          (output) => callbacks.onToolStart(tc.function.name, `${label}: ${output.slice(-80)}`),
          toolCtx,
          llmConfig,
        );
      } catch (e) {
        ok = false;
        resultContent = `Error: ${(e as Error).message}`;
      }

      callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId);

      // In plan mode, notify renderer when agent writes the PRD note
      if (mode === "plan" && ok && tc.function.name === "ensure_note") {
        try {
          const parsed = JSON.parse(resultContent) as { id?: string };
          if (parsed?.id) callbacks.onPlanNoteFound?.(parsed.id);
        } catch { /* non-JSON output — ignore */ }
      }

      return { tcIdx, tc, ok, resultContent, pendingCallId };
    });

    const outcomes = await Promise.all(toolPromises);

    // Append in source order
    outcomes.sort((a, b) => a.tcIdx - b.tcIdx);
    for (const { tc, resultContent } of outcomes) {
      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultContent,
      });
    }

    // Check semantic stop condition before starting the next LLM call.
    if (callbacks.shouldStop && await callbacks.shouldStop(session.messages)) {
      callbacks.onDone();
      return;
    }
    // Loop continues → next LLM call with tool results appended
  }

  // Exceeded max steps
  callbacks.onError(
    `Reached the maximum of ${maxSteps} steps. Any changes made have been saved. Try a more focused request.`
  );
}
