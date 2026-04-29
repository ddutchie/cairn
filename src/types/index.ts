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
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
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
  order: number;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ── Chat ──────────────────────────────────────
export type ChatThreadScope = "workspace" | "project";

export interface ChatThread {
  id: ID;
  scope: ChatThreadScope;
  workspaceId: ID;
  projectId?: ID;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "system";

export interface LinkedContextReference {
  type: "note" | "task" | "project" | "search_result";
  id: ID;
  title: string;
  snippet?: string;
}

export interface ChatMessage {
  id: ID;
  threadId: ID;
  role: ChatRole;
  content: string;
  /** Entities cited in or used to produce this message */
  contextRefs?: LinkedContextReference[];
  /** If this message triggered a write action */
  pendingAction?: PendingAction;
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

// ── App UI State (not persisted) ──────────────
export interface AppUIState {
  activeWorkspaceId: ID | null;
  activeProjectId: ID | null;
  activeView: "overview" | "notes" | "board" | "chat" | "search" | "settings";
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  searchOpen: boolean;
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
