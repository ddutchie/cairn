/**
 * Chat tools — executed locally against the mobile expo-sqlite DB.
 *
 * The AI (via the prompt-based tool protocol in agent.ts) emits a tool call as
 * JSON; we run the matching executor here. Writes go through queries.ts (plain
 * SQL) so the capture triggers stage them for sync — anything the AI changes
 * propagates to the desktop, which projects note edits to .md.
 */

import * as q from "@/db/queries";

export interface ToolDef {
  name: string;
  description: string;
  params: string; // human-readable param hint for the prompt
  run: (args: Record<string, unknown>) => unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export const TOOLS: ToolDef[] = [
  {
    name: "list_projects",
    description: "List all projects (id, name).",
    params: "{}",
    run: () => q.listProjects().map((p) => ({ id: p.id, name: p.name })),
  },
  {
    name: "search_notes",
    description: "Search notes by text. Returns id, title, folder, project_id.",
    params: '{ "query": string }',
    run: (a) =>
      q.searchNotes(str(a.query)).map((n) => ({ id: n.id, title: n.title, folder: n.folder, project_id: n.project_id })),
  },
  {
    name: "list_notes",
    description: "List notes in a project. Returns id, title, folder.",
    params: '{ "project_id": string }',
    run: (a) => q.listNotes(str(a.project_id)).map((n) => ({ id: n.id, title: n.title, folder: n.folder })),
  },
  {
    name: "get_note",
    description: "Get a note's full content by id.",
    params: '{ "id": string }',
    run: (a) => q.getNote(str(a.id)),
  },
  {
    name: "ensure_note",
    description: "Create or update a note by title within a project. Returns the note id.",
    params: '{ "project_id": string, "title": string, "content": string, "folder"?: string }',
    run: (a) => ({ id: q.ensureNote(str(a.project_id), str(a.title), str(a.content), str(a.folder)) }),
  },
  {
    name: "append_to_note",
    description: "Append markdown text to a note's body.",
    params: '{ "id": string, "text": string }',
    run: (a) => ({ ok: q.appendToNote(str(a.id), str(a.text)) }),
  },
  {
    name: "patch_note",
    description: "Replace an exact substring in a note's body (include enough context to be unique).",
    params: '{ "id": string, "oldString": string, "newString": string }',
    run: (a) => ({ ok: q.patchNote(str(a.id), str(a.oldString), str(a.newString)) }),
  },
  {
    name: "list_columns",
    description: "List board columns for a project (id, name).",
    params: '{ "project_id": string }',
    run: (a) => q.listColumns(str(a.project_id)).map((c) => ({ id: c.id, name: c.name })),
  },
  {
    name: "create_task",
    description: "Create a task card in a column. priority = low|medium|high|urgent.",
    params: '{ "project_id": string, "column_id": string, "title": string, "description"?: string, "priority"?: string }',
    run: (a) => ({
      id: q.createTask(str(a.project_id), str(a.column_id), str(a.title), {
        description: a.description ? str(a.description) : undefined,
        priority: a.priority ? str(a.priority) : undefined,
      }),
    }),
  },
  {
    name: "search_tasks",
    description: "List task cards in a project (id, title, priority, column_id).",
    params: '{ "project_id": string }',
    run: (a) =>
      q.listCards(str(a.project_id)).map((c) => ({ id: c.id, title: c.title, priority: c.priority, column_id: c.column_id })),
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
