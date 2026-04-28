/**
 * Cairn — Internal Agent Tool Definitions
 *
 * This module defines the typed interfaces for tools available to the integrated AI chat
 * and the MCP server. Both use the same definitions so tool logic is never duplicated.
 *
 * Tools fall into two categories:
 *   - READ  — safe to call without user confirmation
 *   - WRITE — require explicit user confirmation before execution
 */

import type { Note, TaskCard, Project, BoardColumn } from "@/types";

// ── Shared result envelope ────────────────────

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── Tool input / output types ─────────────────

// search_notes
export interface SearchNotesInput {
  query: string;
  projectId?: string;
  workspaceId?: string;
  limit?: number;
}
export type SearchNotesOutput = Array<{
  id: string;
  title: string;
  snippet: string;
  projectId: string;
  updatedAt: string;
}>;

// search_tasks
export interface SearchTasksInput {
  query: string;
  projectId?: string;
  columnType?: string;
  limit?: number;
}
export type SearchTasksOutput = Array<{
  id: string;
  title: string;
  description?: string;
  columnId: string;
  columnName: string;
  priority: string;
  dueDate?: string;
  projectId: string;
}>;

// get_project_summary
export interface GetProjectSummaryInput {
  projectId: string;
}
export interface GetProjectSummaryOutput {
  project: Pick<Project, "id" | "name" | "description" | "status" | "priority" | "dueDate">;
  noteCount: number;
  totalCards: number;
  cardsByColumn: Array<{ columnName: string; columnType: string; count: number; cards: Pick<TaskCard, "id" | "title" | "priority">[] }>;
  pinnedNotes: Array<Pick<Note, "id" | "title">>;
  recentActivity: Array<{ type: "note" | "card"; id: string; title: string; updatedAt: string }>;
}

// create_note
export interface CreateNoteInput {
  projectId: string;
  title: string;
  content?: string;
}
export type CreateNoteOutput = Pick<Note, "id" | "title" | "createdAt">;

// update_note
export interface UpdateNoteInput {
  noteId: string;
  title?: string;
  contentText?: string;
}
export type UpdateNoteOutput = Pick<Note, "id" | "title" | "updatedAt">;

// create_task
export interface CreateTaskInput {
  columnId: string;
  projectId: string;
  title: string;
  description?: string;
  priority?: string;
  dueDate?: string;
}
export type CreateTaskOutput = Pick<TaskCard, "id" | "title" | "columnId" | "createdAt">;

// update_task_status
export interface UpdateTaskStatusInput {
  cardId: string;
  targetColumnId: string;
}
export type UpdateTaskStatusOutput = Pick<TaskCard, "id" | "title" | "columnId" | "updatedAt">;

// link_note_to_task
export interface LinkNoteToTaskInput {
  noteId: string;
  cardId: string;
}
export interface LinkNoteToTaskOutput {
  noteId: string;
  cardId: string;
  linked: boolean;
}

// list_recent_activity
export interface ListRecentActivityInput {
  workspaceId: string;
  projectId?: string;
  limit?: number;
}
export type ListRecentActivityOutput = Array<{
  type: "note" | "card";
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  action: "created" | "updated";
  at: string;
}>;

// ── Tool registry ─────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "search_notes",
    description: "Search notes by query string. Searches title and content.",
    category: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        projectId: { type: "string", description: "Optional: filter by project ID" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_tasks",
    description: "Search task cards by query string, optionally filtered by project or column type.",
    category: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        projectId: { type: "string", description: "Optional: filter by project ID" },
        columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Optional: filter by column type" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_project_summary",
    description: "Get a comprehensive summary of a project including card counts by column, pinned notes, and recent activity.",
    category: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "list_recent_activity",
    description: "List recently created or updated notes and tasks in a workspace or project.",
    category: "read" as const,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        projectId: { type: "string", description: "Optional: filter by project" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note in a project. Requires user confirmation.",
    category: "write" as const,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        title: { type: "string", description: "Note title" },
        content: { type: "string", description: "Optional plain text content" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "update_note",
    description: "Update the title or content of an existing note. Requires user confirmation.",
    category: "write" as const,
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID" },
        title: { type: "string", description: "New title (optional)" },
        contentText: { type: "string", description: "New plain text content (optional)" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task card in a board column. Requires user confirmation.",
    category: "write" as const,
    inputSchema: {
      type: "object",
      properties: {
        columnId: { type: "string", description: "Column ID" },
        projectId: { type: "string", description: "Project ID" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Optional description" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority level" },
        dueDate: { type: "string", description: "Due date (ISO date string)" },
      },
      required: ["columnId", "projectId", "title"],
    },
  },
  {
    name: "update_task_status",
    description: "Move a task card to a different column. Requires user confirmation.",
    category: "write" as const,
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "Task card ID" },
        targetColumnId: { type: "string", description: "Target column ID" },
      },
      required: ["cardId", "targetColumnId"],
    },
  },
  {
    name: "link_note_to_task",
    description: "Create a bidirectional link between a note and a task card. Requires user confirmation.",
    category: "write" as const,
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID" },
        cardId: { type: "string", description: "Task card ID" },
      },
      required: ["noteId", "cardId"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

/** Returns tool definitions formatted for OpenAI function calling */
export function getOpenAITools(category?: "read" | "write" | "all") {
  return TOOL_DEFINITIONS
    .filter((t) => !category || category === "all" || t.category === category)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
}
