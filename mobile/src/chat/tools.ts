/**
 * Chat tools — executed locally against the mobile expo-sqlite DB.
 *
 * The AI (via the prompt-based tool protocol in agent.ts) emits a tool call as
 * JSON; we run the matching executor here. Writes go through queries.ts (plain
 * SQL) so the capture triggers stage them for sync — anything the AI changes
 * propagates to the desktop, which projects note edits to .md.
 */

import * as q from "@/db/queries";
import { semanticSearch, semanticSearchTasks, catchUpIndex, finalizeRanking, type SemanticHit } from "@/notes/embeddings";
import { isAppleEmbeddingsSupported } from "@modules/apple-embeddings";

export interface ToolDef {
  name: string;
  description: string;
  params: string; // human-readable hint (kept for prompts/debug)
  jsonSchema: Record<string, unknown>; // JSON Schema for /agent/chat tools
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

// Small helpers to keep tool schemas terse.
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const S = { type: "string" };

export const TOOLS: ToolDef[] = [
  {
    name: "get_cairn_context",
    description:
      "Workspace orientation: all projects (each with their board columns) + tags. Call this FIRST to get ids and structure.",
    params: "{}",
    jsonSchema: obj({}),
    run: () => q.getCairnContext(),
  },
  {
    name: "get_project_context_pack",
    description:
      "Rich single-call project summary: project + columns, note count, pinned notes (with content), open tasks grouped by column, and recent activity. Use this to summarize or understand a project.",
    params: '{ "project_id": string }',
    jsonSchema: obj({ project_id: S }, ["project_id"]),
    run: (a) => q.getProjectContextPack(str(a.project_id)),
  },
  {
    name: "search_notes",
    description: "Search notes by text. Returns id, title, folder, project_id.",
    params: '{ "query": string }',
    jsonSchema: obj({ query: S }, ["query"]),
    run: (a) =>
      q.searchNotes(str(a.query)).map((n) => ({ id: n.id, title: n.title, folder: n.folder, project_id: n.project_id })),
  },
  {
    name: "semantic_search_notes",
    description:
      "Find notes by MEANING, not just literal keywords — use this when the user asks a conceptual question about their notes (e.g. \"what did I decide about auth\", \"anything on offline sync\") and search_notes' exact-text matching would miss relevant notes. Returns the best-matching notes with a relevance score (0-1) and the matching section title. Follow up with get_note to read a match's full content before answering.",
    params: '{ "query": string, "limit"?: number }',
    jsonSchema: obj({ query: S, limit: { type: "number" } }, ["query"]),
    run: async (a) => {
      if (!isAppleEmbeddingsSupported()) {
        return { error: "On-device semantic search isn't available on this device; use search_notes instead." };
      }
      // Index any not-yet-embedded notes first (downloads assets on first use),
      // so the agent searches the SAME fresh index as the user-facing Search tab
      // — otherwise recently created/edited notes are missed. Idempotent.
      await catchUpIndex();
      const limit = typeof a.limit === "number" && a.limit > 0 ? Math.min(a.limit, 20) : 8;
      // Gather the FULL ranked candidate list per workspace, merge, re-rank by
      // the hybrid `rank`, and slice ONCE — so a note that ranks low within its
      // workspace but high globally isn't dropped before the merge. Matches the
      // Search tab.
      const hits: SemanticHit[] = [];
      for (const ws of q.listWorkspaceIds()) hits.push(...(await semanticSearch(ws, str(a.query))));
      finalizeRanking(hits);
      return hits.slice(0, limit).map((h) => ({
        id: h.noteId,
        title: h.title,
        section: h.sectionTitle,
        score: h.score,
      }));
    },
  },
  {
    name: "semantic_search_tasks",
    description:
      "Find task cards by MEANING, not just literal keywords — use for conceptual questions about tasks (e.g. \"what's blocking the login work\", \"anything about offline sync\") where search_tasks' exact-text matching would miss related cards. Returns the best-matching cards with a relevance score (0-1). Follow up with get_task to read a card's full detail.",
    params: '{ "query": string, "limit"?: number }',
    jsonSchema: obj({ query: S, limit: { type: "number" } }, ["query"]),
    run: async (a) => {
      if (!isAppleEmbeddingsSupported()) {
        return { error: "On-device semantic search isn't available on this device; use search_tasks instead." };
      }
      // Index new/edited cards first (same fresh index as the Search tab).
      await catchUpIndex();
      const limit = typeof a.limit === "number" && a.limit > 0 ? Math.min(a.limit, 20) : 8;
      // Full ranked list per workspace, merge, re-rank, slice ONCE (no burying).
      const hits: SemanticHit[] = [];
      for (const ws of q.listWorkspaceIds()) hits.push(...(await semanticSearchTasks(ws, str(a.query))));
      finalizeRanking(hits);
      return hits.slice(0, limit).map((h) => ({
        id: h.noteId, // card id
        title: h.title,
        section: h.sectionTitle,
        score: h.score,
      }));
    },
  },
  {
    name: "list_notes",
    description: "List notes in a project (id, title, folder).",
    params: '{ "project_id": string }',
    jsonSchema: obj({ project_id: S }, ["project_id"]),
    run: (a) => q.listNotes(str(a.project_id)).map((n) => ({ id: n.id, title: n.title, folder: n.folder })),
  },
  {
    name: "get_note",
    description:
      "Get a note by id. Small notes return full content; large notes return a line-numbered outline + intro (call get_note_range to read a section). Pass full=true to force the entire content.",
    params: '{ "id": string, "full"?: boolean }',
    jsonSchema: obj({ id: S, full: { type: "boolean" } }, ["id"]),
    run: (a) => (a.full === true ? q.getNote(str(a.id)) : q.getNoteForAgent(str(a.id))),
  },
  {
    name: "get_note_range",
    description:
      "Read an inclusive line range of a note (1-based). Use after get_note returns an outline, passing the line numbers around the section you need. Omit end_line to read to the end.",
    params: '{ "id": string, "start_line": number, "end_line"?: number }',
    jsonSchema: obj({ id: S, start_line: { type: "number" }, end_line: { type: "number" } }, ["id", "start_line"]),
    run: (a) => {
      const start = typeof a.start_line === "number" ? a.start_line : 1;
      const end = typeof a.end_line === "number" ? a.end_line : undefined;
      return q.getNoteRange(str(a.id), start, end);
    },
  },
  {
    name: "ensure_note",
    description: "Create or update a note by title within a project. Returns the note id.",
    params: '{ "project_id": string, "title": string, "content": string, "folder"?: string }',
    jsonSchema: obj({ project_id: S, title: S, content: S, folder: S }, ["project_id", "title", "content"]),
    run: (a) => ({ id: q.ensureNote(str(a.project_id), str(a.title), str(a.content), str(a.folder)) }),
  },
  {
    name: "append_to_note",
    description: "Append markdown text to a note's body.",
    params: '{ "id": string, "text": string }',
    jsonSchema: obj({ id: S, text: S }, ["id", "text"]),
    run: (a) => ({ ok: q.appendToNote(str(a.id), str(a.text)) }),
  },
  {
    name: "patch_note",
    description: "Replace an exact substring in a note's body (include enough context to be unique).",
    params: '{ "id": string, "oldString": string, "newString": string }',
    jsonSchema: obj({ id: S, oldString: S, newString: S }, ["id", "oldString", "newString"]),
    run: (a) => ({ ok: q.patchNote(str(a.id), str(a.oldString), str(a.newString)) }),
  },
  {
    name: "rename_note",
    description:
      "Rename a note and rewrite inbound [[wikilinks]] in other notes so links stay intact. Rejects a duplicate title in the same project.",
    params: '{ "id": string, "newTitle": string }',
    jsonSchema: obj({ id: S, newTitle: S }, ["id", "newTitle"]),
    run: (a) => q.renameNote(str(a.id), str(a.newTitle)),
  },
  {
    name: "bulk_move_notes",
    description: 'Move one or more notes to a folder (use "" for the project root). Returns the count moved.',
    params: '{ "note_ids": string[], "folder": string }',
    jsonSchema: obj({ note_ids: { type: "array", items: S }, folder: S }, ["note_ids", "folder"]),
    run: (a) => ({ moved: q.moveNotesToFolder(Array.isArray(a.note_ids) ? a.note_ids.map(str) : [], str(a.folder)) }),
  },
  {
    name: "move_note_to_project",
    description:
      "Move a note to a different project (call get_cairn_context for project ids). The note's owning workspace is updated automatically. Returns the new project_id/workspace_id, or an error.",
    params: '{ "id": string, "project_id": string }',
    jsonSchema: obj({ id: S, project_id: S }, ["id", "project_id"]),
    run: (a) => {
      const res = q.moveNoteToProject(str(a.id), str(a.project_id));
      // Adapt the query's camelCase result to the snake_case field names this
      // tool documents (and the rest of the tool surface uses); pass errors through.
      return "error" in res ? res : { project_id: res.projectId, workspace_id: res.workspaceId };
    },
  },
  {
    name: "list_folders",
    description: "List all folder paths used by a project's notes.",
    params: '{ "project_id": string }',
    jsonSchema: obj({ project_id: S }, ["project_id"]),
    run: (a) => q.listFolders(str(a.project_id)),
  },
  {
    name: "delete_note",
    description: "Delete a note by id. This is a soft delete synced as a tombstone; confirm intent before calling.",
    params: '{ "id": string }',
    jsonSchema: obj({ id: S }, ["id"]),
    run: (a) => {
      q.softDeleteNote(str(a.id));
      return { ok: true };
    },
  },
  {
    name: "list_columns",
    description: "List board columns for a project (id, name).",
    params: '{ "project_id": string }',
    jsonSchema: obj({ project_id: S }, ["project_id"]),
    run: (a) => q.listColumns(str(a.project_id)).map((c) => ({ id: c.id, name: c.name })),
  },
  {
    name: "create_task",
    description: "Create a task card in a column. priority = low|medium|high|urgent.",
    params: '{ "project_id": string, "column_id": string, "title": string, "description"?: string, "priority"?: string }',
    jsonSchema: obj({ project_id: S, column_id: S, title: S, description: S, priority: S }, ["project_id", "column_id", "title"]),
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
    jsonSchema: obj({ project_id: S }, ["project_id"]),
    run: (a) =>
      q.listCards(str(a.project_id)).map((c) => ({ id: c.id, title: c.title, priority: c.priority, column_id: c.column_id })),
  },
  {
    name: "get_task",
    description: "Get a task card's full detail by id (title, description, priority, column, due date, assignee, tags).",
    params: '{ "id": string }',
    jsonSchema: obj({ id: S }, ["id"]),
    run: (a) => q.getCard(str(a.id)),
  },
  {
    name: "update_task",
    description:
      "Update a task card. Any provided field is changed; pass column_id to move it to another column. priority = low|medium|high|urgent. Set due_date to \"\" to clear it.",
    params:
      '{ "id": string, "title"?: string, "description"?: string, "priority"?: string, "column_id"?: string, "due_date"?: string, "assignee"?: string }',
    jsonSchema: obj(
      { id: S, title: S, description: S, priority: S, column_id: S, due_date: S, assignee: S },
      ["id"],
    ),
    run: (a) => {
      const patch: { title?: string; description?: string; priority?: string; dueDate?: string | null; assignee?: string | null } = {};
      if (a.title !== undefined) patch.title = str(a.title);
      if (a.description !== undefined) patch.description = str(a.description);
      if (a.priority !== undefined) patch.priority = str(a.priority);
      if (a.due_date !== undefined) patch.dueDate = str(a.due_date) || null;
      if (a.assignee !== undefined) patch.assignee = str(a.assignee) || null;
      if (Object.keys(patch).length > 0) q.updateTask(str(a.id), patch);
      if (a.column_id !== undefined && str(a.column_id)) q.moveCardToColumn(str(a.id), str(a.column_id));
      return { ok: true };
    },
  },
  {
    name: "delete_task",
    description: "Delete a task card by id. This is a soft delete synced as a tombstone; confirm intent before calling.",
    params: '{ "id": string }',
    jsonSchema: obj({ id: S }, ["id"]),
    run: (a) => {
      q.deleteCard(str(a.id));
      return { ok: true };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool defs in the /agent/chat shape: { name: { description, jsonSchema } }. */
export function toolsForAgent(): Record<string, { description: string; jsonSchema: Record<string, unknown> }> {
  const out: Record<string, { description: string; jsonSchema: Record<string, unknown> }> = {};
  for (const t of TOOLS) out[t.name] = { description: t.description, jsonSchema: t.jsonSchema };
  return out;
}
