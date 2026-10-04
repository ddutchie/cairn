/** Agent messages, coding sessions and user writing style. */

import type { TokenBreakdown, MessageStats } from "./chat";

// ── Agent message + session types ────────────────────────────────────────────
// Moved here from store/slices/terminal-sessions.ts (P5-1 of the cleanup plan)
// so all domain types live in one place. The slice re-exports them for backwards
// compatibility.

export interface AgentSubagentMessage {
  /** Unique child session ID */
  childSessionId: string;
  /** Messages streamed by the subagent */
  messages: AgentMessage[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the parent */
  result?: string;
  /** Latest token usage from the subagent's LLM steps */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
}

/** One item in the agent session's todo list (todowrite tool). */
export interface SessionTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  /** Inline base64 attachment thumbnails (user messages), same shape as ChatMessage.images. */
  images?: Array<{ url: string; name: string; kind?: "image" | "pdf" }>;
  /** Same semantics as {@link ChatMessage.reasoning}. */
  reasoning?: string;
  /** Tool calls that occurred before or during this assistant message */
  toolCalls?: {
    callId: string;
    name: string;
    label: string;
    /** Tool-authored title from dsh `presentCall` (main-attached on tool/call). */
    viewTitle?: string;
    /** Tool-authored result view from dsh `presentResult` (main-attached on tool/result). */
    resultView?: { card?: string; title?: string; output?: string; exitCode?: number; signal?: string; content?: unknown };
    args?: Record<string, unknown>;
    running: boolean;
    ok: boolean;
    output?: string;
    cairnRef?: { type: "note" | "task"; id: string; title: string };
    confirmRequired?: boolean;
    /**
     * Per-ask nonce minted main-side and echoed back on the session runtime's
     * respond-tool event.
     * Prevents a compromised renderer from approving asks it never saw the
     * push for. Present when confirmRequired is true; cleared on settle.
     */
    approvalNonce?: string;
    /** Why the pending ask exists when it is not the plain tool gate (e.g. a sandbox escalation). */
    approvalReason?: string;
  }[];
  subagents?: AgentSubagentMessage[];
  isStreaming?: boolean;
  /** Per-turn throughput/latency stats (TTFT, tok/s, output tokens) from the session log. */
  stats?: MessageStats;
  timestamp: string;
}

export interface TerminalSession {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  projectId: string;
  cwd?: string;
  status: "running" | "exited";
  exitCode: number | null;
  spawnedAt: string;
  sessionType: "pty" | "coding";
  messages?: AgentMessage[];
  initialPrompt?: string;
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  mode?: "plan" | "execute";
  /** Session persona — "automation-dev" restricts the toolset to file tools. */
  role?: "default" | "automation-dev";
  planNoteId?: string;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`,
   * hydrated from the DB on session load. Preferred over planNoteId for the
   * plan-review card in plan mode and for the PlanTaskList in execute mode.
   */
  planContent?: string;
  /** Explicit plan approval choice for this session, if one was made. */
  autoApprove?: boolean;
}

export interface CodingSessionSummary {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`
   * for this session (persisted by the coding-plugin's tool/call handler).
   * NULL when the session never called exit_plan_mode; sessions that used
   * the legacy PRD-note flow only will have planNoteId set instead.
   */
  planContent: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
}

// ── User writing style ──────────────────────
// Persona + full style guide + condensed cheat sheet, stored in the single-row
// `user_style` table and surfaced via the get_user_writing_style tool.

export type UserStyleSource = "none" | "guided" | "manual" | "analyzed";

export interface UserStylePersona {
  name?: string;
  role?: string;
  context?: string;
  audiences?: string;
}

export interface UserStyleRow {
  id: string;
  persona: UserStylePersona | null;
  /** The long, section-structured writing style guide (markdown). */
  fullGuide: string;
  /** The condensed one-page cheat sheet (markdown). */
  cheatsheet: string;
  /** How the guide was produced: guided wizard / manual / analyzed / none. */
  source: UserStyleSource;
  updatedAt: string;
}

export interface UserStyleSaveInput {
  persona?: UserStylePersona;
  fullGuide?: string;
  cheatsheet?: string;
  source: UserStyleSource;
}
