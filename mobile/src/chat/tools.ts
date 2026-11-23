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
import { PEOPLE_ARG_DESCRIPTIONS, PEOPLE_PARAM_DESCRIPTIONS as PD, PEOPLE_TOOL_DESCRIPTION } from "@cairn/shared/agent/people-tools";
import { isReadCall, refusesHiddenNoteWrite, scrubHidden } from "@cairn/shared/agent/people-privacy";
import { peopleTool, setCardOwnerArg, setNoteAttendees, type PeopleToolContext } from "@cairn/shared/people/tool";
import { agentHiddenNoteIds } from "@cairn/shared/people/queries";
import { CADENCES, LINK_KINDS, PEOPLE_STATUSES, RELATIONSHIP_TYPES, TEAM_KINDS } from "@cairn/shared/types/people";
import { peopleDb, peopleWorkspaceId } from "@/db/people";
import { loadLocalToday } from "@/lib/local-today";
import { cardChanges, type ToolChange } from "@cairn/shared/conversation/tool-view";
import { notifyLocalWrite } from "@/sync/write-signal";

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
  // Adaptive-k: the agent gets fewer, cleaner results when scores fall off a cliff.
  finalizeRanking(hits, { adaptive: true, maxK: limit });
  return hits.slice(0, limit).map((h) => ({ id: h.noteId, title: h.title, section: h.sectionTitle, score: h.score }));
}

// ── People layer ──────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What the shared People handlers need from this device; mobile has no files to rewrite. */
const peopleContext = (): PeopleToolContext => ({});

/** Apply `attendees` / `date` to notes a note tool just wrote. Returns the meeting summary (or undefined). */
function applyNoteMeeting(noteIds: string[], a: Record<string, unknown>, errors: string[]): unknown {
  if (a.attendees === undefined && a.date === undefined) return undefined;
  let last: unknown;
  for (const noteId of noteIds) {
    // The note is already written; a People failure is reported, never thrown past it.
    try {
      last = setNoteAttendees(peopleDb(), peopleContext(), { noteId, attendees: a.attendees, date: a.date });
    } catch (e) {
      last = { error: e instanceof Error ? e.message : String(e) };
    }
    if (isErr(last)) errors.push(`attendees ${noteId}: ${last.error}`);
  }
  notifyLocalWrite();
  return isErr(last) ? undefined : isRecord(last) ? last.meeting : undefined;
}

/** Apply `owner` to cards a task tool just wrote. Returns the owner (or undefined). */
function applyCardOwner(cardIds: string[], a: Record<string, unknown>, errors: string[]): unknown {
  if (a.owner === undefined) return undefined;
  let last: unknown;
  for (const cardId of cardIds) {
    try {
      last = setCardOwnerArg(peopleDb(), peopleContext(), { cardId, owner: a.owner });
    } catch (e) {
      last = { error: e instanceof Error ? e.message : String(e) };
    }
    if (isErr(last)) errors.push(`owner ${cardId}: ${last.error}`);
  }
  notifyLocalWrite();
  return isErr(last) ? undefined : isRecord(last) ? last.owner : undefined;
}

/** JSON-schema pieces for the People arguments (the words come from shared/agent/people-tools.ts). */
const ATTENDEES_ARG = { ...A, description: PEOPLE_ARG_DESCRIPTIONS.attendees };
const DATE_ARG = { ...S, description: PEOPLE_ARG_DESCRIPTIONS.date };
const OWNER_ARG = { ...S, description: PEOPLE_ARG_DESCRIPTIONS.owner };

const PEOPLE_TOOL_DEF: ToolDef = {
  name: "people",
  description: PEOPLE_TOOL_DESCRIPTION,
  params: '{ "action": "query"|"get"|"timeline"|"relationships"|"teams"|"upsert"|"link"|"archive"|"merge"|"team_upsert"|"team_delete", "personId"?: string, "name"?: string, ... }',
  jsonSchema: obj({
    action: { type: "string", enum: ["query", "get", "timeline", "relationships", "teams", "upsert", "link", "archive", "merge", "team_upsert", "team_delete"] },
    personId: { ...S, description: PD.personId },
    name: { ...S, description: PD.name },
    relationship: { ...S, description: PD.relationship },
    status: { type: "string", enum: [...PEOPLE_STATUSES], description: PD.status },
    aliases: { ...A, description: PD.aliases },
    emails: { ...A, description: PD.emails },
    relationships: {
      type: "array",
      items: obj({ type: { type: "string", enum: [...RELATIONSHIP_TYPES] }, label: { ...S, description: PD.relationshipLabel } }, ["type"]),
      description: PD.relationships,
    },
    cadence: { type: "string", enum: [...CADENCES, ""], description: PD.cadence },
    title: { ...S, description: PD.title },
    team: { ...S, description: PD.team },
    teamInfo: {
      ...obj({
        kind: { type: "string", enum: [...TEAM_KINDS] },
        description: S, lead: S, parentTeam: S, channel: S,
        links: { type: "array", items: obj({ label: S, url: S }, ["url"]) },
        members: A, role: S, removeMembers: A, rename: S, mergeInto: S,
      }),
      description: PD.teamInfo,
    },
    location: { ...S, description: PD.location },
    timezone: { ...S, description: PD.timezone },
    slackId: { ...S, description: PD.slackId },
    personaNoteId: { ...S, description: PD.personaNoteId },
    link: { type: "string", enum: [...LINK_KINDS], description: PD.link },
    otherPersonId: { ...S, description: PD.otherPersonId },
    endedAt: { ...S, description: PD.endedAt },
    label: { ...S, description: PD.label },
    noteId: { ...S, description: PD.noteId },
    remove: { type: "boolean", description: PD.remove },
    limit: { type: "number" },
  }, ["action"]),
  run: (a) => {
    // The caller's workspace decides; a person id from another workspace is then "not found".
    let workspaceId = peopleWorkspaceId() ?? "";
    if (typeof a.personId === "string" && a.personId) {
      workspaceId = q.workspaceIdForPerson(a.personId) ?? workspaceId;
    }
    const result = peopleTool(peopleDb(), peopleContext(), { ...a, workspaceId });
    if (!isReadCall("people", a)) notifyLocalWrite();
    return result;
  },
};

const BASE_TOOLS: ToolDef[] = [
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
        const hits = await semanticHits("tasks", query, projectId ? 50 : Math.min(limit, 20));
        if (isErr(hits) || !projectId) return hits;
        return hits.filter((h) => q.getCard(h.id)?.project_id === projectId).slice(0, limit);
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
    params: '{ "projectId": string, "title": string, "content": string, "folder"?: string, "attendees"?: string[], "date"?: string }',
    jsonSchema: obj({ projectId: S, title: S, content: S, folder: S, attendees: ATTENDEES_ARG, date: DATE_ARG }, ["projectId", "title", "content"]),
    run: (a) => {
      const id = q.ensureNote(str(a.projectId), str(a.title), str(a.content), str(a.folder));
      const errors: string[] = [];
      const meeting = applyNoteMeeting([id], a, errors);
      return summarize({ id, ...(meeting !== undefined ? { meeting } : {}) }, errors);
    },
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
    params: '{ "noteIds": string[], "title"?: string, "folder"?: string, "projectId"?: string, "isPinned"?: boolean, "tagNames"?: string[], "tagMode"?: "add"|"remove"|"set", "linkCardIds"?: string[], "unlinkCardIds"?: string[], "attendees"?: string[], "date"?: string }',
    jsonSchema: obj({
      noteIds: A, title: S, folder: S, projectId: S, isPinned: { type: "boolean" },
      tagNames: A, tagMode: TAG_MODE_SCHEMA, linkCardIds: A, unlinkCardIds: A,
      attendees: ATTENDEES_ARG, date: DATE_ARG,
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
      const oldTitle = a.title !== undefined ? q.getNote(ids[0])?.title : undefined;
      if (a.title !== undefined) step("rename", () => q.renameNote(ids[0], str(a.title)));
      if (a.folder !== undefined) step("move", () => q.moveNotesToFolder(ids, str(a.folder)));
      for (const id of ids) {
        if (str(a.projectId)) step(`move ${id}`, () => q.moveNoteToProject(id, str(a.projectId)));
        if (typeof a.isPinned === "boolean") step(`pin ${id}`, () => q.pinNote(id, a.isPinned as boolean));
        if (strArray(a.tagNames).length > 0) step(`tag ${id}`, () => q.tagNote(id, strArray(a.tagNames), tagMode(a.tagMode)));
        for (const cardId of strArray(a.linkCardIds)) step(`link ${id}→${cardId}`, () => q.linkNoteToTask(id, cardId));
        for (const cardId of strArray(a.unlinkCardIds)) step(`unlink ${id}→${cardId}`, () => q.unlinkNoteFromTask(id, cardId));
      }
      const live = ids.filter((id) => q.getNote(id));
      if (a.attendees !== undefined || a.date !== undefined) for (const id of ids) if (!live.includes(id)) errors.push(`attendees ${id}: Note not found`);
      const meeting = applyNoteMeeting(live, a, errors);
      const notes = ids.map((id) => q.getNote(id)).filter((n) => n !== null).map((n) => ({ id: n!.id, title: n!.title }));
      // Renames report old and new title (an empty list when the title was already that); other fields are not measured.
      const renamed = oldTitle !== undefined && notes[0]
        ? { changes: notes[0].title !== oldTitle ? [{ id: notes[0].id, title: notes[0].title, field: "title", from: oldTitle, to: notes[0].title } satisfies ToolChange] : [] }
        : {};
      const met = meeting !== undefined ? { meeting } : {};
      return summarize(notes.length === 1 ? { ...notes[0], updated: true, ...renamed, ...met } : { updated: notes, ...renamed, ...met }, errors);
    },
  },
  {
    name: "create_task",
    description: "Create a task card. Place it with columnType (default backlog) or an explicit columnId. priority = low|medium|high|urgent; dueDate as YYYY-MM-DD.",
    params: '{ "projectId": string, "title": string, "description"?: string, "columnType"?: string, "columnId"?: string, "priority"?: string, "dueDate"?: string, "tagNames"?: string[], "linkNoteIds"?: string[], "owner"?: string }',
    jsonSchema: obj({
      projectId: S, title: S, description: S,
      columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
      columnId: S, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, dueDate: S,
      tagNames: A, linkNoteIds: A, owner: OWNER_ARG,
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
      const owner = applyCardOwner([id], a, errors);
      return summarize({ id, title: str(a.title), columnId, ...(owner !== undefined ? { owner } : {}) }, errors);
    },
  },
  {
    name: "update_tasks",
    description:
      "Update one or more task cards; only provided fields change. Move with columnType or columnId. Also tags, note links (linkNoteIds/unlinkNoteIds), and archived:true to archive. Set dueDate to \"\" to clear it.",
    params: '{ "cardIds": string[], "title"?: string, "description"?: string, "priority"?: string, "dueDate"?: string, "assignee"?: string, "columnType"?: string, "columnId"?: string, "archived"?: boolean, "tagNames"?: string[], "tagMode"?: "add"|"remove"|"set", "linkNoteIds"?: string[], "unlinkNoteIds"?: string[], "owner"?: string }',
    jsonSchema: obj({
      cardIds: A, title: S, description: S, owner: OWNER_ARG,
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
      const applied: string[] = [];
      const before = new Map(ids.map((id) => [id, q.getCardSnapshot(id)] as const));
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
        applied.push(id);
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
      const owner = applyCardOwner(applied, a, errors);
      const cards = ids.map((id) => q.getCard(id)).filter((c) => c !== null).map((c) => ({ id: c!.id, title: c!.title, columnId: c!.column_id }));
      const own = owner !== undefined ? { owner } : {};
      // A measured call always reports its list (empty = nothing changed), so a no-op is not shown as a change.
      // Description, tag and note-link updates are not in the snapshot, so an empty list is only
      // trustworthy when none were requested; otherwise leave `changes` out and the view falls back.
      const changes: ToolChange[] = ids.flatMap((id) => cardChanges(id, before.get(id), q.getCardSnapshot(id)));
      const unmeasured = a.description !== undefined || strArray(a.tagNames).length > 0 || strArray(a.linkNoteIds).length > 0 || strArray(a.unlinkNoteIds).length > 0 || a.owner !== undefined;
      const extra = ids.some((id) => before.get(id)) && (changes.length > 0 || !unmeasured) ? { changes } : {};
      return summarize(cards.length === 1 ? { ...cards[0], updated: true, ...extra, ...own } : { updated: cards, ...extra, ...own }, errors);
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
    name: "get_today",
    description:
      "What needs the user today, from this phone's synced data: overdue tasks, tasks due today, today's meetings, and people they are overdue to meet. Read-only. This is not the desktop's AI brief (that does not sync), so say so if asked for it.",
    params: "{}",
    jsonSchema: obj({}),
    run: () => {
      const d = loadLocalToday();
      const task = (x: (typeof d.overdue)[number]) => ({ id: x.id, title: x.title, dueDate: x.dueDate, project: x.projectName ?? null, priority: x.priority ?? null });
      return {
        today: "local",
        date: d.date,
        overdue: d.overdue.map(task),
        dueToday: d.dueToday.map(task),
        meetings: d.meetings.map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt ?? null })),
        peopleDue: d.peopleDue.map((p) => ({ id: p.id, name: p.name, daysOverCadence: p.daysOver })),
      };
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

/** Every built-in tool, People ones included (the flag decides which of them a session gets). */
export const TOOLS: ToolDef[] = [...BASE_TOOLS, PEOPLE_TOOL_DEF];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * The built-in tools for this device, each wrapped in the privacy filter: a
 * person marked private from agents on the desktop syncs here, and their
 * persona note must stay out of reads.
 */
export function builtinTools(): ToolDef[] {
  return TOOLS.map(guardPrivate);
}

/** Wrap a tool so private persona notes never reach (or get edited by) the model. */
function guardPrivate(t: ToolDef): ToolDef {
  return {
    ...t,
    run: async (args) => {
      let hidden = hiddenNoteIds();
      const reads = isReadCall(t.name, args);
      if (!reads) {
        const refused = refusesHiddenNoteWrite(hidden, t.name, args, (projectId, title) => q.findNoteByTitle(projectId, title)?.id);
        if (refused) return refused;
      }
      const result = await t.run(args);
      // Re-read: the call itself may have changed who is private (a person upsert), and a
      // write result can name a private persona note it didn't ask about (`personaNoteId`).
      // If the re-read fails, the pre-dispatch set still applies (never fail open).
      let now: ReadonlySet<string> = hidden;
      try {
        now = hiddenNoteIds();
      } catch {
        // keep the pre-dispatch set
      }
      return scrubHidden(new Set([...hidden, ...now]), result, reads ? args : {});
    },
  };
}

/** Private persona note ids. Only a missing People table means "nothing to hide"; any other failure fails the call. */
function hiddenNoteIds(): ReadonlySet<string> {
  try {
    return agentHiddenNoteIds(peopleDb());
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return new Set();
    throw e;
  }
}

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
  "people", // reads and writes (upsert/link); listed as a write so it sits with the tools that change data
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
  return [...builtinTools(), ...services, ...mcp];
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
