/**
 * Wire shapes of the agent session runtime (Cordis): replayed transcripts,
 * usage/stats, context ring, subagent catalog, goal, feedback, schedules,
 * permissions and pending asks. Plain data shared by the Electron main
 * process, the typed IPC contract (`shared/ipc/contract.ts`) and the renderer.
 * The modules that produce them (electron/cordis/*) re-export these names.
 */

/** Phase of a session goal (mirrors `@deepseek-ai/dsh-goal`'s GoalPhase). */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/** Folded reasoning-provenance state ("whose thinking is in context"). */
export interface ContextRingState {
  /** `provider::model` the next request targets. */
  currentModel: string | null;
  byModel: Record<string, {
    turns: number;
    reasoningBlocks: number;
    reasoningChars: number;
    replayedBlocks: number;
    degradedBlocks: number;
  }>;
}

/** `{ ok }` result used by the session-control channels (subagent:*, session:goal, …). */
export type ControlResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

// ── from context-usage.ts ────────────────────────────────────────────

export interface SessionUsageBreakdown {
  systemPrompt: number;
  tools: number;
  skills: number;
  toolOutputs: number;
  conversation: number;
}

export interface SessionUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  contextLimit?: number;
  contextWindow?: number;
  breakdown?: SessionUsageBreakdown;
}

// ── from session-stats.ts ────────────────────────────────────────────

export interface SessionStatsTotals {
  /** Distinct turns with ≥1 closed step. */
  turns: number;
  /** Closed steps. */
  steps: number;
  /** Summed model wall time over message-assembling steps, ms. */
  llmMs: number;
  /** Summed matched tool call→result wall time, ms. */
  toolMs: number;
  /** Summed first-token latency over ttftSteps, ms. */
  ttftMs: number;
  /** Steps carrying a recorded first token. */
  ttftSteps: number;
  /** Summed decode wall time over usage-reporting steps, ms. */
  decodeMs: number;
  /** Summed provider output tokens over the same steps. */
  decodeTokens: number;
}

/** Per-turn latency/throughput reading for a single assistant bubble. */
export interface TurnStats {
  /** First-step TTFT in ms (absent when unrecorded). */
  ttftMs?: number;
  /** Decode throughput (output tokens / decode seconds) over usage-reporting steps. */
  tokensPerSecond?: number;
  /** Summed provider output tokens across the turn's usage-reporting steps. */
  outputTokens?: number;
}

export interface SessionStats {
  totals: SessionStatsTotals;
  /** turn number → per-turn metrics (turns with no derivable metric are absent). */
  byTurn: Record<number, TurnStats>;
  /** Session aggregate throughput (decodeTokens / decodeMs), for the composer line. */
  tokensPerSecond?: number;
}

/**
 * Upstream `sessionStats` wire view: the 8 whole-log totals served through
 * the session-projection seam. No per-turn state — see the module header.
 */
export interface SessionStatsSnapshot {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

// ── from run-cordis-loop.ts ──────────────────────────────────────────

export interface ContextRingResult {
  available: boolean;
  ring?: {
    currentModel: string | null;
    byModel: Record<string, { turns: number; reasoningBlocks: number; reasoningChars: number; replayedBlocks: number; degradedBlocks: number }>;
  };
}

// ── from context-ring.ts ─────────────────────────────────────────────

// ── Session folds (reasoning provenance, todos) ──────────────────────────────────────────

export interface SessionTodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

// ── from subagent-control.ts ─────────────────────────────────────────

export type SubagentChildMode = "one-shot" | "continuable";

export type SubagentChildActivity = "running" | "inactive";

/** Listing breadth for the human catalog. `children` = direct children only;
 *  `descendants` = the full session-backed subtree (dsh `listDescendants`). */
export type SubagentScope = "children" | "descendants";

export interface SubagentChildView {
  id: string;
  mode: SubagentChildMode;
  label?: string;
  activity: SubagentChildActivity;
  /** Exact agent live in this process right now (running or idle). */
  live: boolean;
  hasChildren: boolean;
  /** Descendants scope only: durable direct parent of this candidate. */
  parentId?: string;
  /** Descendants scope only: edge distance from the requested root (direct children are 1). */
  depth?: number;
}

export interface SubagentDiagnosticView {
  kind: "diagnostic";
  id: string;
  reason: "corrupt" | "unsupported" | "unavailable";
}

export type SubagentCatalogEntry = SubagentChildView | SubagentDiagnosticView;

export interface SubagentCatalogView {
  entries: SubagentCatalogEntry[];
  /** Whether the exact parent agent is live (host messaging possible). */
  parentAvailable: boolean;
}

export type SubagentControlCode =
  | "parent-unavailable"
  | "not-resumable"
  | "unauthorized"
  | "delivery-unavailable"
  | "attachment-invalid"
  | "bad-request"
  | "cancelled"
  | "internal";

// ── from session-replay.ts ───────────────────────────────────────────

export interface ReplayToolCall {
  tool: string;
  label: string;
  callId?: string;
  args?: string;
  output?: string;
  ok?: boolean;
  error?: string;
  cairnRef?: { type: "note" | "task"; id: string; title: string };
  /** presentationMeta persisted on the tool/result event (dsh writes it at
   *  event.data.meta). Rich toolviews (dsh-visualize) render their card from
   *  this; absent → generic text rendering. */
  meta?: Record<string, unknown>;
}

/** A UI-agnostic replayed message (both chat + coding session map from this). */
export interface ReplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  reasoningSummary?: string;
  reasoningItems?: Array<Record<string, unknown>>;
  reasoningModel?: string;
  toolCalls?: ReplayToolCall[];
  /** Per-turn throughput/latency (TTFT, tok/s, output tokens) — assistant only,
   *  when derivable from the session log. Attached in loadSessionMessages. */
  stats?: TurnStats;
}

/** A replayed subagent trace (child session). */
export interface ReplaySubagent {
  childId: string;
  role: string;
  instruction: string;
  content: string;
  reasoning?: string;
  toolCalls?: ReplayToolCall[];
  running: false;
  result?: string;
}

/**
 * Given a persistence backend + a parent session id, load the parent's derived
 * messages and any subagent children (origin==='subagent', parentSession===id),
 * returning the collapsed messages with the most-recent subagent attached to the
 * dispatching assistant. Shared by chat + coding session load paths.
 */
export interface LoadSessionMessagesResult {
  messages: ReplayMessage[];
  subagents: ReplaySubagent[];
  usage?: SessionUsageMetrics;
  contextRing?: ContextRingState;
  todos?: SessionTodoItem[];
  /** Whole-session throughput/latency aggregate (for the composer stats line). */
  stats?: SessionStats;
  /** Latest folded session title (chat-only, null before first eligible title). */
  title?: string | null;
}

// ── from goal-bridge.ts ──────────────────────────────────────────────

/** Renderer-safe goal summary (durable projection view — no activation). */
export interface GoalWire {
  id: string;
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: { code: string; message: string };
  roundsStarted: number;
  maxGoalRounds: number;
  createdAt: number;
  updatedAt: number;
}

// ── from message-feedback.ts ─────────────────────────────────────────

export type MessageFeedbackRating = "positive" | "negative";

export interface MessageFeedbackItemWire {
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}

export interface PutMessageFeedbackInput {
  sessionId: string;
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
}

// ── from schedule-read.ts ────────────────────────────────────────────

/** Renderer-safe reminder summary (schedule_list view subset). */
export interface ScheduleWire {
  id: string;
  prompt: string;
  scheduledAt: string;
  kind: string;
  state: "scheduled" | "overdue";
}

// ── from permissions-bridge.ts ───────────────────────────────────────

/** One preset row in the permissions select. */
export interface PermissionsOption {
  value: string;
  name: string;
  description?: string;
}

/** Renderer-safe `permissions` select view (mirrors the upstream wire view). */
export interface PermissionsSelect {
  options: PermissionsOption[];
  currentValue: string;
}

// ── from approval-grants.ts ──────────────────────────────────────────

/** One outstanding HITL prompt, enough to re-surface it after a renderer reload. */
export interface PendingAskMeta {
  sessionId: string;
  name: string;
  label: string;
  callId: string;
  /**
   * Per-ask random nonce minted when the ask was emitted. The renderer must
   * echo it back on session:respond-tool — a compromised page / UI plugin
   * that only saw the callId can't approve because it never received the
   * nonce. Absent on legacy sites; the verify path fail-closes when the
   * expected nonce is missing.
   */
  nonce?: string;
  /** dsh's reason for a sandbox escalation ask; undefined for ordinary tool asks. */
  reason?: string;
  /** True for sandbox escalations — one-shot only, never mint a standing grant. */
  escalation?: boolean;
}

// ── from pending-question-broker.ts ──────────────────────────────────

export interface PendingQuestionRecord {
  sessionId: string;
  callId: string;
  questions: Array<{ id: string; [key: string]: unknown }>;
}

// ── from sessions-queries.ts ─────────────────────────────────────────────
// ── Coding Agent Sessions ───────────────────────────────────────────────────────────────

export interface CodingSessionRow {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  /**
   * The last plan the agent committed via dsh-plan-mode's `exit_plan_mode`
   * tool for this session. Cached so the execute-mode system prompt can
   * carry the approved plan forward without folding the entire session log.
   * NULL when the session never called exit_plan_mode.
   */
  planContent: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
  role: "default" | "automation-dev";
}

// ── Coding Agent Session Todos ─────────────────────────────────────────────────

export interface SessionTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

// ── IPC payloads ─────────────────────────────────────────────────────────
/** A coding-session transcript message as `db:session:messages` returns it. */
export interface AgentSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  toolCalls: Array<{
    callId?: string;
    name: string;
    label: string;
    args?: string;
    output?: string;
    ok: boolean;
    running: false;
  }> | null;
  subagents: ReplaySubagent[] | null;
  stats: TurnStats | null;
  /** Empty: replay doesn't keep event timestamps (the renderer omits the label). */
  timestamp: string;
}

/** What a session-log load returns alongside the messages (all optional for a new session). */
export interface SessionLoadExtras {
  usage?: SessionUsageMetrics;
  contextRing?: ContextRingState;
  todos?: SessionTodoItem[];
  stats?: SessionStats;
}

/** `session:is-running`: loop state plus the asks a reload may have missed. */
export interface SessionRunningState {
  running: boolean;
  pendingAsks: PendingAskMeta[];
  /** Outstanding ask_questions / plan-review asks. */
  pendingQuestions: Array<{ callId: string; questions: PendingQuestionRecord["questions"]; nonce?: string }>;
}

export interface CodingSessionCreateInput {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId?: string | null;
  cwd: string;
  mode: "plan" | "execute";
  spawnedAt: string;
  role?: "default" | "automation-dev";
}
