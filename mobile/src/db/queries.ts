/**
 * Read-only queries for the mobile MVP screens.
 * All queries exclude tombstoned (deleted_at) and archived rows.
 */

import { getDb } from "./index";
import { inspectConflict, cleanConflictTitle } from "@cairn/shared/sync/conflict";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { buildNoteOutline, sliceLines, noteDigest } from "@cairn/shared/notes/toc";
import { notifyLocalWrite } from "@/sync/write-signal";

/** Client-generated collision-free id (mirrors desktop nanoid(12) scheme). */
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
function genId(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

/** The workspace id for a project (AI writes inherit the project's workspace). */
function workspaceIdForProject(projectId: string): string {
  const row = getDb().getFirstSync<{ workspace_id: string }>(
    "SELECT workspace_id FROM projects WHERE id = ?",
    projectId,
  );
  return row?.workspace_id ?? "";
}

export interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string | null;
  folder: string;
  tag_ids: string;
  updated_at: string;
  is_pinned?: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  icon: string | null;
}

export interface ColumnRow {
  id: string;
  project_id: string;
  name: string;
  order: number;
}

export interface CardRow {
  id: string;
  column_id: string;
  project_id: string;
  title: string;
  description: string | null;
  priority: string;
  tag_ids: string;
  order: number;
  due_date?: string | null;
  assignee?: string | null;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

/** Parse a JSON `tag_ids` column into an id array (tolerant of bad data). */
function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve an array of tag ids to full tag rows (name + colour), skipping unknowns. */
export function tagsForIds(tagIds: string[]): TagRow[] {
  if (tagIds.length === 0) return [];
  const db = getDb();
  const placeholders = tagIds.map(() => "?").join(",");
  const rows = db.getAllSync<TagRow>(
    `SELECT id, name, color FROM tags WHERE deleted_at IS NULL AND id IN (${placeholders})`,
    ...(tagIds as never[]),
  );
  // Preserve the stored order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return tagIds.map((id) => byId.get(id)).filter((r): r is TagRow => !!r);
}

/** Tags attached to a note, resolved from its tag_ids JSON. */
export function tagsForNote(note: { tag_ids: string }): TagRow[] {
  return tagsForIds(parseIds(note.tag_ids));
}

/** Tags attached to a card, resolved from its tag_ids JSON. */
export function tagsForCard(card: { tag_ids: string }): TagRow[] {
  return tagsForIds(parseIds(card.tag_ids));
}

/** Distinct tags used across a set of notes, for a project's filter chip row. */
export function tagsForNotes(notes: { tag_ids: string }[]): TagRow[] {
  const seen = new Set<string>();
  for (const n of notes) for (const id of parseIds(n.tag_ids)) seen.add(id);
  return tagsForIds([...seen]);
}

/**
 * Batch-resolve tags for a whole list of rows in a SINGLE query, returning a
 * `Map<rowId, TagRow[]>` that preserves each row's stored tag order.
 *
 * This replaces the per-row `tagsForNote()`/`tagsForCard()` calls that fired one
 * `SELECT … IN` per list item on the JS thread (an N+1 that stalled note-list /
 * board / calendar renders). Call it once per list (memoised on the rows) and
 * look each row up by id when rendering.
 */
export function tagsByRow<T extends { id: string; tag_ids: string }>(
  rows: T[],
): Map<string, TagRow[]> {
  const result = new Map<string, TagRow[]>();
  if (rows.length === 0) return result;

  // Collect every distinct tag id across all rows, then resolve them at once.
  const perRow = new Map<string, string[]>();
  const all = new Set<string>();
  for (const r of rows) {
    const ids = parseIds(r.tag_ids);
    perRow.set(r.id, ids);
    for (const id of ids) all.add(id);
  }
  if (all.size === 0) {
    for (const r of rows) result.set(r.id, []);
    return result;
  }

  const byId = new Map(tagsForIds([...all]).map((tag) => [tag.id, tag]));
  for (const r of rows) {
    const ids = perRow.get(r.id) ?? [];
    result.set(
      r.id,
      ids.map((id) => byId.get(id)).filter((tag): tag is TagRow => !!tag),
    );
  }
  return result;
}

/** Parse a note/card tag_ids JSON column to an id array (exported for filters). */
export function noteTagIds(note: { tag_ids: string }): string[] {
  return parseIds(note.tag_ids);
}

/** All workspace tags, alphabetical — the source list for a tag picker. */
export function listAllTags(): TagRow[] {
  return getDb().getAllSync<TagRow>(
    "SELECT id, name, color FROM tags WHERE deleted_at IS NULL ORDER BY name",
  );
}

/**
 * Write a note's tag set. Stored as a JSON id array (matching desktop's
 * tag_ids). Plain UPDATE so the capture triggers stage it for sync.
 */
export function setNoteTags(noteId: string, tagIds: string[]): void {
  getDb().runSync(
    `UPDATE notes SET tag_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    JSON.stringify(tagIds),
    new Date().toISOString(),
    noteId,
  );
  notifyLocalWrite();
}

/** Write a card's tag set (JSON id array). Plain UPDATE → staged for sync. */
export function setCardTags(cardId: string, tagIds: string[]): void {
  getDb().runSync(
    `UPDATE task_cards SET tag_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    JSON.stringify(tagIds),
    new Date().toISOString(),
    cardId,
  );
  notifyLocalWrite();
}

const LIVE = "deleted_at IS NULL AND archived_at IS NULL";

/**
 * SQL fragment excluding conflict-copy note rows (id like `..._conflict_...`).
 * Conflict copies are surfaced separately via listConflictCopies() so they
 * don't clutter the normal note lists / counts.
 */
const NOT_CONFLICT = `id NOT LIKE '%\\_conflict\\_%' ESCAPE '\\'`;

export function listProjects(): ProjectRow[] {
  return getDb().getAllSync<ProjectRow>(
    `SELECT id, name, icon FROM projects WHERE ${LIVE} ORDER BY name`,
  );
}

export function getProject(id: string): ProjectRow | null {
  return (
    getDb().getFirstSync<ProjectRow>(
      `SELECT id, name, icon FROM projects WHERE id = ? AND ${LIVE}`,
      id,
    ) ?? null
  );
}

/** Note + card counts per project, for the projects list. */
export interface ProjectSummary extends ProjectRow {
  noteCount: number;
  cardCount: number;
}

export function listProjectSummaries(): ProjectSummary[] {
  const db = getDb();
  const projects = listProjects();
  if (projects.length === 0) return [];

  // Count notes + cards for ALL projects in two grouped queries instead of two
  // COUNT(*) per project (an N+1 that scaled the projects list linearly). The
  // GROUP BY tallies every project in one pass; missing keys default to 0.
  const noteCounts = new Map<string, number>();
  for (const r of db.getAllSync<{ project_id: string; c: number }>(
    `SELECT project_id, COUNT(*) c FROM notes
     WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT} GROUP BY project_id`,
  )) {
    noteCounts.set(r.project_id, r.c);
  }
  const cardCounts = new Map<string, number>();
  for (const r of db.getAllSync<{ project_id: string; c: number }>(
    `SELECT project_id, COUNT(*) c FROM task_cards WHERE ${LIVE} GROUP BY project_id`,
  )) {
    cardCounts.set(r.project_id, r.c);
  }

  return projects.map((p) => ({
    ...p,
    noteCount: noteCounts.get(p.id) ?? 0,
    cardCount: cardCounts.get(p.id) ?? 0,
  }));
}

/** Distinct folders within a project (empty string = project root). */
export function listFolders(projectId: string): string[] {
  const rows = getDb().getAllSync<{ folder: string }>(
    `SELECT DISTINCT folder FROM notes WHERE ${LIVE} AND type='note' AND project_id = ? ORDER BY folder`,
    projectId,
  );
  return rows.map((r) => r.folder ?? "");
}

export function listNotes(projectId?: string): NoteRow[] {
  const db = getDb();
  // Pinned-first, then most-recently-updated — matches the desktop
  // getProjectNotes selector. buildFolderTree preserves this order within each
  // folder + the root list.
  if (projectId) {
    return db.getAllSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes
       WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND project_id = ?
       ORDER BY is_pinned DESC, updated_at DESC`,
      projectId,
    );
  }
  return db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT}
     ORDER BY is_pinned DESC, updated_at DESC`,
  );
}

export function getNote(id: string): NoteRow | null {
  return (
    getDb().getFirstSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes WHERE id = ?`,
      id,
    ) ?? null
  );
}

/**
 * Token-cheap note read for the chat agent. Small notes return full content;
 * long ones return a line-numbered outline + short intro + totalLines instead of
 * the whole body (the model then calls getNoteRange for the slice it needs).
 * `fullCharBudget` is the content length under which we just return everything.
 */
export function getNoteForAgent(id: string, fullCharBudget = 1500): unknown {
  const note = getNote(id);
  if (!note) return { error: "Note not found" };
  const content = note.content ?? "";
  if (content.length <= fullCharBudget) {
    return { id: note.id, title: note.title, folder: note.folder ?? "", content, mode: "full" };
  }
  const outline = buildNoteOutline(content);
  const intro = content.slice(0, 400);
  return {
    id: note.id,
    title: note.title,
    folder: note.folder ?? "",
    mode: "outline",
    totalLines: outline.totalLines,
    intro: intro + (content.length > 400 ? "…" : ""),
    outline: outline.headings,
    hint: "Large note — call get_note_range(id, startLine, endLine) to read a section, or get_note for the whole thing.",
  };
}

/** Return an inclusive 1-based line range of a note's content (for get_note_range). */
export function getNoteRange(id: string, startLine: number, endLine?: number): unknown {
  const note = getNote(id);
  if (!note) return { error: "Note not found" };
  return {
    id: note.id,
    title: note.title,
    startLine,
    endLine: endLine ?? null,
    content: sliceLines(note.content ?? "", startLine, endLine),
  };
}

export function listColumns(projectId: string): ColumnRow[] {
  return getDb().getAllSync<ColumnRow>(
    `SELECT id, project_id, name, "order" FROM board_columns
     WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
    projectId,
  );
}

export function listCards(projectId: string): CardRow[] {
  return getDb().getAllSync<CardRow>(
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order" FROM task_cards
     WHERE ${LIVE} AND project_id = ? ORDER BY "order"`,
    projectId,
  );
}

/** Get a single card by id (for the card detail screen). */
export function getCard(id: string): CardRow | null {
  return (
    getDb().getFirstSync<CardRow>(
      `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, assignee FROM task_cards WHERE id = ?`,
      id,
    ) ?? null
  );
}

export function searchNotes(query: string): NoteRow[] {
  const q = `%${query}%`;
  return getDb().getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND (title LIKE ? OR content_text LIKE ?)
     ORDER BY updated_at DESC LIMIT 50`,
    q,
    q,
  );
}

/** Search live (non-archived) task cards by title or description. */
export function searchTasks(query: string): CardRow[] {
  const q = `%${query}%`;
  return getDb().getAllSync<CardRow>(
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, assignee FROM task_cards
     WHERE ${LIVE} AND (title LIKE ? OR description LIKE ?)
     ORDER BY updated_at DESC LIMIT 50`,
    q,
    q,
  );
}

/**
 * A task card that has a due date, enriched with its project name for the
 * workspace-wide Calendar view. `due_date` is guaranteed non-null here.
 * `is_done` is 1 when the card lives in a done-type column (so the calendar can
 * keep completed tasks out of the overdue tray).
 */
export interface CalendarCard extends CardRow {
  due_date: string;
  project_name: string;
  is_done: number;
}

/**
 * Live task cards that have a due date, for the Calendar view. Ordered by due
 * date so the agenda groups chronologically. Pass a projectId to scope to one
 * project (per-project calendar); omit for the workspace-wide calendar.
 */
export function listCardsWithDueDates(projectId?: string): CalendarCard[] {
  const db = getDb();
  const scope = projectId ? "AND c.project_id = ?" : "";
  const rows = db.getAllSync<CalendarCard>(
    `SELECT c.id, c.column_id, c.project_id, c.title, c.description, c.priority,
            c.tag_ids, c."order", c.due_date, c.assignee, p.name AS project_name,
            CASE WHEN col.type = 'done' THEN 1 ELSE 0 END AS is_done
     FROM task_cards c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN board_columns col ON col.id = c.column_id
     WHERE c.deleted_at IS NULL AND c.archived_at IS NULL
       AND c.due_date IS NOT NULL AND c.due_date != ''
       ${scope}
     ORDER BY c.due_date ASC, c."order" ASC`,
    ...((projectId ? [projectId] : []) as never[]),
  );
  return rows;
}

/**
 * Live task cards WITHOUT a due date, for the calendar's Unscheduled tray. Drag
 * one onto a day to schedule it. Scope to one project or omit for the
 * workspace-wide calendar. Ordered by most-recently-updated so freshly-created
 * tasks surface first.
 */
export function listUnscheduledCards(projectId?: string): CalendarCard[] {
  const db = getDb();
  const scope = projectId ? "AND c.project_id = ?" : "";
  return db.getAllSync<CalendarCard>(
    `SELECT c.id, c.column_id, c.project_id, c.title, c.description, c.priority,
            c.tag_ids, c."order", COALESCE(c.due_date, '') AS due_date, c.assignee, p.name AS project_name,
            CASE WHEN col.type = 'done' THEN 1 ELSE 0 END AS is_done
     FROM task_cards c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN board_columns col ON col.id = c.column_id
     WHERE c.deleted_at IS NULL AND c.archived_at IS NULL
       AND (c.due_date IS NULL OR c.due_date = '')
       ${scope}
     ORDER BY c.updated_at DESC`,
     ...((projectId ? [projectId] : []) as never[]),
  );
}

/**
 * Move a card to a different column. Plain UPDATE so capture triggers stage it
 * for sync. Mirrors the desktop moveCard's column change (order left as-is).
 */
export function moveCardToColumn(cardId: string, columnId: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    columnId,
    now,
    cardId,
  );
  notifyLocalWrite();
}

function plainText(md: string): string {
  return stripMarkdown(md);
}

// ── Knowledge graph ─────────────────────────────────────────────────────────

export type GraphNodeType = "project" | "note" | "card" | "tag";
export type GraphEdgeType =
  | "project-member"
  | "note-note"
  | "note-card"
  | "tag-member"
  | "semantic";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  title: string;
  /** Tag colour (tag nodes) or priority accent (card nodes), for rendering. */
  color?: string;
  priority?: string;
  /** Owning project id (note/card nodes) — used to draw cluster hulls. */
  projectId?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  /** Similarity (0–1) for 'semantic' edges; drives dash-line weight/threshold. */
  weight?: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Build the workspace knowledge graph from the SYNCABLE tables the mobile app
 * holds: projects, notes, cards and tags, wired by their explicit links
 * (project membership, note↔note wikilinks, note↔card links, tag membership).
 *
 * Unlike desktop this omits idea-flow and auto/semantic edges — mobile has no
 * idea_flow_* or embeddings tables — so it's a purely structural graph. Only
 * tags actually referenced by a scoped note/card become nodes, matching the
 * desktop's "used tags only" behaviour.
 */
export function getKnowledgeGraph(): KnowledgeGraph {
  const db = getDb();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const add = (n: GraphNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const projects = db.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE ${LIVE}`,
  );
  for (const p of projects) add({ id: p.id, type: "project", title: p.name });

  const notes = db.getAllSync<{
    id: string;
    project_id: string;
    title: string;
    tag_ids: string;
    linked_note_ids: string;
  }>(
    `SELECT id, project_id, title, tag_ids, linked_note_ids FROM notes
     WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT}`,
  );
  for (const n of notes) {
    add({ id: n.id, type: "note", title: n.title || "Untitled", projectId: n.project_id });
    if (nodeIds.has(n.project_id)) edges.push({ source: n.project_id, target: n.id, type: "project-member" });
    // note↔note links: emit once (lower id as source) to avoid duplicate pairs.
    for (const linked of parseIds(n.linked_note_ids)) {
      if (n.id < linked) edges.push({ source: n.id, target: linked, type: "note-note" });
    }
  }

  const cards = db.getAllSync<{
    id: string;
    project_id: string;
    title: string;
    priority: string;
    tag_ids: string;
    linked_note_ids: string;
  }>(
    `SELECT id, project_id, title, priority, tag_ids, linked_note_ids FROM task_cards
     WHERE ${LIVE}`,
  );
  for (const c of cards) {
    add({ id: c.id, type: "card", title: c.title, priority: c.priority, projectId: c.project_id });
    if (nodeIds.has(c.project_id)) edges.push({ source: c.project_id, target: c.id, type: "project-member" });
    for (const noteId of parseIds(c.linked_note_ids)) {
      if (nodeIds.has(noteId)) edges.push({ source: noteId, target: c.id, type: "note-card" });
    }
  }

  // Only tags actually used by a scoped note/card become nodes.
  const usedTagIds = new Set<string>();
  for (const n of notes) for (const tid of parseIds(n.tag_ids)) usedTagIds.add(tid);
  for (const c of cards) for (const tid of parseIds(c.tag_ids)) usedTagIds.add(tid);
  if (usedTagIds.size > 0) {
    const tagRows = tagsForIds([...usedTagIds]);
    const tagById = new Map(tagRows.map((tr) => [tr.id, tr]));
    for (const tid of usedTagIds) {
      const tag = tagById.get(tid);
      if (!tag) continue;
      add({ id: tag.id, type: "tag", title: tag.name, color: tag.color });
    }
    for (const n of notes) for (const tid of parseIds(n.tag_ids)) {
      if (nodeIds.has(tid)) edges.push({ source: n.id, target: tid, type: "tag-member" });
    }
    for (const c of cards) for (const tid of parseIds(c.tag_ids)) {
      if (nodeIds.has(tid)) edges.push({ source: c.id, target: tid, type: "tag-member" });
    }
  }

  return { nodes, edges };
}

/** Find a note by exact title within a project (for ensure_note upsert). */
export function findNoteByTitle(projectId: string, title: string): NoteRow | null {
  return (
    getDb().getFirstSync<NoteRow>(
      `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
       WHERE ${LIVE} AND type='note' AND project_id = ? AND title = ? LIMIT 1`,
      projectId,
      title,
    ) ?? null
  );
}

/** Resolve a note id by title across the whole workspace (case-insensitive) — for wikilinks.
 *  Deterministic: on a title collision, the most-recently-updated note wins (not arbitrary). */
export function findNoteIdByTitle(title: string): string | null {
  const row = getDb().getFirstSync<{ id: string }>(
    `SELECT id FROM notes WHERE ${LIVE} AND type='note' AND lower(title) = lower(?) ORDER BY updated_at DESC LIMIT 1`,
    title,
  );
  return row?.id ?? null;
}

/** Resolve a card id by title across the whole workspace (case-insensitive) — for wikilinks.
 *  Deterministic on collision (most-recently-updated wins). */
export function findCardIdByTitle(title: string): string | null {
  const row = getDb().getFirstSync<{ id: string }>(
    `SELECT id FROM task_cards WHERE ${LIVE} AND lower(title) = lower(?) ORDER BY updated_at DESC LIMIT 1`,
    title,
  );
  return row?.id ?? null;
}

/** Look up a live note's canonical title by id (null if not a live note) — for [[id]] wikilinks. */
export function liveNoteTitleById(id: string): string | null {
  const row = getDb().getFirstSync<{ title: string }>(
    `SELECT title FROM notes WHERE id = ? AND ${LIVE} AND type='note'`,
    id,
  );
  return row?.title ?? null;
}

/** Look up a live card's canonical title by id (null if not a live card) — for [[id]] wikilinks. */
export function liveCardTitleById(id: string): string | null {
  const row = getDb().getFirstSync<{ title: string }>(
    `SELECT title FROM task_cards WHERE id = ? AND ${LIVE}`,
    id,
  );
  return row?.title ?? null;
}

/** Create a note. Returns its id. Plain INSERT so capture triggers stage it. */
export function createNote(projectId: string, title: string, content: string, folder = ""): string {
  const id = genId();
  const now = new Date().toISOString();
  getDb().runSync(
    `INSERT INTO notes (id, project_id, workspace_id, title, content, content_text, folder, type, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'note', ?, ?, 0)`,
    id,
    projectId,
    workspaceIdForProject(projectId),
    title,
    content,
    plainText(content),
    folder,
    now,
    now,
  );
  notifyLocalWrite();
  return id;
}

/** Create-or-update a note by title within a project. Returns its id. */
export function ensureNote(projectId: string, title: string, content: string, folder = ""): string {
  const existing = findNoteByTitle(projectId, title);
  if (existing) {
    updateNote(existing.id, title, content);
    return existing.id;
  }
  return createNote(projectId, title, content, folder);
}

/** Append text to a note's body. */
export function appendToNote(noteId: string, text: string): boolean {
  const note = getNote(noteId);
  if (!note) return false;
  const next = `${note.content ?? ""}${note.content ? "\n\n" : ""}${text}`;
  updateNote(noteId, note.title, next);
  return true;
}

/** Replace an exact substring in a note's body. Returns false if not found. */
export function patchNote(noteId: string, oldString: string, newString: string): boolean {
  const note = getNote(noteId);
  if (!note || !note.content || !note.content.includes(oldString)) return false;
  updateNote(noteId, note.title, note.content.replace(oldString, newString));
  return true;
}

/** Create a task card in a column. Returns its id. */
export function createTask(projectId: string, columnId: string, title: string, opts?: { description?: string; priority?: string }): string {
  const id = genId();
  const now = new Date().toISOString();
  // Append to the end of the target column: next order = max(order)+1 among the
  // column's live cards (hardcoding 0 made every new card collide at the top).
  const maxRow = getDb().getFirstSync<{ maxOrder: number | null }>(
    `SELECT MAX("order") AS maxOrder FROM task_cards WHERE column_id = ? AND deleted_at IS NULL`,
    columnId,
  );
  const order = (maxRow?.maxOrder ?? -1) + 1;
  getDb().runSync(
    `INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description, priority, "order", created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    id,
    columnId,
    projectId,
    workspaceIdForProject(projectId),
    title,
    opts?.description ?? null,
    opts?.priority ?? "medium",
    order,
    now,
    now,
  );
  notifyLocalWrite();
  return id;
}

/** Update a task card's fields (title/description/priority/dueDate/assignee). */
export function updateTask(
  cardId: string,
  patch: { title?: string; description?: string; priority?: string; dueDate?: string | null; assignee?: string | null },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); vals.push(patch.title); }
  if (patch.description !== undefined) { sets.push("description = ?"); vals.push(patch.description); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); vals.push(patch.priority); }
  // dueDate/assignee use explicit-key detection so they can be cleared to NULL.
  if ("dueDate" in patch) { sets.push("due_date = ?"); vals.push(patch.dueDate || null); }
  if ("assignee" in patch) { sets.push("assignee = ?"); vals.push(patch.assignee || null); }
  if (sets.length === 0) return;
  sets.push("updated_at = ?"); vals.push(new Date().toISOString());
  sets.push("version = version + 1");
  vals.push(cardId);
  getDb().runSync(`UPDATE task_cards SET ${sets.join(", ")} WHERE id = ?`, ...(vals as never[]));
  notifyLocalWrite();
}

/**
 * Archive a task card (set archived_at). LIVE-scoped lists exclude it, so it
 * disappears from the board — mirroring the desktop archive. Plain UPDATE, so
 * the capture triggers publish the change to peers.
 */
export function archiveCard(cardId: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE task_cards SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    now,
    now,
    cardId,
  );
  notifyLocalWrite();
}

/**
 * Soft-delete a task card (set deleted_at). LIVE-scoped lists exclude it and the
 * capture triggers publish the tombstone to peers — mirrors softDeleteNote.
 */
export function deleteCard(cardId: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE task_cards SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    now,
    now,
    cardId,
  );
  notifyLocalWrite();
}

// ── Aggregate context tools (mirror desktop read-tools-pure) ────────────────

/**
 * Workspace orientation — projects (with their columns) + tags. Mirrors the
 * desktop get_cairn_context so the agent can get IDs + structure in one call.
 */
export function getCairnContext(): unknown {
  const db = getDb();
  const projects = db.getAllSync<{ id: string; name: string; icon: string | null }>(
    `SELECT id, name, icon FROM projects WHERE ${LIVE} ORDER BY name`,
  );
  const tags = db.getAllSync<{ id: string; name: string; color: string }>(
    "SELECT id, name, color FROM tags WHERE deleted_at IS NULL ORDER BY name",
  );
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      columns: db.getAllSync<{ id: string; name: string; type: string }>(
        `SELECT id, name, type FROM board_columns WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
        p.id,
      ),
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}

/**
 * Rich single-call project summary — project + columns, noteCount, pinned notes
 * (with truncated content), open tasks grouped by column, recent activity.
 * Mirrors the desktop get_project_context_pack so the mobile agent can produce
 * an equally rich project summary.
 */
export function getProjectContextPack(projectId: string): unknown {
  const db = getDb();
  const project = db.getFirstSync<{ id: string; name: string; description: string | null; status: string; priority: string; due_date: string | null }>(
    `SELECT id, name, description, status, priority, due_date FROM projects WHERE id = ? AND ${LIVE}`,
    projectId,
  );
  if (!project) return { error: "Project not found" };

  const columns = db.getAllSync<{ id: string; name: string; type: string }>(
    `SELECT id, name, type FROM board_columns WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
    projectId,
  );

  const notes = db.getAllSync<NoteRow & { is_pinned: number }>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes
     WHERE ${LIVE} AND type='note' AND project_id = ? ORDER BY updated_at DESC`,
    projectId,
  );

  // Cap pinned notes: 5 most-recent (notes are already ORDER BY updated_at DESC)
  // with a short excerpt. The model uses get_note to read the rest. Uncapped this
  // was a major context-overflow source (1000 chars × unbounded count).
  const PINNED_CAP = 5;
  const pinnedAll = notes.filter((n) => n.is_pinned);
  const pinnedNotes = pinnedAll.slice(0, PINNED_CAP).map((n) => ({
    id: n.id,
    title: n.title,
    folder: n.folder ?? "",
    // Outline (headings) when the note is structured — a compact semantic
    // summary; short excerpt otherwise. The model reads full text via get_note.
    ...noteDigest(n.content ?? "", 300),
  }));

  const cards = db.getAllSync<CardRow & { due_date: string | null; updated_at: string }>(
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, updated_at FROM task_cards
     WHERE ${LIVE} AND project_id = ?`,
    projectId,
  );

  // Cap open tasks to a total budget across columns, with a short description
  // preview. The model uses get_task for full detail.
  const TASK_CAP = 20;
  const TASK_PREVIEW = 120;
  let taskBudget = TASK_CAP;
  const openTasks = columns
    .filter((c) => c.type !== "done")
    .map((col) => ({
      columnType: col.type,
      columnId: col.id,
      tasks: cards
        .filter((c) => c.column_id === col.id)
        .slice(0, Math.max(0, taskBudget))
        .map((c) => {
          taskBudget -= 1;
          const desc = c.description ?? "";
          const t: Record<string, unknown> = { id: c.id, title: c.title, priority: c.priority };
          if (desc) t.description = desc.length > TASK_PREVIEW ? desc.slice(0, TASK_PREVIEW) + "… (use get_task)" : desc;
          if (c.due_date) t.dueDate = c.due_date;
          return t;
        }),
    }))
    .filter((col) => col.tasks.length > 0);

  const recentActivity = [
    ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updated_at })),
    ...cards.map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updated_at })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10)
    .map(({ type, id, title }) => ({ type, id, title }));

  const proj: Record<string, unknown> = { id: project.id, name: project.name };
  if (project.description) proj.description = project.description;
  if (project.status && project.status !== "active") proj.status = project.status;
  if (project.priority && project.priority !== "medium") proj.priority = project.priority;
  if (project.due_date) proj.dueDate = project.due_date;
  proj.columns = columns;

  const openTaskCount = cards.filter((c) => {
    const col = columns.find((x) => x.id === c.column_id);
    return col && col.type !== "done";
  }).length;

  return {
    project: proj,
    noteCount: notes.length,
    pinnedNotes,
    pinnedNotesTotal: pinnedAll.length,
    openTasks,
    openTaskCount,
    recentActivity,
  };
 }

/** Project metadata for the Overview header (beyond the id/name/icon ProjectRow). */
export interface ProjectMeta {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  tag_ids: string;
}

/** A board column including its `type` (needed to find the done column + order + colour). */
export interface OverviewColumn extends ColumnRow {
  type: string;
}

/** A card with the extra fields the Overview needs (due date + updated_at). */
export interface OverviewCard extends CardRow {
  updated_at: string;
}

export interface ProjectOverviewData {
  project: ProjectMeta | null;
  columns: OverviewColumn[];
  cards: OverviewCard[];
  notes: NoteRow[];
}

/**
 * Single focused read backing the mobile per-project Overview segment. Unlike
 * listColumns/listCards (which are tuned for the board and omit type/due/updated
 * fields), this selects exactly what computeProjectMetrics() needs so the
 * Overview stays self-contained and doesn't widen the hot board queries.
 */
export function getProjectOverview(projectId: string): ProjectOverviewData {
  const db = getDb();
  const project =
    db.getFirstSync<ProjectMeta>(
      `SELECT id, name, icon, description, status, priority, due_date, tag_ids
       FROM projects WHERE id = ? AND ${LIVE}`,
      projectId,
    ) ?? null;

  const columns = db.getAllSync<OverviewColumn>(
    `SELECT id, project_id, name, type, "order" FROM board_columns
     WHERE deleted_at IS NULL AND project_id = ? ORDER BY "order"`,
    projectId,
  );

  const cards = db.getAllSync<OverviewCard>(
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, updated_at
     FROM task_cards WHERE ${LIVE} AND project_id = ? ORDER BY "order"`,
    projectId,
  );

  const notes = db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at, is_pinned FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND project_id = ?
     ORDER BY is_pinned DESC, updated_at DESC`,
    projectId,
  );

  return { project, columns, cards, notes };
}

/**
 * Update a note's title/body locally. A plain UPDATE so the capture triggers
 * stage the change into sync_pending; syncNow() drains + publishes it.
 * content_text is kept as a plain-text mirror for search (matches desktop).
 */
export function updateNote(id: string, title: string, content: string): void {
  const now = new Date().toISOString();
  const contentText = stripMarkdown(content);
  getDb().runSync(
    `UPDATE notes SET title = ?, content = ?, content_text = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
    title,
    content,
    contentText,
    now,
    id,
  );
  notifyLocalWrite();
}

/**
 * Rename a note and rewrite inbound `[[wikilinks]]` in other notes so links stay
 * intact — mirrors the desktop rename_note (minus the .md file write; mobile is
 * SQLite-only). Rejects a title collision within the same project. Returns an
 * error object on failure, or the new title on success.
 */
export function renameNote(id: string, newTitle: string): { error: string } | { title: string } {
  const title = newTitle.trim();
  if (!title) return { error: "newTitle is required" };
  const note = getNote(id);
  if (!note) return { error: "Note not found" };
  if (note.title === title) return { title };

  // Reject a same-project title collision (case-insensitive, live notes only).
  const collision = getDb().getFirstSync<{ id: string }>(
    `SELECT id FROM notes WHERE ${LIVE} AND type='note' AND project_id = ? AND id <> ? AND lower(title) = lower(?) LIMIT 1`,
    note.project_id,
    id,
    title,
  );
  if (collision) return { error: `A note titled "${title}" already exists in this project` };

  const oldLink = `[[${note.title}]]`;
  const newLink = `[[${title}]]`;
  const now = new Date().toISOString();

  // Rewrite wikilinks in every other live note that references the old title.
  const linked = getDb().getAllSync<{ id: string; content: string }>(
    `SELECT id, content FROM notes WHERE ${LIVE} AND id <> ? AND content LIKE ?`,
    id,
    `%${oldLink}%`,
  );
  getDb().withTransactionSync(() => {
    getDb().runSync(
      `UPDATE notes SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      title,
      now,
      id,
    );
    for (const other of linked) {
      const next = other.content.split(oldLink).join(newLink);
      getDb().runSync(
        `UPDATE notes SET content = ?, content_text = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        next,
        stripMarkdown(next),
        now,
        other.id,
      );
    }
  });
  notifyLocalWrite();
  return { title };
}

/** Move notes to a folder (empty string = project root). Returns the count moved. */
export function moveNotesToFolder(noteIds: string[], folder: string): number {
  if (noteIds.length === 0) return 0;
  const now = new Date().toISOString();
  const placeholders = noteIds.map(() => "?").join(", ");
  const res = getDb().runSync(
    `UPDATE notes SET folder = ?, updated_at = ?, version = version + 1
     WHERE ${LIVE} AND type='note' AND id IN (${placeholders})`,
    folder,
    now,
    ...(noteIds as never[]),
  );
  notifyLocalWrite();
  return res.changes ?? 0;
}

/** Pin or unpin a note. Plain UPDATE so the capture triggers publish it. */
export function pinNote(id: string, pinned: boolean): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE notes SET is_pinned = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    pinned ? 1 : 0,
    now,
    id,
  );
  notifyLocalWrite();
}

// ── Conflict copies ─────────────────────────────────────────────────────────

export interface ConflictCopy {
  /** The conflict-copy row id. */
  id: string;
  /** Clean title (suffix stripped). */
  title: string;
  content: string | null;
  projectId: string;
  folder: string;
  updatedAt: string;
  /** The device that produced the copy. */
  deviceId: string | null;
  /** The id of the original note this conflicts with (may be missing if deleted). */
  originalId: string | null;
  /** The current live original note (null if it was deleted). */
  original: NoteRow | null;
}

/**
 * All conflict-copy notes (body diverged during offline edits and were kept
 * rather than lost). Surfaced in the Conflicts UI for manual resolution.
 */
export function listConflictCopies(): ConflictCopy[] {
  const db = getDb();
  const rows = db.getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'
     ORDER BY updated_at DESC`,
  );
  return rows.map((r) => {
    const info = inspectConflict(r.id, r.title);
    return {
      id: r.id,
      title: cleanConflictTitle(r.title),
      content: r.content,
      projectId: r.project_id,
      folder: r.folder,
      updatedAt: r.updated_at,
      deviceId: info.deviceId,
      originalId: info.originalId,
      original: info.originalId ? getNote(info.originalId) : null,
    };
  });
}

/** Count of unresolved conflict copies — for the header badge. */
export function conflictCount(): number {
  const row = getDb().getFirstSync<{ c: number }>(
    `SELECT COUNT(*) c FROM notes
     WHERE ${LIVE} AND type = 'note' AND id LIKE '%\\_conflict\\_%' ESCAPE '\\'`,
  );
  return row?.c ?? 0;
}

/**
 * Resolve a conflict by keeping the CONFLICT-COPY's body: overwrite the
 * original note with the copy's content, then delete the copy. If the original
 * no longer exists, the copy is simply promoted (renamed to its clean title).
 * Plain writes so the capture triggers publish the resolution to peers.
 */
export function resolveConflictKeepCopy(copyId: string): void {
  const copy = getNote(copyId);
  if (!copy) return;
  const info = inspectConflict(copy.id, copy.title);
  const cleanTitle = cleanConflictTitle(copy.title);
  const original = info.originalId ? getNote(info.originalId) : null;

  if (original && !isTombstoned(original.id)) {
    updateNote(original.id, cleanTitle, copy.content ?? "");
    softDeleteNote(copy.id);
  } else {
    // No live original — just strip the conflict suffix so the copy stands in.
    updateNote(copy.id, cleanTitle, copy.content ?? "");
  }
}

/**
 * Resolve a conflict by keeping the ORIGINAL note as-is and discarding the
 * conflict copy (soft delete → tombstone syncs to peers).
 */
export function resolveConflictKeepOriginal(copyId: string): void {
  softDeleteNote(copyId);
}

/** Soft-delete a note (tombstone) so the deletion propagates via sync. */
export function softDeleteNote(id: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE notes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    now,
    now,
    id,
  );
  notifyLocalWrite();
}

function isTombstoned(id: string): boolean {
  const row = getDb().getFirstSync<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM notes WHERE id = ?`,
    id,
  );
  return !row || row.deleted_at != null;
}

// ---------------------------------------------------------------------------
// On-device semantic-search index (note_embeddings). Local-only, never synced.
// See src/notes/embeddings.ts for the reindex/search logic that drives these.
// ---------------------------------------------------------------------------

/** A note (with markdown source) needing an embedding pass. */
export interface EmbeddableNote {
  id: string;
  workspace_id: string;
  title: string;
  content: string | null;
}

/** A stored section embedding row (vector kept as JSON text on disk). */
export interface EmbeddingRow {
  note_id: string;
  section_idx: number;
  workspace_id: string;
  model: string;
  section_title: string;
  content_hash: string;
  vector: string;
}

/** All live notes for a workspace that could hold text worth embedding. */
export function listEmbeddableNotes(workspaceId: string): EmbeddableNote[] {
  return getDb().getAllSync<EmbeddableNote>(
    `SELECT id, workspace_id, title, content FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} AND workspace_id = ?`,
    workspaceId,
  );
}

/** One note (id, workspace_id, title, content) for an incremental embed pass. */
export function getNoteForEmbedding(noteId: string): EmbeddableNote | null {
  return (
    getDb().getFirstSync<EmbeddableNote>(
      `SELECT id, workspace_id, title, content FROM notes WHERE id = ?`,
      noteId,
    ) ?? null
  );
}

/** Existing section rows for a note (to diff hashes before re-embedding). */
export function getNoteEmbeddingRows(noteId: string): EmbeddingRow[] {
  return getDb().getAllSync<EmbeddingRow>(
    `SELECT note_id, section_idx, workspace_id, model, section_title, content_hash, vector
     FROM note_embeddings WHERE note_id = ? ORDER BY section_idx`,
    noteId,
  );
}

/** All 'search_document' section rows for a workspace, for brute-force search. */
export function getWorkspaceEmbeddingRows(workspaceId: string): EmbeddingRow[] {
  return getDb().getAllSync<EmbeddingRow>(
    `SELECT note_id, section_idx, workspace_id, model, section_title, content_hash, vector
     FROM note_embeddings WHERE workspace_id = ?`,
    workspaceId,
  );
}

/** Upsert one section embedding (vector serialised as JSON). */
export function upsertNoteEmbedding(row: {
  noteId: string;
  sectionIdx: number;
  workspaceId: string;
  model: string;
  sectionTitle: string;
  contentHash: string;
  vector: number[];
}): void {
  getDb().runSync(
    `INSERT INTO note_embeddings
       (note_id, section_idx, workspace_id, model, section_title, content_hash, vector, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id, section_idx) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       model        = excluded.model,
       section_title= excluded.section_title,
       content_hash = excluded.content_hash,
       vector       = excluded.vector,
       embedded_at  = excluded.embedded_at`,
    row.noteId,
    row.sectionIdx,
    row.workspaceId,
    row.model,
    row.sectionTitle,
    row.contentHash,
    JSON.stringify(row.vector),
    new Date().toISOString(),
  );
}

/** Delete section rows for a note at or above a given index (prune shrinks). */
export function deleteNoteEmbeddingsFrom(noteId: string, fromIdx: number): void {
  getDb().runSync(
    `DELETE FROM note_embeddings WHERE note_id = ? AND section_idx >= ?`,
    noteId,
    fromIdx,
  );
}

/** Delete every section row for a note (note emptied or removed). */
export function deleteNoteEmbeddings(noteId: string): void {
  getDb().runSync(`DELETE FROM note_embeddings WHERE note_id = ?`, noteId);
}

/** Note ids that currently have any embedding rows (to find orphans). */
export function embeddedNoteIds(workspaceId: string): string[] {
  return getDb()
    .getAllSync<{ note_id: string }>(
      `SELECT DISTINCT note_id FROM note_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )
    .map((r) => r.note_id);
}

/** Wipe the whole index (e.g. on model-identifier change). */
export function clearAllEmbeddings(): void {
  getDb().runSync(`DELETE FROM note_embeddings`);
}

/** All live workspace ids (semantic index is maintained per workspace). */
export function listWorkspaceIds(): string[] {
  return getDb()
    .getAllSync<{ id: string }>(
      `SELECT id FROM workspaces WHERE deleted_at IS NULL AND archived_at IS NULL`,
    )
    .map((r) => r.id);
}

/** Diagnostic counts for the on-device semantic index (indexed vs total notes). */
export function embeddingIndexStats(workspaceId: string): {
  liveNotes: number;
  indexedNotes: number;
  sections: number;
} {
  const db = getDb();
  const liveNotes =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) n FROM notes WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT} AND workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  const indexedNotes =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(DISTINCT note_id) n FROM note_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  const sections =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) n FROM note_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  return { liveNotes, indexedNotes, sections };
}

/** Resolve a note's title for search-result display. */
export function noteTitleById(noteId: string): string {
  const row = getDb().getFirstSync<{ title: string }>(
    `SELECT title FROM notes WHERE id = ?`,
    noteId,
  );
  return row?.title ?? "Untitled";
}

/** The workspace id a note belongs to (via its project). */
export function workspaceIdForNote(noteId: string): string {
  const row = getDb().getFirstSync<{ workspace_id: string }>(
    `SELECT workspace_id FROM notes WHERE id = ?`,
    noteId,
  );
  return row?.workspace_id ?? "";
}

/** Title + plain-text body for a set of notes, for lexical (keyword) scoring in
 *  hybrid semantic search. Returns a map keyed by note id. */
export function noteTextByIds(noteIds: string[]): Map<string, { title: string; text: string }> {
  const out = new Map<string, { title: string; text: string }>();
  if (noteIds.length === 0) return out;
  const placeholders = noteIds.map(() => "?").join(",");
  const rows = getDb().getAllSync<{ id: string; title: string; content_text: string }>(
    `SELECT id, title, content_text FROM notes WHERE id IN (${placeholders})`,
    ...noteIds,
  );
  for (const r of rows) out.set(r.id, { title: r.title, text: r.content_text ?? "" });
  return out;
}

export type BrickKind = "project" | "note" | "card" | "tag";
export interface BrickLabel {
  label: string;
  kind: BrickKind;
}

/**
 * A mixed sample of workspace entities (projects, notes, tasks, tags) to use as
 * bricks in the breakout easter egg. Interleaved by kind so a row of bricks
 * reads as a colourful cross-section of the workspace. Capped at `limit`.
 */
export function listBreakoutBricks(limit = 40): BrickLabel[] {
  const db = getDb();
  const projects = db
    .getAllSync<{ label: string }>(`SELECT name AS label FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12`)
    .map((r) => ({ label: r.label, kind: "project" as const }));
  const notes = db
    .getAllSync<{ label: string }>(`SELECT title AS label FROM notes WHERE deleted_at IS NULL AND type = 'note' ORDER BY updated_at DESC LIMIT 16`)
    .map((r) => ({ label: r.label, kind: "note" as const }));
  const cards = db
    .getAllSync<{ label: string }>(`SELECT title AS label FROM task_cards WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 16`)
    .map((r) => ({ label: r.label, kind: "card" as const }));
  const tags = db
    .getAllSync<{ label: string }>(`SELECT name AS label FROM tags WHERE deleted_at IS NULL ORDER BY name LIMIT 12`)
    .map((r) => ({ label: r.label, kind: "tag" as const }));

  // Round-robin interleave so bricks alternate kind/colour.
  const buckets = [projects, notes, cards, tags];
  const out: BrickLabel[] = [];
  let added = true;
  while (added && out.length < limit) {
    added = false;
    for (const b of buckets) {
      const next = b.shift();
      if (next) {
        out.push(next);
        added = true;
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
