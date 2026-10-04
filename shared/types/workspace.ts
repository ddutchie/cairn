/**
 * Workspaces, projects, tags and slash commands — shared by the renderer, the
 * Electron main process and the typed IPC contract (`shared/ipc/contract.ts`).
 *
 * Optional string fields arrive as `null` (not absent) when the column is
 * NULL: the mappers pass SQLite values through so JSON consumers (mobile
 * bridge, change feed) still see an explicit clear. Test them with `!= null`
 * or truthiness, never `=== undefined`.
 */

import type { ID, ProjectStatus, Priority } from "./domain";

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

// ── IPC inputs ────────────────────────────────
export interface WorkspaceCreateInput {
  id: ID;
  name: string;
  description?: string;
  icon?: string;
}

export type WorkspacePatch = Partial<Pick<Workspace, "name" | "description" | "icon">>;

export interface ProjectCreateInput {
  id: ID;
  workspaceId: ID;
  name: string;
  description?: string;
  icon?: string;
  status?: ProjectStatus;
  priority?: Priority;
  /** Also create the default board columns (in the same transaction). */
  withDefaultColumns?: boolean;
}

export type ProjectPatch = Partial<{
  name: string;
  description: string;
  icon: string;
  status: ProjectStatus;
  priority: Priority;
  dueDate: string;
  tagIds: ID[];
  archivedAt: string;
  codeDirectory: string | null;
}>;

export interface TagCreateInput {
  id: ID;
  workspaceId: ID;
  name: string;
  color: string;
}

export type TagPatch = Partial<Pick<Tag, "name" | "color">>;

/** A note repointed by a project merge (for .md relocation). */
export interface MergedNoteMove {
  id: ID;
  type: string;
  folder: string;
}

export interface ProjectMergeResult {
  /** Notes repointed from source → target. */
  movedNotes: MergedNoteMove[];
  /** Source project name (its on-disk notes folder is removed). */
  sourceName: string;
  /** Target project name (destination folder). */
  targetName: string;
  counts: { notes: number; cards: number; columns: number; flowNodes: number };
}
