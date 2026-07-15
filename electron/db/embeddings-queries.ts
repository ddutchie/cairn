/**
 * Cairn — note + task embedding SQLite queries (on-device semantic index).
 *
 * Extracted from db/queries.ts to keep that file focused on the core domain
 * reads/writes. Re-exported from db/queries.ts (`export * from
 * "./embeddings-queries"`) so existing `../db/queries` / `./queries` imports
 * (embeddings/service.ts, db/graph-queries.ts) keep working unchanged.
 *
 * Same governance as db/queries.ts: NEVER construct a Database here — these run
 * on the already-constructed handle passed in by the caller (see db/queries.ts
 * header for the two ABI bootstrap sites). Vectors are stored as JSON-in-TEXT.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";

// ── Note Embeddings ───────────────────────────
// Vectors are stored as JSON-in-TEXT (sqlite-vec-bridge shape).
// Since v18, one note can have multiple rows — one per markdown section.
// All JSON-parse/serialize happens here; callers receive typed objects.

export interface NoteEmbeddingRecord {
  noteId: string;
  sectionIdx: number;
  sectionTitle: string;
  workspaceId: string;
  model: string;
  task: string;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
  dimX: number | null;
  dimY: number | null;
  projStale: number;
}

interface NoteEmbeddingRow {
  note_id: string;
  section_idx: number;
  section_title: string;
  workspace_id: string;
  model: string;
  task: string;
  content_hash: string;
  vector: string;
  embedded_at: string;
  dim_x: number | null;
  dim_y: number | null;
  proj_stale: number;
}

function toNoteEmbedding(row: NoteEmbeddingRow): NoteEmbeddingRecord {
  return {
    noteId: row.note_id,
    sectionIdx: row.section_idx,
    sectionTitle: row.section_title,
    workspaceId: row.workspace_id,
    model: row.model,
    task: row.task,
    contentHash: row.content_hash,
    vector: JSON.parse(row.vector) as number[],
    embeddedAt: row.embedded_at,
    dimX: row.dim_x,
    dimY: row.dim_y,
    projStale: row.proj_stale,
  };
}

export function upsertNoteEmbedding(
  db: Database.Database,
  e: {
    noteId: string;
    sectionIdx: number;
    sectionTitle: string;
    workspaceId: string;
    model: string;
    task: string;
    contentHash: string;
    vector: number[];
  },
): void {
  const now = ts();
  db.prepare(`
    INSERT INTO note_embeddings
      (note_id, section_idx, section_title, workspace_id, model, task, content_hash, vector, embedded_at, proj_stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(note_id, section_idx) DO UPDATE SET
      section_title = excluded.section_title,
      workspace_id  = excluded.workspace_id,
      model         = excluded.model,
      task          = excluded.task,
      content_hash  = excluded.content_hash,
      vector        = excluded.vector,
      embedded_at   = excluded.embedded_at,
      proj_stale    = 1
  `).run(e.noteId, e.sectionIdx, e.sectionTitle, e.workspaceId, e.model, e.task, e.contentHash, JSON.stringify(e.vector), now);
}

export function deleteNoteEmbeddingSections(db: Database.Database, noteId: string, keepFromIdx?: number): void {
  if (keepFromIdx !== undefined) {
    db.prepare("DELETE FROM note_embeddings WHERE note_id = ? AND section_idx >= ?").run(noteId, keepFromIdx);
  } else {
    db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(noteId);
  }
}

export function markEmbeddingProjectionFresh(db: Database.Database, noteId: string, x: number, y: number): void {
  db.prepare(`
    UPDATE note_embeddings SET dim_x = ?, dim_y = ?, proj_stale = 0 WHERE note_id = ?
  `).run(x, y, noteId);
}

export function markAllProjectionsStale(db: Database.Database, workspaceId: string): void {
  db.prepare("UPDATE note_embeddings SET proj_stale = 1 WHERE workspace_id = ?").run(workspaceId);
}

export interface NoteProjectionRow {
  noteId: string;
  dimX: number;
  dimY: number;
  projStale: number;
  embeddedAt: string;
  model: string;
}

export function getNoteProjections(
  db: Database.Database,
  workspaceId: string,
): { rows: NoteProjectionRow[]; anyStale: boolean } {
  const raw = db.prepare(`
    SELECT note_id, dim_x, dim_y, proj_stale, embedded_at, model
    FROM note_embeddings
    WHERE workspace_id = ? AND section_idx = 0
  `).all(workspaceId) as Array<{
    note_id: string;
    dim_x: number | null;
    dim_y: number | null;
    proj_stale: number;
    embedded_at: string;
    model: string;
  }>;
  let anyStale = false;
  const rows: NoteProjectionRow[] = [];
  for (const r of raw) {
    if (r.proj_stale) anyStale = true;
    if (r.dim_x === null || r.dim_y === null) continue;
    rows.push({
      noteId: r.note_id,
      dimX: r.dim_x,
      dimY: r.dim_y,
      projStale: r.proj_stale,
      embeddedAt: r.embedded_at,
      model: r.model,
    });
  }
  return { rows, anyStale };
}

export function getNoteEmbeddings(db: Database.Database, noteId: string): NoteEmbeddingRecord[] {
  const rows = db.prepare("SELECT * FROM note_embeddings WHERE note_id = ? ORDER BY section_idx").all(noteId) as NoteEmbeddingRow[];
  return rows.map(toNoteEmbedding);
}

export function getAllEmbeddingsForWorkspace(
  db: Database.Database,
  workspaceId: string,
  task: string,
): NoteEmbeddingRecord[] {
  const rows = db.prepare(
    "SELECT * FROM note_embeddings WHERE workspace_id = ? AND task = ? ORDER BY note_id, section_idx"
  ).all(workspaceId, task) as NoteEmbeddingRow[];
  return rows.map(toNoteEmbedding);
}

export function getStaleProjectionNoteIds(db: Database.Database, workspaceId: string): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT note_id FROM note_embeddings WHERE workspace_id = ? AND proj_stale = 1 AND task = 'search_document'"
  ).all(workspaceId) as Array<{ note_id: string }>;
  return rows.map((r) => r.note_id);
}

export function deleteNoteEmbedding(db: Database.Database, noteId: string): void {
  db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(noteId);
}

export function pruneOrphanedClusteringRows(db: Database.Database): number {
  const info = db.prepare("DELETE FROM note_embeddings WHERE task = 'clustering'").run();
  return info.changes;
}

export function deleteWorkspaceEmbeddings(db: Database.Database, workspaceId: string): void {
  db.prepare("DELETE FROM note_embeddings WHERE workspace_id = ?").run(workspaceId);
}

// ── Task-card embeddings (task_embeddings) — parallel to note_embeddings ──────
// Same shape minus the graph-projection fields. Keyed by card_id.

export interface TaskEmbeddingRecord {
  cardId: string;
  sectionIdx: number;
  sectionTitle: string;
  workspaceId: string;
  model: string;
  task: string;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
}
interface TaskEmbeddingRow {
  card_id: string;
  section_idx: number;
  section_title: string;
  workspace_id: string;
  model: string;
  task: string;
  content_hash: string;
  vector: string;
  embedded_at: string;
}
function toTaskEmbedding(row: TaskEmbeddingRow): TaskEmbeddingRecord {
  return {
    cardId: row.card_id,
    sectionIdx: row.section_idx,
    sectionTitle: row.section_title,
    workspaceId: row.workspace_id,
    model: row.model,
    task: row.task,
    contentHash: row.content_hash,
    vector: JSON.parse(row.vector) as number[],
    embeddedAt: row.embedded_at,
  };
}

/** Workspace-scoped card fetch for reindexing (mirrors fetchNotes' selection). */
export interface CardStub {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  archived_at: string | null;
}
export function fetchCardsForEmbedding(db: Database.Database, workspaceId: string, cardIds?: string[]): CardStub[] {
  if (cardIds?.length) {
    const placeholders = cardIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, workspace_id, title, description, archived_at FROM task_cards
       WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).all(workspaceId, ...cardIds) as CardStub[];
  }
  return db.prepare(
    `SELECT id, workspace_id, title, description, archived_at FROM task_cards
     WHERE workspace_id = ? AND archived_at IS NULL`,
  ).all(workspaceId) as CardStub[];
}

export function getCardEmbeddings(db: Database.Database, cardId: string): TaskEmbeddingRecord[] {
  const rows = db.prepare("SELECT * FROM task_embeddings WHERE card_id = ? ORDER BY section_idx").all(cardId) as TaskEmbeddingRow[];
  return rows.map(toTaskEmbedding);
}

export function getAllTaskEmbeddingsForWorkspace(db: Database.Database, workspaceId: string, task: string): TaskEmbeddingRecord[] {
  const rows = db.prepare(
    "SELECT * FROM task_embeddings WHERE workspace_id = ? AND task = ? ORDER BY card_id, section_idx",
  ).all(workspaceId, task) as TaskEmbeddingRow[];
  return rows.map(toTaskEmbedding);
}

export function upsertTaskEmbedding(
  db: Database.Database,
  e: {
    cardId: string;
    sectionIdx: number;
    sectionTitle: string;
    workspaceId: string;
    model: string;
    task: string;
    contentHash: string;
    vector: number[];
  },
): void {
  const now = ts();
  db.prepare(`
    INSERT INTO task_embeddings
      (card_id, section_idx, section_title, workspace_id, model, task, content_hash, vector, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, section_idx) DO UPDATE SET
      section_title = excluded.section_title,
      workspace_id  = excluded.workspace_id,
      model         = excluded.model,
      task          = excluded.task,
      content_hash  = excluded.content_hash,
      vector        = excluded.vector,
      embedded_at   = excluded.embedded_at
  `).run(e.cardId, e.sectionIdx, e.sectionTitle, e.workspaceId, e.model, e.task, e.contentHash, JSON.stringify(e.vector), now);
}

export function deleteTaskEmbeddingSections(db: Database.Database, cardId: string, keepFromIdx?: number): void {
  if (keepFromIdx !== undefined) {
    db.prepare("DELETE FROM task_embeddings WHERE card_id = ? AND section_idx >= ?").run(cardId, keepFromIdx);
  } else {
    db.prepare("DELETE FROM task_embeddings WHERE card_id = ?").run(cardId);
  }
}
