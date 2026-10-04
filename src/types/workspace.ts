/** Workspaces, projects, tags and slash commands. */

import type { ID, ProjectStatus, Priority } from "../../shared/types/domain";

// ── Tags ──────────────────────────────────────
export interface Tag {
  id: ID;
  name: string;
  color: string; // hex or tailwind color token
  workspaceId: ID;
}

// ── Slash commands ────────────────────────────
/** Which input pane(s) a slash command appears in. */
export type SlashCommandScope = "chat" | "agent" | "both";

/** Where a slash command came from. Built-ins are code constants, not rows. */
export type SlashCommandSource = "builtin" | "custom" | "community";

/**
 * A workspace-global, user-defined (or community-installed) slash command.
 * Persisted in the `slash_commands` table. Built-in commands are represented at
 * runtime with the same shape (source: "builtin") but are NOT stored in the DB.
 */
export interface CustomSlashCommand {
  id: ID;
  workspaceId: ID;
  name: string;
  description: string;
  /** Text inserted into the input when the command is chosen. */
  insertText: string;
  scope: SlashCommandScope;
  source: SlashCommandSource;
  /** Provenance link back to a cairn-community manifest entry, if installed. */
  communityId?: string;
  createdAt: string;
  updatedAt: string;
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
