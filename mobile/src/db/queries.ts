/**
 * Read-only queries for the mobile MVP screens.
 * All queries exclude tombstoned (deleted_at) and archived rows.
 */

import { getDb } from "./index";
import { LIVE, NOT_CONFLICT } from "./sql";
import { parseIds } from "./row-helpers";
import { inspectConflict, cleanConflictTitle } from "@cairn/shared/sync/conflict";
import { stripMarkdown, queryTerms } from "@cairn/shared/notes/text";
import { buildNoteOutline, sliceLines, noteDigest } from "@cairn/shared/notes/toc";
import { dedupeFoldersCaseInsensitive } from "@cairn/shared/notes/folder-tree";
import { buildNoteMarkdown } from "@cairn/shared/notes/export";
import { notifyLocalWrite } from "@/sync/write-signal";
import type {
  NoteRow,
  ProjectRow,
  ColumnRow,
  CardRow,
  TagRow,
} from "./types";

// Row/graph types now live in ./types; the knowledge-graph builder and the
// breakout brick sampler are their own leaf modules. Re-export all three (plus
// the embeddings queries below) so existing `@/db/queries` imports are unchanged.
export * from "./types";
export * from "./graph-queries";
export * from "./breakout";

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

/**
 * Resolve tag NAMES to ids within a workspace, creating any that don't exist
 * (mirrors desktop `resolveTagNames`). Case-insensitive match on name.
 */
export function resolveTagNames(workspaceId: string, tagNames: string[]): string[] {
  const db = getDb();
  const ids: string[] = [];
  for (const raw of tagNames) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const existing = db.getFirstSync<{ id: string }>(
      "SELECT id FROM tags WHERE workspace_id = ? AND LOWER(name) = ? AND deleted_at IS NULL",
      workspaceId,
      name.toLowerCase(),
    );
    if (existing) {
      ids.push(existing.id);
    } else {
      const id = genId();
      const now = new Date().toISOString();
      db.runSync(
        "INSERT INTO tags (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id, workspaceId, name, "#6366f1", now, now,
      );
      ids.push(id);
    }
  }
  notifyLocalWrite();
  return ids;
}

type TagMode = "add" | "remove" | "set";

function mergeTagIds(current: string[], resolved: string[], mode: TagMode): string[] {
  if (mode === "remove") return current.filter((id) => !resolved.includes(id));
  if (mode === "set") return Array.from(new Set(resolved));
  return Array.from(new Set([...current, ...resolved])); // add
}

/**
 * Apply tags by NAME to an existing note. Returns the resulting tag ids, or an
 * error object if the note is missing. Creates tags as needed.
 */
export function tagNote(noteId: string, tagNames: string[], mode: TagMode = "add"): { error: string } | { id: string; tagIds: string[] } {
  const note = getNote(noteId);
  if (!note) return { error: "Note not found" };
  const resolved = resolveTagNames(workspaceIdForProject(note.project_id), tagNames);
  const next = mergeTagIds(parseIds(note.tag_ids), resolved, mode);
  setNoteTags(noteId, next);
  return { id: noteId, tagIds: next };
}

/** Apply tags by NAME to an existing task card. */
export function tagTask(cardId: string, tagNames: string[], mode: TagMode = "add"): { error: string } | { id: string; tagIds: string[] } {
  const card = getCard(cardId);
  if (!card) return { error: "Task not found" };
  const resolved = resolveTagNames(workspaceIdForProject(card.project_id), tagNames);
  const next = mergeTagIds(parseIds(card.tag_ids), resolved, mode);
  setCardTags(cardId, next);
  return { id: cardId, tagIds: next };
}

/** Export a single note as a clean, self-contained markdown document. */
export function exportNote(noteId: string): { error: string } | { markdown: string; title: string } {
  const note = getNote(noteId);
  if (!note) return { error: "Note not found" };
  const markdown = buildNoteMarkdown({
    title: note.title,
    content: note.content ?? "",
    tagNames: tagsForNote(note).map((t) => t.name),
    folder: note.folder,
  });
  return { markdown, title: note.title };
}

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

/** Distinct folders within a project. Case-insensitively de-duplicated
 *  (first-seen casing wins) so "Mobile" and "mobile" list as one — mirrors the
 *  notes-tree grouping. Root (empty folder) is excluded. */
export function listFolders(projectId: string): string[] {
  const rows = getDb().getAllSync<{ folder: string }>(
    `SELECT DISTINCT folder FROM notes WHERE ${LIVE} AND type='note' AND project_id = ? ORDER BY folder`,
    projectId,
  );
  return dedupeFoldersCaseInsensitive(rows.map((r) => r.folder));
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

/**
 * Build an AND-of-terms SQL fragment for keyword search: every whitespace-
 * separated term in `query` must appear (case-insensitively) in AT LEAST ONE of
 * the given columns. Returns the `AND (...)` SQL and the bound params, or null
 * when the query has no terms (caller can early-return / list all).
 *
 * This replaces the old single whole-query `LIKE '%q%'`, which under-matched
 * multi-word queries — "auth flow" now matches "Authentication flow" and
 * "flow for auth", not only the literal phrase. LIKE wildcards in a term are
 * escaped so they match literally (ESCAPE '\').
 */
function buildTermClause(query: string, columns: string[]): { sql: string; params: string[] } | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const params: string[] = [];
  const groups = terms.map((term) => {
    // Escape %, _ and the escape char itself so they're matched literally.
    const escaped = term.replace(/[\\%_]/g, (m) => `\\${m}`);
    const like = `%${escaped}%`;
    const ors = columns.map((col) => {
      params.push(like);
      return `${col} LIKE ? ESCAPE '\\'`;
    });
    return `(${ors.join(" OR ")})`;
  });
  return { sql: `AND (${groups.join(" AND ")})`, params };
}

export function searchNotes(query: string): NoteRow[] {
  const clause = buildTermClause(query, ["title", "content_text"]);
  if (!clause) return [];
  return getDb().getAllSync<NoteRow>(
    `SELECT id, project_id, title, content, folder, tag_ids, updated_at FROM notes
     WHERE ${LIVE} AND type = 'note' AND ${NOT_CONFLICT} ${clause.sql}
     ORDER BY updated_at DESC LIMIT 50`,
    ...clause.params,
  );
}

/** Search live (non-archived) task cards by title or description. */
export function searchTasks(query: string, projectId?: string): CardRow[] {
  const clause = buildTermClause(query, ["title", "description"]);
  if (!clause) return [];
  // Scope to the project BEFORE the LIMIT so a project's matches aren't dropped
  // when the workspace-wide match set exceeds the cap.
  const projectClause = projectId ? "AND project_id = ?" : "";
  const params = projectId ? [...clause.params, projectId] : clause.params;
  return getDb().getAllSync<CardRow>(
    `SELECT id, column_id, project_id, title, description, priority, tag_ids, "order", due_date, assignee FROM task_cards
     WHERE ${LIVE} ${clause.sql} ${projectClause}
     ORDER BY updated_at DESC LIMIT 50`,
    ...params,
  );
}

/**
 * Ready-to-work cards: live (not deleted/archived), NOT in a done-type column,
 * and with every blocker resolved (each blocker card is deleted/archived or in a
 * done column). Mirrors the desktop `getReadyCards` semantics so "what should I
 * work on now?" behaves the same across surfaces. Optionally scoped to a project.
 */
export function listReadyCards(projectId?: string): CardRow[] {
  const whereProject = projectId ? "AND c.project_id = ?" : "";
  const params = projectId ? [projectId] : [];
  const candidates = getDb().getAllSync<CardRow & { blocked_by_ids: string }>(
    `SELECT c.id, c.column_id, c.project_id, c.title, c.description, c.priority,
            c.tag_ids, c."order", c.due_date, c.assignee, c.blocked_by_ids
     FROM task_cards c
     JOIN board_columns col ON col.id = c.column_id
     WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND col.type != 'done'
       ${whereProject}
     ORDER BY c."order"`,
    ...params,
  );
  if (candidates.length === 0) return [];

  // Resolve blockers in one batched query (mirrors getKnowledgeGraph's IN(...)
  // pattern) instead of a per-blocker DB round-trip. A blocker is "cleared" when
  // its card is deleted/archived, lives in a done column, or no longer exists
  // (an orphaned blocker is cleared).
  const blockersByCard = candidates.map((c) => parseIds(c.blocked_by_ids));
  const distinctBlockerIds = [...new Set(blockersByCard.flat())];

  const cleared = new Set<string>();
  if (distinctBlockerIds.length > 0) {
    const placeholders = distinctBlockerIds.map(() => "?").join(",");
    const rows = getDb().getAllSync<{ id: string; archived_at: string | null; deleted_at: string | null; type: string }>(
      `SELECT c.id, c.archived_at, c.deleted_at, col.type
       FROM task_cards c JOIN board_columns col ON col.id = c.column_id
       WHERE c.id IN (${placeholders})`,
      ...distinctBlockerIds,
    );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const id of distinctBlockerIds) {
      const row = rowById.get(id);
      // Missing (orphaned) → cleared; otherwise cleared when gone or done.
      if (!row || row.archived_at !== null || row.deleted_at !== null || row.type === "done") {
        cleared.add(id);
      }
    }
  }

  return candidates
    .filter((_c, i) => blockersByCard[i].every((id) => cleared.has(id)))
    .map(({ blocked_by_ids: _omit, ...card }) => card);
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

/**
 * Bidirectionally link a note and a task card (mirrors desktop
 * link_note_to_task). Updates notes.linked_card_ids + task_cards.linked_note_ids.
 * Idempotent. Returns an error object if either side is missing.
 */
export function linkNoteToTask(noteId: string, cardId: string): { error: string } | { noteId: string; cardId: string; linked: true } {
  return applyLinkChange(noteId, cardId, true);
}

/** Bidirectionally remove a note↔task link. */
export function unlinkNoteFromTask(noteId: string, cardId: string): { error: string } | { noteId: string; cardId: string; unlinked: true } {
  const r = applyLinkChange(noteId, cardId, false);
  if ("error" in r) return r;
  return { noteId, cardId, unlinked: true };
}

function applyLinkChange(noteId: string, cardId: string, add: boolean): { error: string } | { noteId: string; cardId: string; linked: true } {
  const db = getDb();
  const note = db.getFirstSync<{ linked_card_ids: string }>(
    "SELECT linked_card_ids FROM notes WHERE id = ? AND deleted_at IS NULL", noteId,
  );
  if (!note) return { error: "Note not found" };
  const card = db.getFirstSync<{ linked_note_ids: string }>(
    "SELECT linked_note_ids FROM task_cards WHERE id = ? AND deleted_at IS NULL", cardId,
  );
  if (!card) return { error: "Task not found" };

  const cardIds = parseIds(note.linked_card_ids);
  const noteIds = parseIds(card.linked_note_ids);
  const nextCardIds = add
    ? Array.from(new Set([...cardIds, cardId]))
    : cardIds.filter((id) => id !== cardId);
  const nextNoteIds = add
    ? Array.from(new Set([...noteIds, noteId]))
    : noteIds.filter((id) => id !== noteId);

  const now = new Date().toISOString();
  db.runSync(
    "UPDATE notes SET linked_card_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    JSON.stringify(nextCardIds), now, noteId,
  );
  db.runSync(
    "UPDATE task_cards SET linked_note_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    JSON.stringify(nextNoteIds), now, cardId,
  );
  notifyLocalWrite();
  return { noteId, cardId, linked: true };
}

/**
 * Move a batch of cards to one column in a single call (mirrors desktop
 * bulk_update_task_status). Reports which ids moved vs. were not found.
 */
export function bulkUpdateTaskStatus(cardIds: string[], targetColumnId: string): { error: string } | { moved: number; failed: string[]; targetColumnId: string } {
  const db = getDb();
  const col = db.getFirstSync<{ id: string }>("SELECT id FROM board_columns WHERE id = ? AND deleted_at IS NULL", targetColumnId);
  if (!col) return { error: "Target column not found" };
  const now = new Date().toISOString();
  const failed: string[] = [];
  let moved = 0;
  for (const id of cardIds) {
    const exists = db.getFirstSync<{ id: string }>("SELECT id FROM task_cards WHERE id = ? AND deleted_at IS NULL", id);
    if (!exists) { failed.push(id); continue; }
    db.runSync(
      "UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      targetColumnId, now, id,
    );
    moved++;
  }
  if (moved > 0) notifyLocalWrite();
  return { moved, failed, targetColumnId };
}

function plainText(md: string): string {
  return stripMarkdown(md);
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
export function patchNote(
  noteId: string,
  oldString: string,
  newString: string,
): { ok: true } | { ok: false; error: string } {
  const note = getNote(noteId);
  if (!note) {
    return {
      ok: false,
      error: `Note not found: no note has id '${noteId}'. The id may be wrong or stale — call search_notes to find the correct note id, then retry. Do not retry with the same id.`,
    };
  }
  if (!note.content || !note.content.includes(oldString)) {
    return {
      ok: false,
      error: `oldString not found in note content — the exact text you provided does not appear in the note, so nothing was changed. Do NOT retry with the same oldString; it will fail again. Call get_note to read the current content, copy the exact text (including whitespace/markdown) you want to replace, then retry. To add new content instead, use append_to_note.`,
    };
  }
  updateNote(noteId, note.title, note.content.replace(oldString, newString));
  return { ok: true };
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

/**
 * Move a note to a different project (and its owning workspace).
 *
 * Mobile is DB-only (no .md files), so this is a plain UPDATE of project_id +
 * workspace_id — no file relocation like the desktop equivalent. Writing both
 * columns matters: notes are scoped by project_id everywhere (lists, search,
 * graph), and the sync engine carries them in the row's full snapshot, so a
 * partial move (project without workspace) would desync. Returns the new
 * project/workspace, or an error if the target project doesn't exist.
 */
export function moveNoteToProject(
  noteId: string,
  targetProjectId: string,
): { error: string } | { projectId: string; workspaceId: string } {
  const note = getNote(noteId);
  if (!note) return { error: "Note not found" };
  const workspaceId = workspaceIdForProject(targetProjectId);
  if (!workspaceId) return { error: "Target project not found" };
  const now = new Date().toISOString();
  getDb().runSync(
    `UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    targetProjectId,
    workspaceId,
    now,
    noteId,
  );
  notifyLocalWrite();
  return { projectId: targetProjectId, workspaceId };
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
  /** Common-ancestor body (sync_row_base) for a true 3-way merge, if known. */
  baseBody: string | null;
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
    const base = info.originalId
      ? db.getFirstSync<{ base_body: string | null }>(
          `SELECT base_body FROM sync_row_base WHERE entity = 'notes' AND entity_id = ?`,
          info.originalId,
        )
      : null;
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
      baseBody: base ? base.base_body : null,
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

/**
 * Resolve a conflict by writing a MERGED body onto the original note, then
 * deleting the copy. `mergedContent` is produced by the shared 3-way merge (or
 * the user's manual edit) in the conflict UI. If the original is gone, the copy
 * is promoted with the merged body.
 */
export function resolveConflictKeepMerged(copyId: string, mergedContent: string): void {
  const copy = getNote(copyId);
  if (!copy) return;
  const info = inspectConflict(copy.id, copy.title);
  const cleanTitle = cleanConflictTitle(copy.title);
  const original = info.originalId ? getNote(info.originalId) : null;

  if (original && !isTombstoned(original.id)) {
    updateNote(original.id, cleanTitle, mergedContent);
    softDeleteNote(copy.id);
  } else {
    updateNote(copy.id, cleanTitle, mergedContent);
  }
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

// ── On-device semantic-search index ─────────────────────────────────────────
// The note_embeddings / task_embeddings queries live in embeddings-queries.ts;
// re-exported here so existing `@/db/queries` imports keep working unchanged.
export * from "./embeddings-queries";
