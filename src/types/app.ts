/** App UI state and shared tool return types. */

import type { ID } from "../../shared/types/domain";

// ── App UI State (not persisted) ──────────────
/** Deep-linkable Settings view sections. "ai" is the Chat page and "agents"
 *  the Coding agent page; "extensions" and "system" are legacy ids from the
 *  old tabbed layout and land on Tools and Shortcuts. */
export type SettingsSection =
  | "general"
  | "views"
  | "tags"
  | "shortcuts"
  | "models"
  | "ai"
  | "agents"
  | "writing-style"
  | "embeddings"
  | "tools"
  | "commands"
  | "mcp"
  | "sync"
  | "data"
  | "about"
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
