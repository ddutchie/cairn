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
import { isLocalEndpoint, calculatePromptBreakdown, scaleBreakdown, buildApiUrl, type TokenBreakdown } from "./llm";
import { recordLlmUsage, extractCost } from "./usage-recorder";
import type { UsageSource } from "../db/usage-queries";
import {
  buildChatCompletionsBody,
  consumeAssistantStream,
  failToolCallsFromTruncatedMessage,
  interruptedStreamToolCallError,
  prepareContextMessages,
  resolveSystemRole,
} from "./llm-stream";
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
import { traceTool } from "./tool-trace";
import { parseToolArgs } from "./parse-tool-args";
import { resultContentError } from "./tool-result";

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
  /**
   * Max output tokens per turn. Undefined/0 → OMIT max_tokens so the model
   * finishes naturally — the old hardcoded cap could stall a "thinking" agent
   * model mid-reasoning (empty content → a 400 on the next turn). A positive
   * value is the user's deliberate cap.
   */
  maxTokens?: number;
  /** Whether the selected model is a reasoning/thinking model (from the models.dev catalog). */
  isReasoningModel?: boolean;
  /** Provider slug (e.g. "openai", "localllm") for provider-aware role resolution. */
  provider?: string;
}

// ── Message types ─────────────────────────────────────────────────────────────

export interface AgentUserMessage    { role: "user";      content: string }
export interface AgentAssistantMsg   { role: "assistant"; content: string | null; reasoning?: string; reasoningField?: string; reasoningModel?: string; tool_calls?: ToolCallSpec[] }
export interface AgentToolResultMsg  { role: "tool";      tool_call_id: string; content: string }

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMsg
  | AgentToolResultMsg;

interface ToolCallSpec {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Gemini 3.x thought signature — opaque blob returned by the model on
   * tool-call parts when thinking is enabled. Must be round-tripped back
   * on subsequent requests so the model can resume its reasoning state.
   * Other providers ignore this field.
   */
  thought_signature?: string;
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
  /** Streams reasoning/thinking deltas (Claude's thinking_delta, OpenAI's delta.reasoning). Absent for non-reasoning models. */
  onThought?:      (delta: string) => void;
  onToolsReady:    () => void;
  /** Fired during SSE streaming as soon as a tool call name is first seen.
   *  The chip should appear in "pending" state immediately — before execution. */
  onToolPending:   (name: string, callId: string) => void;
  /** callId links back to the pending chip created by onToolPending (if any). */
  onToolStart:     (name: string, label: string, callId?: string, args?: ToolArgs) => void;
  /** callId links back to the same chip created by onToolPending / updated by onToolStart. */
  onToolEnd:       (name: string, label: string, ok: boolean, output: string, callId?: string, args?: ToolArgs) => void;
  onStepStart:     () => void;
  onUsage:         (promptTokens: number, completionTokens: number, reasoningTokens: number, breakdown?: TokenBreakdown, costUsd?: number) => void;
  onDone:          () => void;
  onError:         (message: string) => void;
  /** Fired when a tool call needs user confirmation before execution. */
  onToolConfirmRequired?: (name: string, label: string, callId: string, args?: ToolArgs) => void;
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
  /** Accumulated completion tokens across all rounds in the current turn. */
  totalCompletionTokens?: number;
  /** Accumulated reasoning tokens across all rounds in the current turn. */
  totalReasoningTokens?: number;
  /**
   * Compaction transformer for this session. Stored here so the cachedSummary
   * inside it survives across multiple pi-agent:prompt calls on the same session.
   * Built once on first use and reused; the signal is updated via abortCtrl each turn.
   */
  compactionTransformer?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  /** Grants made during the current session, never persisted. */
  approvedTools?: Set<string>;
}

export type ApprovalDecision = { approved: boolean; grant?: "session" | "command" };
export const pendingApprovals = new Map<string, { resolve: (decision: ApprovalDecision) => void }>();

function approvalGrantKey(toolName: string, args: ToolArgs): string {
  if (toolName === "bash") return `${toolName}:${typeof args.command === "string" ? args.command : ""}`;
  const target = [args.path, args.noteId, args.cardId, args.title]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return target ? `${toolName}:${target}` : toolName;
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
  "search_notes_semantic",
  "search_tasks_semantic",
  "list_templates",
  "instantiate_template",
  // ── Tasks ───────────────────────────────────────────────────────────────────
  "get_task",
  "create_task",
  "update_task",
  "bulk_update_task_status",
  "search_tasks",
  "list_ready_tasks",
  "list_overdue_tasks",
  "list_tasks_due",
  "link_note_to_task",
  // ── Tags ────────────────────────────────────────────────────────────────────
  "create_tag",
  "tag_note",
  "tag_task",
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
  "list_overdue_tasks", "list_tasks_due",
  "search_notes_semantic",
  "search_tasks_semantic",
  "list_templates",
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
import { getExternalToolDefs, executeExternalTool, isExternalToolName, externalToolLabel } from "./external-tools";

function getAllToolDefs(
  mode: "plan" | "execute" = "execute",
  skills: SkillMeta[] = [],
  externalDefs: typeof ALL_CAIRN_TOOLS = [],
) {
  const cairnSubset = ALL_CAIRN_TOOLS.filter((t) => CAIRN_TOOL_NAMES.has(t.function.name));
  // Only include the skill tool when at least one skill is available
  const skillDef = skills.length > 0 ? [makeSkillToolDefinition(skills)] : [];
  // External tools (MCP servers / custom services) are side-effecting, so they
  // are excluded from plan mode entirely (plan mode is read-only analysis).
  const external = mode === "plan" ? [] : externalDefs;
  const all = [...CODING_TOOL_DEFS, ...skillDef, ...cairnSubset, ...external];
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
  mode: "plan" | "execute",
  allowedToolNames: Set<string>,
): Promise<string> {
  const { cwd, db, req, workspacePath, sessionId, send, getWin: _getWin } = toolCtx;

  // Reject any tool the model hallucinated that wasn't actually offered this
  // turn (defends plan mode's read-only contract and stale external names).
  if (!allowedToolNames.has(name)) {
    throw new Error(`Tool "${name}" is not available in ${mode} mode.`);
  }

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
      // External tools (MCP servers / custom services) — execute mode only,
      // and only when the name was actually offered this turn. executeExternalTool
      // additionally re-validates workspace/project scope + enabled state.
      if (isExternalToolName(name)) {
        if (mode !== "execute") {
          throw new Error(`External tool "${name}" is not available in plan mode.`);
        }
        return executeExternalTool(
          db,
          req.workspaceId ?? "",
          req.projectId ?? "",
          name,
          args as Record<string, unknown>,
        );
      }
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
  /** Usage-log source for this loop's rows — "pi-subagent" for spawned children. */
  usageSource: UsageSource = "pi-agent",
): Promise<void> {
  const { signal } = session.abortCtrl;
  // Assemble external tool defs (MCP servers + custom services) in scope for the
  // session's project. Execute mode only; failures degrade to no external tools.
  let externalDefs: typeof ALL_CAIRN_TOOLS = [];
  if (mode === "execute") {
    try {
      externalDefs = (await getExternalToolDefs(
        toolCtx.db,
        toolCtx.req.workspaceId ?? "",
        toolCtx.req.projectId ?? "",
      )) as typeof ALL_CAIRN_TOOLS;
    } catch (err) {
      console.error("[agent] failed to assemble external tools:", err);
    }
  }
  const allTools = getAllToolDefs(mode, toolCtx.skills ?? [], externalDefs);
  // The exact set of tool names offered to the model this turn — used to reject
  // hallucinated / out-of-mode tool calls before execution.
  const allowedToolNames = new Set(allTools.map((t) => t.function.name));

  const {
    baseUrl, model, apiKey, maxSteps, temperature: configTemp,
    maxRetries    = 3,
    baseRetryDelayMs = 2000,
    contextWindow = 128_000,
  } = llmConfig;

  // Undefined/0 → omit max_tokens (let the model finish naturally).
  const maxTokens = llmConfig.maxTokens && llmConfig.maxTokens > 0 ? llmConfig.maxTokens : undefined;

  // Identity of this request's model — reasoning is round-tripped (pi behaviour)
  // under its native field, but only to the SAME model that produced it.
  const currentModelKey = `${baseUrl}::${model}`;

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
  // Reset per-turn accumulators
  session.totalCompletionTokens = 0;
  session.totalReasoningTokens = 0;

  while (steps < maxSteps) {
    if (signal.aborted) { callbacks.onDone(); return; }
    steps++;
    // From step 2 onwards, signal the renderer to finalise the previous
    // assistant message and start a fresh one for this turn's tokens.
    if (steps > 1) callbacks.onStepStart();

    // Build messages array — apply context pruning, reasoning round-trip, and
    // empty-turn filtering via the shared helper (identical to chat's stream
    // semantics). The system prompt travels as a `systemRole` message — `"system"`
    // by default, or `"developer"` for reasoning models on providers that support
    // it — never a top-level `system:` field. Reasoning round-trips to the SAME
    // model under its native field, and reasoning is kept out of the pruner so
    // compaction summaries can never see chain-of-thought.
    const contextMessages = await prepareContextMessages({
      systemPrompt,
      messages: session.messages,
      currentModelKey,
      systemRole: resolveSystemRole({
        isReasoningModel: llmConfig.isReasoningModel,
        baseUrl,
        provider: llmConfig.provider,
        modelId: model,
      }),
      pruner,
    });

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
        response = await fetch(buildApiUrl(baseUrl, "chat/completions"), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify(buildChatCompletionsBody({
            model,
            messages: contextMessages,
            tools: allTools,
            maxTokens,
            temperature,
          })),
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

    // Shared SSE parse (identical to the chat loop) — reasoning-field capture,
    // finish_reason tracking, tool-call buffering, and pending-chip callIds all
    // live in `consumeAssistantStream` so the two loops cannot drift again.
    let toolsReadyFired = false;
    const turn = await consumeAssistantStream(reader, {
      signal,
      onToken: (delta) => callbacks.onToken(delta),
      onThought: (delta) => callbacks.onThought?.(delta),
      onToolPending: (name, callId) => {
        if (!toolsReadyFired) {
          callbacks.onToolsReady();
          toolsReadyFired = true;
        }
        callbacks.onToolPending(name, callId);
      },
      onUsage: (usage) => {
        const pt = usage.promptTokens;
        const ct = usage.completionTokens;
        const rt = usage.reasoningTokens;
        // Persist one usage row per agent round for the Usage view.
        recordLlmUsage({
          source: usageSource,
          sessionId: toolCtx.sessionId,
          projectId: toolCtx.req.projectId,
          workspaceId: toolCtx.req.workspaceId,
          provider: llmConfig.provider,
          model,
          baseUrl,
          promptTokens: pt,
          completionTokens: ct,
          reasoningTokens: rt,
          costUsd: extractCost(usage.chunkCost, usage.raw),
        });
        session.lastPromptTokens = pt;
        // Accumulate completion + reasoning across rounds (total output for the turn).
        // Prompt tokens are last-round only (= current context window usage).
        session.totalCompletionTokens = (session.totalCompletionTokens ?? 0) + ct;
        session.totalReasoningTokens = (session.totalReasoningTokens ?? 0) + rt;
        let breakdown: TokenBreakdown | undefined;
        try {
          const rawBreakdown = calculatePromptBreakdown(systemPrompt, contextMessages, allTools);
          breakdown = scaleBreakdown(rawBreakdown, pt);
        } catch (err) {
          console.error("[pi-agent] failed to calculate breakdown:", err);
        }
        callbacks.onUsage(pt, session.totalCompletionTokens ?? 0, session.totalReasoningTokens ?? 0, breakdown, extractCost(usage.chunkCost, usage.raw));
      },
    });

    const contentBuffer = turn.content;
    const reasoningBuffer = turn.reasoning;
    const streamCallIds = turn.streamCallIds;
    const turnFinishReason = turn.finishReason;

    // Dev trace: per-tool assembled arguments.
    for (let i = 0; i < turn.toolCalls.length; i++) {
      const tc = turn.toolCalls[i];
      traceTool("sse-args", {
        toolIndex: turn.toolCallIndexes[i],
        toolName: tc.function.name,
        arguments: tc.function.arguments,
      });
    }

    // ── No tool calls → turn complete ─────────────────────────────────────
    if (turn.toolCalls.length === 0) {
      // Reasoning is never baked into `content` (pi behaviour): it is streamed
      // to the ThinkingPanel live and stored in its own field, then
      // round-tripped to the SAME model under its native field (or converted to
      // text cross-model) on the next request.
      session.messages.push({
        role: "assistant",
        content: contentBuffer,
        reasoning: reasoningBuffer || undefined,
        reasoningField: turn.reasoningField ?? undefined,
        reasoningModel: currentModelKey,
      });
      callbacks.onDone();
      return;
    }

    // ── Build tool call list from accumulated buffers ─────────────────────
    const toolCalls: ToolCallSpec[] = turn.toolCalls;

    session.messages.push({
      role: "assistant",
      content: contentBuffer || null,
      reasoning: reasoningBuffer || undefined,
      reasoningField: turn.reasoningField ?? undefined,
      reasoningModel: currentModelKey,
      tool_calls: toolCalls,
    });

    if (!toolsReadyFired) callbacks.onToolsReady();

    // ── Output-token-limit / interrupted-stream truncation guard ──────────
    // Shared with the chat loop. A "length" finish (or a stream that ended
    // without ANY finish_reason — connection cut mid-call) means the tool calls
    // may carry truncated arguments. Refuse to execute them: emit the chip + a
    // structured error so the model re-issues with complete arguments.
    const streamInterrupted = turnFinishReason === null;
    if (turnFinishReason === "length" || streamInterrupted) {
      const toolResults = failToolCallsFromTruncatedMessage(toolCalls, {
        maxTokens,
        error: streamInterrupted ? interruptedStreamToolCallError() : undefined,
        labelFor: (name) => isExternalToolName(name)
          ? externalToolLabel(name, toolCtx.db)
          : (CODING_LABELS[name]?.({}) ?? name),
        callIdFor: (_tc, i) => streamCallIds.get(turn.toolCallIndexes[i] ?? i),
        emitStart: (name, label, callId, args) => callbacks.onToolStart(name, label, callId, args),
        emitEnd: (name, label, ok, output, callId, args) => callbacks.onToolEnd(name, label, ok, output, callId, args),
      });
      for (const tr of toolResults) session.messages.push(tr);
      continue;
    }

    // ── Execute tools in parallel ─────────────────────────────────────────
    if (signal.aborted) { callbacks.onDone(); return; }
    // All tools in a turn fire concurrently. Results are appended to
    // session.messages in original source order regardless of completion order.
    // onToolEnd fires as each tool finishes (may be out of order for UI updates).
    //
    // Concurrency safety differs by tool family:
    //   - Coding-agent file tools (write.ts / edit.ts) serialise same-path
    //     writes via withFileMutex (lib/coding-tools/file-mutex.ts).
    //   - Note tools (ensure_note, bulk_move_notes, rename_note, …) do NOT use
    //     that mutex. They guard the .md ↔ SQLite round-trip with the
    //     mcp_active_writes lock (lockNote/unlockNote) plus the file-watcher's
    //     in-flight / disk-existence checks, so a relocation's old-path unlink
    //     is never mistaken for a delete.

    type ToolOutcome = { tcIdx: number; tc: ToolCallSpec; ok: boolean; resultContent: string; pendingCallId?: string };

    const toolPromises: Promise<ToolOutcome>[] = toolCalls.map(async (tc, tcIdx): Promise<ToolOutcome> => {
      // Parse tool arguments. Never run a tool with destructured args — surface
      // the parse error so the model can re-issue the call.
      let args: ToolArgs;
      let parseError: string | null = null;
      const parsed = parseToolArgs(tc.function.arguments);
      if (parsed.ok) {
        args = parsed.value as ToolArgs;
        traceTool("parse", {
          toolName: tc.function.name,
          title: typeof (args as Record<string, unknown>).title === "string" ? (args as Record<string, unknown>).title as string : "",
          content: typeof (args as Record<string, unknown>).content === "string" ? (args as Record<string, unknown>).content as string : "",
          rawArguments: tc.function.arguments || "",
          repaired: parsed.repaired ? 1 : 0,
        });
      } else {
        parseError = parsed.error;
        args = {};
      }

      const label = isExternalToolName(tc.function.name)
        ? externalToolLabel(tc.function.name, toolCtx.db)
        : (CODING_LABELS[tc.function.name]?.(args) ?? tc.function.name);
      // Map the tool-call array position back to its original stream index
      // (they diverge when the provider emitted non-contiguous indexes), so the
      // chip callId matches the one fired during streaming.
      const pendingCallId = streamCallIds.get(turn.toolCallIndexes[tcIdx] ?? tcIdx);
       callbacks.onToolStart(tc.function.name, label, pendingCallId, args);

      // Yield to the event loop so the IPC layer dispatches the onToolStart event
      // to the renderer before execution begins — this makes the chip appear in
      // "running" state immediately rather than jumping straight to "done".
      // A two-way IPC handshake (renderer acks → loop continues) would be more
      // robust but isn't worth the added complexity here.
      await new Promise<void>((r) => setImmediate(r));

      let resultContent: string = "";
      let ok = true;

      if (parseError) {
        ok = false;
        resultContent = `Error: ${parseError}`;
         callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId, args);
        return { tcIdx, tc, ok, resultContent, pendingCallId };
      }

      if (llmConfig.autoApprove === false) {
        const callKey = pendingCallId || tc.id;
        const grantKey = approvalGrantKey(tc.function.name, args);
        session.approvedTools ??= new Set<string>();
        let decision: ApprovalDecision = { approved: session.approvedTools.has(grantKey) };
        if (!decision.approved) {
          callbacks.onToolConfirmRequired?.(tc.function.name, label, callKey, args);
          decision = await new Promise<ApprovalDecision>((resolve) => {
          const onAbort = () => {
            pendingApprovals.delete(callKey);
            resolve({ approved: false });
          };
          if (signal.aborted) {
            resolve({ approved: false });
            return;
          }
          signal.addEventListener("abort", onAbort);
          pendingApprovals.set(callKey, {
            resolve: (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            }
          });
          });
        }
        if (decision.grant) session.approvedTools.add(grantKey);
        if (!decision.approved) {
          ok = false;
          resultContent = "Blocked: tool call rejected by user";
           callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId, args);
          return { tcIdx, tc, ok, resultContent, pendingCallId };
        }
      }

      try {
        resultContent = await executeSingleTool(
          tc.function.name,
          args,
          signal,
           (output) => callbacks.onToolStart(tc.function.name, `${label}: ${output.slice(-80)}`, pendingCallId, args),
          toolCtx,
          llmConfig,
          mode,
          allowedToolNames,
        );
        // A Cairn tool signals failure by RETURNING { error: … } without throwing
        // (the dominant pattern). Detect it so `ok` — which drives the red/failed
        // chip and the plan-note hook below — reflects reality instead of always
        // reporting success for non-throwing errors.
        if (resultContentError(resultContent) !== undefined) ok = false;
      } catch (e) {
        ok = false;
        resultContent = `Error: ${(e as Error).message}`;
      }

       callbacks.onToolEnd(tc.function.name, label, ok, resultContent, pendingCallId, args);

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
