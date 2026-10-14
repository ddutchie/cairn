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
import { serviceToolDefs } from "./services";
import { isToolEnabled } from "./tool-toggles";
import { getCachedMcpToolDefs, getInstalledMcpServer, toRuntimeConfig } from "./mcp-store";
import * as mcpClient from "./mcp-client";
import { parseToolName } from "@cairn/shared/chat/mcp-namespace";
import { isOverdue, isDueWithin } from "@cairn/shared/notes/due";

export interface ToolDef {
  name: string;
  description: string;
  params: string; // human-readable hint (kept for prompts/debug)
  jsonSchema: Record<string, unknown>; // JSON Schema for /agent/chat tools
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((s) => s.length > 0) : [];

const tagMode = (v: unknown): "add" | "remove" | "set" =>
  v === "remove" || v === "set" ? v : "add";

// JSON-schema fragment restricting `mode` to the valid tag modes so invalid
// strings are rejected at the tool boundary (kept in sync with tagMode()).
const TAG_MODE_SCHEMA = { type: "string", enum: ["add", "remove", "set"] };

// Small helpers to keep tool schemas terse.
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const S = { type: "string" };

// Consolidated toolset (mobile 1.x, mirrors desktop 3.1.3): one tool per intent,
// with mode/filter/type options instead of near-duplicate tools, and the same
// names + camelCase arguments as the desktop/MCP tools so the model sees one API.
// Each tool composes the existing per-operation queries in queries.ts.

const A = { type: "array", items: S };
const isErr = (r: unknown): r is { error: string } =>
  !!r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string";

/** Errors from multi-step writes are reported, never swallowed. */
const summarize = (base: Record<string, unknown>, errors: string[]) =>
  errors.length > 0 ? { ...base, error: errors.join("; ") } : base;

/** First column of `type` in a project (board order). */
function columnOfType(projectId: string, type: string): string | undefined {
  return q.listColumns(projectId).find((c) => c.type === type)?.id;
}

/** Cards in one project, or every project when none is given. */
function cardsIn(projectId?: string) {
  const ids = projectId ? [projectId] : q.listProjects().map((p) => p.id);
  return ids.flatMap((id) => q.listCards(id));
}

const shapeCard = (c: { id: string; title: string; priority: string; column_id: string; project_id: string; due_date?: string | null }) => ({
  id: c.id, title: c.title, priority: c.priority, columnId: c.column_id, projectId: c.project_id,
  ...(c.due_date ? { dueDate: c.due_date } : {}),
});

async function semanticHits(kind: "notes" | "tasks", query: string, limit: number) {
  if (!isAppleEmbeddingsSupported()) {
    return { error: "On-device semantic search isn't available on this device; use mode 'keyword' instead." };
  }
  // Index new/edited items first so the agent searches the SAME fresh index as
  // the Search tab. Gather the full ranked list per workspace, merge, re-rank
  // and slice ONCE so a globally strong hit isn't dropped before the merge.
  await catchUpIndex();
  const hits: SemanticHit[] = [];
  for (const ws of q.listWorkspaceIds()) {
    hits.push(...(await (kind === "notes" ? semanticSearch(ws, query) : semanticSearchTasks(ws, query))));
  }
  finalizeRanking(hits);
  return hits.slice(0, limit).map((h) => ({ id: h.noteId, title: h.title, section: h.sectionTitle, score: h.score }));
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_context",
    description:
      "Orientation: all projects with their board columns, plus tags. With projectId: that project's pinned notes, folders, open tasks by column and recent activity. Call first to get ids.",
    params: '{ "projectId"?: string }',
    jsonSchema: obj({ projectId: S }),
    run: (a) => {
      const projectId = str(a.projectId);
      if (!projectId) return q.getCairnContext();
      const pack = q.getProjectContextPack(projectId);
      return pack && typeof pack === "object" && !isErr(pack) ? { ...(pack as object), folders: q.listFolders(projectId) } : pack;
    },
  },
  {
    name: "get_item",
    description:
      "Read a note or task card by its id: a card's full detail, a note's content, or specific lines of a note (startLine/endLine, 1-based inclusive). Long notes return a line-numbered outline unless you pass a line range or full:true.",
    params: '{ "id": string, "full"?: boolean, "startLine"?: number, "endLine"?: number }',
    jsonSchema: obj({ id: S, full: { type: "boolean" }, startLine: { type: "number" }, endLine: { type: "number" } }, ["id"]),
    run: (a) => {
      const id = str(a.id);
      if (q.getNote(id)) {
        const note = typeof a.startLine === "number"
          ? q.getNoteRange(id, a.startLine, typeof a.endLine === "number" ? a.endLine : undefined)
          : a.full === true ? q.getNote(id) : q.getNoteForAgent(id);
        return { type: "note", ...(note as object) };
      }
      const card = q.getCard(id);
      if (card) return { type: "task", ...card };
      return { error: `No note or task with id "${id}"` };
    },
  },
  {
    name: "search_notes",
    description:
      "Find notes. mode 'keyword' (default) matches words; 'semantic' finds notes by meaning (on-device). Empty query lists a project's notes.",
    params: '{ "query": string, "mode"?: "keyword"|"semantic", "projectId"?: string, "folder"?: string, "limit"?: number }',
    jsonSchema: obj({ query: S, mode: { type: "string", enum: ["keyword", "semantic"] }, projectId: S, folder: S, limit: { type: "number" } }, ["query"]),
    run: async (a) => {
      const query = str(a.query).trim();
      const limit = typeof a.limit === "number" && a.limit > 0 ? Math.min(a.limit, 50) : 20;
      const projectId = str(a.projectId) || undefined;
      const folder = a.folder !== undefined ? str(a.folder).toLowerCase() : undefined;
      if (a.mode === "semantic") {
        const hits = await semanticHits("notes", query, projectId || folder !== undefined ? 50 : Math.min(limit, 20));
        if (isErr(hits) || (!projectId && folder === undefined)) return isErr(hits) ? hits : hits.slice(0, limit);
        return hits.filter((h) => {
          const n = q.getNote(h.id);
          return n && (!projectId || n.project_id === projectId) && (folder === undefined || (n.folder ?? "").toLowerCase() === folder);
        }).slice(0, limit);
      }
      const notes = query ? q.searchNotes(query) : q.listNotes(projectId);
      return notes
        .filter((n) => (!projectId || n.project_id === projectId) && (folder === undefined || (n.folder ?? "").toLowerCase() === folder))
        .slice(0, limit)
        .map((n) => ({ id: n.id, title: n.title, folder: n.folder, projectId: n.project_id }));
    },
  },
  {
    name: "search_tasks",
    description:
      "Find task cards. mode 'keyword' (default) or 'semantic' (by meaning). filter: 'ready' (unblocked, not done — \"what should I work on?\"), 'overdue', or 'due' (due within dueWithinDays, default 7, including overdue). Empty query lists all matching.",
    params: '{ "query": string, "mode"?: "keyword"|"semantic", "projectId"?: string, "columnType"?: string, "filter"?: "ready"|"overdue"|"due", "dueWithinDays"?: number, "limit"?: number }',
    jsonSchema: obj({
      query: S,
      mode: { type: "string", enum: ["keyword", "semantic"] },
      projectId: S,
      columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
      filter: { type: "string", enum: ["ready", "overdue", "due"] },
      dueWithinDays: { type: "number" },
      limit: { type: "number" },
    }, ["query"]),
    run: async (a) => {
      const query = str(a.query).trim();
      const limit = typeof a.limit === "number" && a.limit > 0 ? Math.min(a.limit, 50) : 20;
      const projectId = str(a.projectId) || undefined;
      if (a.mode === "semantic") {
        const hits = await semanticHits("tasks", query, Math.min(limit, 20));
        return isErr(hits) || !projectId ? hits : hits.filter((h) => q.getCard(h.id)?.project_id === projectId);
      }
      let cards: Parameters<typeof shapeCard>[0][];
      if (a.filter === "ready") cards = q.listReadyCards(projectId);
      else if (a.filter === "overdue" || a.filter === "due") {
        const days = typeof a.dueWithinDays === "number" ? a.dueWithinDays : 7;
        cards = q.listCardsWithDueDates(projectId).filter((c) => !c.is_done &&
          (isOverdue(c.due_date) || (a.filter === "due" && isDueWithin(c.due_date, days))));
      } else cards = query ? q.searchTasks(query, projectId) : cardsIn(projectId);
      if (query && a.filter) {
        const terms = query.toLowerCase().split(/\s+/);
        cards = cards.filter((c) => terms.every((t) => c.title.toLowerCase().includes(t)));
      }
      if (a.columnType) {
        const types = new Map<string, string>();
        for (const pid of new Set(cards.map((c) => c.project_id))) for (const col of q.listColumns(pid)) types.set(col.id, col.type);
        cards = cards.filter((c) => types.get(c.column_id) === a.columnType);
      }
      return cards.slice(0, limit).map(shapeCard);
    },
  },
  {
    name: "ensure_note",
    description: "Create or update a note by title within a project. Returns the note id.",
    params: '{ "projectId": string, "title": string, "content": string, "folder"?: string }',
    jsonSchema: obj({ projectId: S, title: S, content: S, folder: S }, ["projectId", "title", "content"]),
    run: (a) => ({ id: q.ensureNote(str(a.projectId), str(a.title), str(a.content), str(a.folder)) }),
  },
  {
    name: "edit_note",
    description:
      "Edit a note's text. With oldString: replace that exact text (include enough context to be unique). Without oldString: append newString to the end.",
    params: '{ "noteId": string, "newString": string, "oldString"?: string }',
    jsonSchema: obj({ noteId: S, newString: S, oldString: S }, ["noteId", "newString"]),
    run: (a) => {
      const noteId = str(a.noteId);
      if (str(a.oldString)) return q.patchNote(noteId, str(a.oldString), str(a.newString));
      return q.appendToNote(noteId, str(a.newString)) ? { ok: true, id: noteId } : { error: "Note not found" };
    },
  },
  {
    name: "update_notes",
    description:
      "Change one or more notes: rename (keeps [[wikilinks]] intact), move to a folder or another project, pin, tag, or link/unlink task cards.",
    params: '{ "noteIds": string[], "title"?: string, "folder"?: string, "projectId"?: string, "isPinned"?: boolean, "tagNames"?: string[], "tagMode"?: "add"|"remove"|"set", "linkCardIds"?: string[], "unlinkCardIds"?: string[] }',
    jsonSchema: obj({
      noteIds: A, title: S, folder: S, projectId: S, isPinned: { type: "boolean" },
      tagNames: A, tagMode: TAG_MODE_SCHEMA, linkCardIds: A, unlinkCardIds: A,
    }, ["noteIds"]),
    run: (a) => {
      const ids = strArray(a.noteIds);
      if (ids.length === 0) return { error: "noteIds is required" };
      if (a.title !== undefined && ids.length > 1) return { error: "title (rename) applies to a single note — pass one noteId" };
      const errors: string[] = [];
      const step = (label: string, fn: () => unknown) => {
        try {
          const r = fn();
          if (isErr(r)) errors.push(`${label}: ${r.error}`);
        } catch (e) {
          errors.push(`${label}: ${(e as Error).message}`);
        }
      };
      if (a.title !== undefined) step("rename", () => q.renameNote(ids[0], str(a.title)));
      if (a.folder !== undefined) step("move", () => q.moveNotesToFolder(ids, str(a.folder)));
      for (const id of ids) {
        if (str(a.projectId)) step(`move ${id}`, () => q.moveNoteToProject(id, str(a.projectId)));
        if (typeof a.isPinned === "boolean") step(`pin ${id}`, () => q.pinNote(id, a.isPinned as boolean));
        if (strArray(a.tagNames).length > 0) step(`tag ${id}`, () => q.tagNote(id, strArray(a.tagNames), tagMode(a.tagMode)));
        for (const cardId of strArray(a.linkCardIds)) step(`link ${id}→${cardId}`, () => q.linkNoteToTask(id, cardId));
        for (const cardId of strArray(a.unlinkCardIds)) step(`unlink ${id}→${cardId}`, () => q.unlinkNoteFromTask(id, cardId));
      }
      const notes = ids.map((id) => q.getNote(id)).filter((n) => n !== null).map((n) => ({ id: n!.id, title: n!.title }));
      return summarize(notes.length === 1 ? { ...notes[0], updated: true } : { updated: notes }, errors);
    },
  },
  {
    name: "create_task",
    description: "Create a task card. Place it with columnType (default backlog) or an explicit columnId. priority = low|medium|high|urgent; dueDate as YYYY-MM-DD.",
    params: '{ "projectId": string, "title": string, "description"?: string, "columnType"?: string, "columnId"?: string, "priority"?: string, "dueDate"?: string, "tagNames"?: string[], "linkNoteIds"?: string[] }',
    jsonSchema: obj({
      projectId: S, title: S, description: S,
      columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
      columnId: S, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, dueDate: S,
      tagNames: A, linkNoteIds: A,
    }, ["projectId", "title"]),
    run: (a) => {
      const projectId = str(a.projectId);
      const columnId = str(a.columnId) || columnOfType(projectId, str(a.columnType) || "backlog") || q.listColumns(projectId)[0]?.id;
      if (!columnId) return { error: `Project ${projectId} has no board columns` };
      let id: string;
      try {
        id = q.createTask(projectId, columnId, str(a.title), {
          description: a.description ? str(a.description) : undefined,
          priority: a.priority ? str(a.priority) : undefined,
        });
      } catch (e) {
        return { error: (e as Error).message };
      }
      const errors: string[] = [];
      if (str(a.dueDate)) q.updateTask(id, { dueDate: str(a.dueDate) });
      if (strArray(a.tagNames).length > 0) {
        const r = q.tagTask(id, strArray(a.tagNames), "add");
        if (isErr(r)) errors.push(`tags: ${r.error}`);
      }
      for (const noteId of strArray(a.linkNoteIds)) {
        const r = q.linkNoteToTask(noteId, id);
        if (isErr(r)) errors.push(`link ${noteId}: ${r.error}`);
      }
      return summarize({ id, title: str(a.title), columnId }, errors);
    },
  },
  {
    name: "update_tasks",
    description:
      "Update one or more task cards; only provided fields change. Move with columnType or columnId. Also tags, note links (linkNoteIds/unlinkNoteIds), and archived:true to archive. Set dueDate to \"\" to clear it.",
    params: '{ "cardIds": string[], "title"?: string, "description"?: string, "priority"?: string, "dueDate"?: string, "assignee"?: string, "columnType"?: string, "columnId"?: string, "archived"?: boolean, "tagNames"?: string[], "tagMode"?: "add"|"remove"|"set", "linkNoteIds"?: string[], "unlinkNoteIds"?: string[] }',
    jsonSchema: obj({
      cardIds: A, title: S, description: S,
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, dueDate: S, assignee: S,
      columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] }, columnId: S,
      archived: { type: "boolean" }, tagNames: A, tagMode: TAG_MODE_SCHEMA,
      linkNoteIds: { ...A, description: "Note ids to link to these cards" },
      unlinkNoteIds: { ...A, description: "Note ids to unlink from these cards" },
    }, ["cardIds"]),
    run: (a) => {
      const ids = strArray(a.cardIds);
      if (ids.length === 0) return { error: "cardIds is required" };
      const errors: string[] = [];
      const patch: { title?: string; description?: string; priority?: string; dueDate?: string | null; assignee?: string | null } = {};
      if (a.title !== undefined) patch.title = str(a.title);
      if (a.description !== undefined) patch.description = str(a.description);
      if (a.priority !== undefined) patch.priority = str(a.priority);
      if (a.dueDate !== undefined) patch.dueDate = str(a.dueDate) || null;
      if (a.assignee !== undefined) patch.assignee = str(a.assignee) || null;
      for (const id of ids) {
        const card = q.getCard(id);
        if (!card) { errors.push(`${id}: Task not found`); continue; }
        try {
          // Move first: it throws for a column outside the card's project, and
          // the field edits shouldn't land when the move is refused.
          const columnId = str(a.columnId) || (a.columnType ? columnOfType(card.project_id, str(a.columnType)) : undefined);
          if (a.columnType && !columnId) throw new Error(`no ${str(a.columnType)} column in its project`);
          if (columnId) q.moveCardToColumn(id, columnId);
          if (Object.keys(patch).length > 0) q.updateTask(id, patch);
          if (a.archived === true) q.archiveCard(id);
        } catch (e) {
          errors.push(`${id}: ${(e as Error).message}`);
          continue;
        }
        if (strArray(a.tagNames).length > 0) {
          const r = q.tagTask(id, strArray(a.tagNames), tagMode(a.tagMode));
          if (isErr(r)) errors.push(`tag ${id}: ${r.error}`);
        }
        for (const noteId of strArray(a.linkNoteIds)) {
          const r = q.linkNoteToTask(noteId, id);
          if (isErr(r)) errors.push(`link ${noteId}→${id}: ${r.error}`);
        }
        for (const noteId of strArray(a.unlinkNoteIds)) {
          const r = q.unlinkNoteFromTask(noteId, id);
          if (isErr(r)) errors.push(`unlink ${noteId}→${id}: ${r.error}`);
        }
      }
      const cards = ids.map((id) => q.getCard(id)).filter((c) => c !== null).map((c) => ({ id: c!.id, title: c!.title, columnId: c!.column_id }));
      return summarize(cards.length === 1 ? { ...cards[0], updated: true } : { updated: cards }, errors);
    },
  },
  {
    name: "delete",
    description: "Delete a note or task card by id (soft delete, synced as a tombstone). Confirm intent before calling.",
    params: '{ "type": "note"|"task", "id": string }',
    jsonSchema: obj({ type: { type: "string", enum: ["note", "task"] }, id: S }, ["type", "id"]),
    run: (a) => {
      if (a.type === "note") q.softDeleteNote(str(a.id));
      else if (a.type === "task") q.deleteCard(str(a.id));
      else return { error: `Unknown delete type "${str(a.type)}"` };
      return { ok: true, deleted: str(a.id) };
    },
  },
  {
    name: "get_user_writing_style",
    description:
      "The user's writing style, for drafting in their voice. mode 'cheatsheet' (default) or 'full'. configured:false means none is set up — then write naturally; never invent one.",
    params: '{ "mode"?: "cheatsheet" | "full" }',
    jsonSchema: obj({ mode: { type: "string", enum: ["cheatsheet", "full"] } }),
    run: (a) => {
      const mode = a.mode === "full" ? "full" : "cheatsheet";
      const style = q.getUserStyle();
      const configured = !!style && style.source !== "none" && !!(style.fullGuide || style.cheatsheet);
      if (!configured) {
        return {
          configured: false,
          message:
            "No writing style set up yet — the user hasn't configured one in Settings → Writing Style on the desktop app. Draft in the user's natural, clear voice; do not invent a style guide.",
          mode,
          markdown: null,
          persona: null,
          updatedAt: null,
        };
      }
      return {
        configured: true,
        mode,
        markdown: mode === "full" ? style.fullGuide || style.cheatsheet : style.cheatsheet || style.fullGuide,
        persona: style.persona,
        updatedAt: style.updatedAt,
      };
    },
  },
  {
    name: "update_user_writing_style",
    description:
      "Append a style observation the user asked you to remember (or a consistent correction). Never invent one; call get_user_writing_style first to avoid duplicates.",
    params: '{ "section"?: string, "content": string }',
    jsonSchema: obj(
      {
        section: { type: "string", description: "Guide section by number or heading, e.g. \"5\" or \"Punctuation\"; omit to append at the end" },
        content: S,
      },
      ["content"],
    ),
    run: (a) => {
      // mode is no longer advertised (append is the only mode); still reject other values.
      const mode = a.mode === undefined ? "append" : str(a.mode);
      const content = str(a.content);
      const section = a.section !== undefined ? str(a.section) : undefined;
      if (mode !== "append") return { error: `Unsupported mode "${mode}" — only "append" is supported.` };
      if (!content.trim()) return { error: "content is required and must be non-empty." };
      if (content.trim().length > 2000) return { error: "content is too long (max 2000 characters)." };
      const { row, updated, reason } = q.appendUserStyleObservation(section, content);
      if (!updated) return { ok: true, updated: false, message: reason ?? "No change.", style: row };
      return { ok: true, updated: true, message: section ? `Appended to "${section}".` : "Appended to the guide.", style: row };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Built-in tools that MUTATE the user's workspace (create/edit/delete/link/tag).
 * Everything else is read-only (search/get/list) or reads external data
 * (web_*). Used only by the Settings → Tools & Services screen to group the
 * read-only built-in list into Read vs Write sections. Keep in sync when adding
 * a mutating built-in tool.
 */
export const WRITE_TOOL_NAMES = new Set<string>([
  "ensure_note",
  "edit_note",
  "update_notes",
  "create_task",
  "update_tasks",
  "delete",
  "update_user_writing_style",
]);

/**
 * The FULL tool set exposed to the agent: the built-in TOOLS (ALWAYS on) plus
 * any installed community `service` tools AND installed MCP-server tools that
 * are enabled.
 *
 * Built-in tools are never toggled off — they ARE the assistant (turning off
 * e.g. get_context or search_notes would silently break it), and this
 * matches desktop, where the tool gating only ever applies to external MCP
 * servers / HTTP services, never Cairn's own tools. Installed services + MCP
 * tools are subject to the per-tool toggle map (default ON).
 *
 * MCP tool defs are read from the SYNCHRONOUS meta-DB cache (populated by
 * mcp-store on connect / Settings-open) — discovery is a network call, so the
 * model-facing list uses the last-known tools; execution reconnects as needed.
 *
 * Recomputed on each call (cheap) so a just-installed service/server or a flipped
 * toggle takes effect on the very next agent run — no app restart. Service + MCP
 * tools are namespaced so they can't collide with built-ins or each other.
 */
export function allTools(): ToolDef[] {
  const services = serviceToolDefs().filter((t) => isToolEnabled(t.name));
  const mcp = mcpToolDefs().filter((t) => isToolEnabled(t.name));
  return [...TOOLS, ...services, ...mcp];
}

/**
 * Cached MCP tool defs (from mcp-store) adapted to the mobile ToolDef shape. The
 * `run` routes the namespaced call to the owning server via mcp-client.callTool.
 */
function mcpToolDefs(): ToolDef[] {
  return getCachedMcpToolDefs().map((def) => ({
    name: def.function.name,
    description: def.function.description,
    params: JSON.stringify(def.function.parameters),
    jsonSchema: def.function.parameters,
    run: async (args: Record<string, unknown>) => {
      const parsed = parseToolName(def.function.name);
      const server = parsed ? getInstalledMcpServer(parsed.serverId) : undefined;
      if (!parsed || !server) {
        return { error: `MCP server for ${def.function.name} is not installed.` };
      }
      // callTool returns a string (text result or an error string); wrap so the
      // agent serialises it consistently with other tools.
      const text = await mcpClient.callTool(toRuntimeConfig(server), def.function.name, args);
      return text;
    },
  }));
}

/** Name→ToolDef map over allTools() (built-ins + enabled services). */
export function allToolMap(): Map<string, ToolDef> {
  return new Map(allTools().map((t) => [t.name, t]));
}

/** Tool defs in the /agent/chat shape: { name: { description, jsonSchema } }. */
export function toolsForAgent(): Record<string, { description: string; jsonSchema: Record<string, unknown> }> {
  const out: Record<string, { description: string; jsonSchema: Record<string, unknown> }> = {};
  for (const t of allTools()) out[t.name] = { description: t.description, jsonSchema: t.jsonSchema };
  return out;
}
