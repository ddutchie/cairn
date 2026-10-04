/** App UI state, shared tool return types and the dashboard postMessage bridge. */

import type { ID } from "../../shared/types/domain";

// ── App UI State (not persisted) ──────────────
/** Deep-linkable Settings view sections. */
export type SettingsSection =
  | "general"
  | "ai"
  | "embeddings"
  | "agents"
  | "tools"
  | "commands"
  | "writing-style"
  | "plugins"
  | "mobile"
  | "sync"
  | "data"
  | "about"
  | "shortcuts"
  | "tags"
  | "extensions"
  | "system";

export interface AppUIState {
  activeWorkspaceId: ID | null;
  activeProjectId: ID | null;
  activeView: "overview" | "notes" | "board" | "flow" | "calendar" | "calendar-all" | "graph" | "insights" | "automations" | "usage" | "chat" | "search" | "settings" | "agent";
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  searchOpen: boolean;
  activePreviewItem: { type: "note" | "task"; id: ID } | null;
  chatPanelResizing: boolean;
  lastContentView: "overview" | "notes" | "board" | "flow" | "calendar" | "calendar-all" | "graph" | "insights" | "automations" | "usage" | "settings" | "agent";
  seenFeatures: string[];
  tutorialActive: boolean;
  tutorialStepIndex: number;
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
