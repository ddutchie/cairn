// ─────────────────────────────────────────────
// Cairn — Core Domain Types
// ─────────────────────────────────────────────

export type ID = string;

// ── Tags ──────────────────────────────────────
export interface Tag {
  id: ID;
  name: string;
  color: string; // hex or tailwind color token
  workspaceId: ID;
}

// ── Workspace ─────────────────────────────────
export interface Workspace {
  id: ID;
  name: string;
  description?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ── Project ───────────────────────────────────
export type ProjectStatus = "active" | "on_hold" | "completed" | "archived";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface ProjectSettings {
  prTemplate?: string;
  defaultBranch?: string;
  autoStageOnCommit?: boolean;
  useRepoPrTemplate?: boolean;
}

export interface Project {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  icon?: string;
  status: ProjectStatus;
  priority: Priority;
  dueDate?: string;
  tagIds: ID[];
  codeDirectory: string | null;
  projectSettings?: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ── Note ─────────────────────────────────────
export type NoteType = "note" | "dashboard";

export interface Note {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  /** Raw markdown (type=note) or HTML string (type=dashboard) */
  content: string;
  /** Plain-text representation for search (markdown stripped) */
  contentText: string;
  tagIds: ID[];
  /** Backlink references: note IDs this note mentions */
  linkedNoteIds: ID[];
  /** Task cards this note is linked to */
  linkedCardIds: ID[];
  isPinned: boolean;
  type: NoteType;
  /**
   * Slash-separated subfolder path within the project notes directory.
   * Empty string means the note is in the project root.
   * e.g. "Design/Typography" → notes/<project-slug>/design/typography/<note>.md
   */
  folder: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Monotonically incrementing write counter. Used for optimistic-concurrency
   * checks by MCP tools that accept an optional expectedVersion argument. */
  version: number;
}

// ── Board Column ──────────────────────────────
export type ColumnType = "backlog" | "todo" | "in_progress" | "review" | "done" | "custom";

export interface BoardColumn {
  id: ID;
  projectId: ID;
  workspaceId: ID;
  name: string;
  type: ColumnType;
  order: number;
  cardLimit?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Task Card ─────────────────────────────────
export interface TaskCard {
  id: ID;
  columnId: ID;
  projectId: ID;
  workspaceId: ID;
  title: string;
  description?: string;
  tagIds: ID[];
  priority: Priority;
  dueDate?: string;
  /** Note IDs this card is linked to */
  linkedNoteIds: ID[];
  /** Card IDs (same project) that block this card from being started */
  blockedByIds: ID[];
  order: number;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Monotonically incrementing write counter for optimistic concurrency. */
  version: number;
}

// ── Chat ──────────────────────────────────────
export type ChatThreadScope = "workspace" | "project";

export interface TokenBreakdown {
  systemPrompt: number;
  skills: number;
  tools: number;
  conversation: number;
  toolOutputs: number;
  rules: number;
  mcp: number;
  subagentDefinitions: number;
}

export interface ChatThread {
  id: ID;
  scope: ChatThreadScope;
  workspaceId: ID;
  projectId?: ID;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastUsage?: {
    promptTokens: number;
    completionTokens: number;
    /** Subset of completion_tokens produced by the model's reasoning/thinking step. 0 if the model didn't split. */
    reasoningTokens?: number;
    breakdown?: TokenBreakdown;
  };
}

export type ChatRole = "user" | "assistant" | "system";

/**
 * Streaming token-usage shape mirrored from the OpenAI chat/completions spec.
 * `reasoningTokens` is the subset of `completionTokens` spent on chain-of-thought
 * reasoning; absent when the model doesn't split reasoning from content.
 */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  reasoningTokens?: number;
  breakdown?: TokenBreakdown;
}

export interface LinkedContextReference {
  type: "note" | "task" | "project" | "search_result";
  id: ID;
  title: string;
  snippet?: string;
}

export interface ChatToolCallRecord {
  tool: string;
  label: string;
  cairnRef?: { type: "note" | "task"; id: ID; title: string };
}

export type SuggestedAction =
  | { type: "add_wikilink";   sourceNoteId: string; sourceTitle: string; targetTitle: string; reason: string }
  | { type: "link_note_note"; sourceNoteId: string; sourceTitle: string; targetNoteId: string; targetTitle: string; reason: string }
  | { type: "link_note_card"; noteId: string; noteTitle: string; cardId: string; cardTitle: string; reason: string }
  | { type: "add_tag";        nodeId: string; nodeTitle: string; nodeType: "note" | "card"; tagName: string; reason: string };

export interface ChatMessage {
  id: ID;
  threadId: ID;
  role: ChatRole;
  content: string;
  /**
   * Reasoning / thinking text emitted by the model during generation (Claude's
   * thinking_delta, OpenAI-style delta.reasoning). Persisted so past messages
   * retain an expandable Thinking panel in the bubble; intentionally stripped
   * from compaction summaries. Empty for models that don't expose reasoning.
   */
  reasoning?: string;
  /** Entities cited in or used to produce this message */
  contextRefs?: LinkedContextReference[];
  /** Tool calls made during this assistant turn — persisted so they remain visible after streaming ends */
  toolCalls?: ChatToolCallRecord[];
  /** If this message triggered a write action */
  pendingAction?: PendingAction;
  /** Suggested connection actions for graph assistant */
  actions?: SuggestedAction[];
  /** Images attached to this message — inline base64 data URLs, ephemeral (not persisted to disk) */
  images?: Array<{ url: string; name: string }>;
  createdAt: string;
}

// ── Agent Action Model ────────────────────────
export type ActionType =
  | "create_note"
  | "update_note"
  | "create_task"
  | "update_task_status"
  | "link_note_to_task"
  | "move_task";

export type ActionStatus = "pending" | "confirmed" | "rejected";

export interface PendingAction {
  id: ID;
  type: ActionType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
  status: ActionStatus;
  createdAt: string;
}

// ── Idea Flow ────────────────────────────────
export type IdeaNodeType = "idea" | "note_ref" | "task_ref" | "url" | "ai_summary" | "group";

export interface IdeaNodeDataMap {
  idea:       { title: string; body?: string };
  note_ref:   { noteId: string };
  task_ref:   { cardId: string };
  url:        { url: string; title?: string; description?: string };
  ai_summary: { content: string };
  group:      { label?: string; color?: string };
}

/** Raw node as stored in / returned from the DB (data is opaque JSON). */
export interface IdeaFlowNode {
  id: ID;
  flowId: ID;
  type: IdeaNodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaFlowEdge {
  id: ID;
  flowId: ID;
  sourceNodeId: ID;
  targetNodeId: ID;
  label?: string;
  createdAt: string;
}

export interface IdeaFlow {
  id: ID;
  projectId: ID;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolved graph returned to the renderer and AI/MCP.
 * note_ref and task_ref nodes have their linked entity's data merged in.
 */
export interface ResolvedIdeaFlowNode extends IdeaFlowNode {
  // Absolute canvas position (group children store relative x/y in DB)
  absoluteX: number;
  absoluteY: number;
  // For note_ref: title + snippet from the linked note
  resolvedTitle?: string;
  resolvedSnippet?: string;
  // For task_ref: title + priority + column name from the linked card
  resolvedPriority?: string;
  resolvedColumnName?: string;
}

export interface ResolvedIdeaFlow {
  flowId: ID;
  projectId: ID;
  nodes: ResolvedIdeaFlowNode[];
  edges: IdeaFlowEdge[];
  spatial: {
    bounds: { x: number; y: number; width: number; height: number } | null;
    nextPosition: { x: number; y: number };
    groupSlots: Record<string, { x: number; y: number }>;
  };
}

// ── Knowledge Graph ───────────────────────────

export type GraphNodeType = "project" | "note" | "card" | "tag";

export type GraphEdgeType =
  | "note-note" | "note-card" | "tag-member" | "project-member"
  | "flow-ref" | "flow-edge" | "co-mention" | "keyword" | "assignee"
  | "wikilink" | "semantic";

export interface GraphNode {
  id: ID;
  type: GraphNodeType;
  title: string;
  projectId?: ID;
  workspaceId: string;
  meta?: {
    status?: string;
    priority?: string;
    assignee?: string;
    tagIds?: string[];
    isPinned?: boolean;
    snippet?: string;
    color?: string;
    isArchived?: boolean;
  };
}

export interface GraphEdge {
  id: ID;
  source: ID;
  target: ID;
  type: GraphEdgeType;
  label?: string;
  weight?: number;
  sourceSectionTitle?: string;
  targetSectionTitle?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphLayoutMode = "force" | "radial";

export interface GraphFilters {
  projectIds: string[];
  nodeTypes: GraphNodeType[];
  edgeTypes: GraphEdgeType[];
  includeAuto: boolean;
}

// ── App UI State (not persisted) ──────────────
export interface AppUIState {
  activeWorkspaceId: ID | null;
  activeProjectId: ID | null;
  activeView: "overview" | "notes" | "board" | "flow" | "graph" | "insights" | "chat" | "search" | "settings" | "agent";
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  searchOpen: boolean;
}

// ── MCP / Chat Tool Shared Return Types ──────────

// ── Dashboard postMessage Bridge Types ───────────

/** Message sent from the dashboard iframe to the parent window. */
export type DashboardQueryMessage =
  | { type: "cairn:query"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "cairn:error"; message: string; source?: string; line?: number; col?: number; stack?: string }
  | { type: "cairn:ready" }
  | { type: "cairn:refresh" };

/** Message sent from the parent window to the dashboard iframe. */
export interface DashboardResponseMessage {
  type: "cairn:response";
  id: string;
  result?: unknown;
  error?: string;
}

/** Canonical shape returned by get_project_summary across all call sites. */
export interface ProjectSummaryColumn {
  columnName: string;
  columnType: string;
  count: number;
  cards: Array<{ id: string; title: string; priority: string; dueDate?: string | null }>;
}

export interface ProjectSummaryResult {
  project: { id: string; name: string; description?: string; status: string; priority: string; dueDate?: string | null };
  noteCount: number;
  totalCards: number;
  cardsByColumn: ProjectSummaryColumn[];
  pinnedNotes: Array<{ id: string; title: string }>;
  recentActivity: Array<{ type: "note" | "card"; id: string; title: string; updatedAt: string }>;
}

/** Wrapper for IPC handler return values — either a result or an error. */
export type IpcResult<T> = T | { error: string };

/** Type guard — returns true if the IPC result is an error object. */
export function isIpcError<T>(result: IpcResult<T>): result is { error: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as { error: unknown }).error === "string"
  );
}

// ── Pi Agent message + session types ─────────────────────────────────────────
// Moved here from store/slices/terminal-sessions.ts (P5-1 of the cleanup plan)
// so all domain types live in one place. The slice re-exports them for backwards
// compatibility.

export interface PiSubagentMessage {
  /** Unique child session ID */
  childSessionId: string;
  /** Messages streamed by the subagent */
  messages: PiAgentMessage[];
  /** Whether the subagent is still running */
  running: boolean;
  /** Final result returned to the parent */
  result?: string;
  /** Latest token usage from the subagent's LLM steps */
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown };
}

export interface PiAgentMessage {
  id: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  /** Same semantics as {@link ChatMessage.reasoning}. */
  reasoning?: string;
  /** Tool calls that occurred before or during this assistant message */
  toolCalls?: {
    callId: string;
    name: string;
    label: string;
    running: boolean;
    ok: boolean;
    output?: string;
    cairnRef?: { type: "note" | "task"; id: string; title: string };
    confirmRequired?: boolean;
  }[];
  subagents?: PiSubagentMessage[];
  isStreaming?: boolean;
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
  sessionType: "pty" | "pi";
  piMessages?: PiAgentMessage[];
  initialPrompt?: string;
  lastUsage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: TokenBreakdown };
  mode?: "plan" | "execute";
  planNoteId?: string;
}

export interface PiSessionSummary {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
}
