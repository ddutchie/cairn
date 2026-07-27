/**
 * On-device semantic-search index queries (note_embeddings + task_embeddings).
 *
 * Split out of queries.ts to keep that file focused on the core note/card/board
 * reads. This local-only index is never synced; see src/notes/embeddings.ts for
 * the reindex/search logic that drives these. Re-exported from queries.ts so
 * existing `@/db/queries` imports keep working unchanged.
 */

import { getDb } from "./index";
import { LIVE, NOT_CONFLICT } from "./sql";

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
  getDb().runSync(`DELETE FROM task_embeddings`);
}

// ── Task-card embeddings (task_embeddings) ───────────────────────────────────
// Card rows are aliased to the SAME EmbeddingRow shape (card_id AS note_id) so
// the existing brute-force search internals work unchanged for cards.

/** A card that could hold text worth embedding (title + description). */
export interface EmbeddableCard {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
}

/** All live cards for a workspace. */
export function listEmbeddableCards(workspaceId: string): EmbeddableCard[] {
  return getDb().getAllSync<EmbeddableCard>(
    `SELECT id, workspace_id, title, description FROM task_cards
     WHERE ${LIVE} AND workspace_id = ?`,
    workspaceId,
  );
}

/** Existing section rows for a card (aliased to note_id for shape reuse). */
export function getCardEmbeddingRows(cardId: string): EmbeddingRow[] {
  return getDb().getAllSync<EmbeddingRow>(
    `SELECT card_id AS note_id, section_idx, workspace_id, model, section_title, content_hash, vector
     FROM task_embeddings WHERE card_id = ? ORDER BY section_idx`,
    cardId,
  );
}

/** All card section rows for a workspace (aliased to note_id for shape reuse). */
export function getWorkspaceCardEmbeddingRows(workspaceId: string): EmbeddingRow[] {
  return getDb().getAllSync<EmbeddingRow>(
    `SELECT card_id AS note_id, section_idx, workspace_id, model, section_title, content_hash, vector
     FROM task_embeddings WHERE workspace_id = ?`,
    workspaceId,
  );
}

export function upsertCardEmbedding(row: {
  cardId: string;
  sectionIdx: number;
  workspaceId: string;
  model: string;
  sectionTitle: string;
  contentHash: string;
  vector: number[];
}): void {
  getDb().runSync(
    `INSERT INTO task_embeddings
       (card_id, section_idx, workspace_id, model, section_title, content_hash, vector, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(card_id, section_idx) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       model        = excluded.model,
       section_title= excluded.section_title,
       content_hash = excluded.content_hash,
       vector       = excluded.vector,
       embedded_at  = excluded.embedded_at`,
    row.cardId,
    row.sectionIdx,
    row.workspaceId,
    row.model,
    row.sectionTitle,
    row.contentHash,
    JSON.stringify(row.vector),
    new Date().toISOString(),
  );
}

export function deleteCardEmbeddingsFrom(cardId: string, fromIdx: number): void {
  getDb().runSync(`DELETE FROM task_embeddings WHERE card_id = ? AND section_idx >= ?`, cardId, fromIdx);
}

export function deleteCardEmbeddings(cardId: string): void {
  getDb().runSync(`DELETE FROM task_embeddings WHERE card_id = ?`, cardId);
}

export function embeddedCardIds(workspaceId: string): string[] {
  return getDb()
    .getAllSync<{ card_id: string }>(`SELECT DISTINCT card_id FROM task_embeddings WHERE workspace_id = ?`, workspaceId)
    .map((r) => r.card_id);
}

/** Look up card titles by id (for search result display). */
export function cardTitlesByIds(cardIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (cardIds.length === 0) return out;
  const placeholders = cardIds.map(() => "?").join(", ");
  for (const r of getDb().getAllSync<{ id: string; title: string }>(
    `SELECT id, title FROM task_cards WHERE id IN (${placeholders})`,
    ...(cardIds as never[]),
  )) {
    out.set(r.id, r.title);
  }
  return out;
}

/** Card title+description text by ids (for the hybrid lexical re-rank). */
export function cardTextByIds(cardIds: string[]): Map<string, { title: string; text: string }> {
  const out = new Map<string, { title: string; text: string }>();
  if (cardIds.length === 0) return out;
  const placeholders = cardIds.map(() => "?").join(", ");
  for (const r of getDb().getAllSync<{ id: string; title: string; description: string | null }>(
    `SELECT id, title, description FROM task_cards WHERE id IN (${placeholders})`,
    ...cardIds,
  )) {
    out.set(r.id, { title: r.title, text: r.description ?? "" });
  }
  return out;
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
  liveCards: number;
  indexedCards: number;
  sections: number;
} {
  const db = getDb();
  // Only notes with embeddable content count toward the denominator. A note
  // whose body is empty/whitespace produces zero sections (splitIntoSections
  // returns [] on `content.trim() === ""`, see shared/notes/sections.ts), so it
  // can never be "indexed" — counting it in the total made a fully-caught-up
  // index read as e.g. "209 of 212" and look like a failure. Match the split's
  // emptiness test here so "all indexed" actually reaches 100%.
  const liveNotes =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) n FROM notes
       WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT} AND workspace_id = ?
         AND content IS NOT NULL AND TRIM(content) <> ''`,
      workspaceId,
    )?.n ?? 0;
  const indexedNotes =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(DISTINCT note_id) n FROM note_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  const liveCards =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) n FROM task_cards WHERE ${LIVE} AND workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  const indexedCards =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(DISTINCT card_id) n FROM task_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  const sections =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) n FROM note_embeddings WHERE workspace_id = ?`,
      workspaceId,
    )?.n ?? 0;
  return { liveNotes, indexedNotes, liveCards, indexedCards, sections };
}

/** One live note that is NOT represented in the semantic index, with enough
 *  context to explain why. `contentLen` is the trimmed body length; a note with
 *  content but still no embedding rows points at an embed failure rather than an
 *  empty note. */
export interface UnindexedNote {
  id: string;
  title: string;
  /** Trimmed length of the note body (0 = empty). */
  contentLen: number;
}

/**
 * Live notes that have no rows in `note_embeddings` — i.e. the ones making the
 * "N of M indexed" count fall short. Includes empty notes (contentLen 0) and,
 * more importantly, notes WITH content that still failed to embed, so the UI can
 * explain the gap instead of leaving it a mystery. Ordered content-first so the
 * genuinely-suspicious ones surface at the top.
 */
export function listUnindexedNotes(workspaceId: string): UnindexedNote[] {
  return getDb().getAllSync<UnindexedNote>(
    `SELECT n.id AS id,
            n.title AS title,
            LENGTH(TRIM(COALESCE(n.content, ''))) AS contentLen
       FROM notes n
      WHERE ${LIVE} AND n.type='note' AND ${NOT_CONFLICT} AND n.workspace_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM note_embeddings e WHERE e.note_id = n.id
        )
      ORDER BY contentLen DESC, n.title`,
    workspaceId,
  );
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
