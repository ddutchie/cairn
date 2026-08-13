import * as crypto from "crypto";

import type Database from "better-sqlite3";
import {
  upsertNoteEmbedding,
  getNoteEmbeddings,
  getAllEmbeddingsForWorkspace,
  markEmbeddingProjectionFresh,
  pruneOrphanedClusteringRows,
  deleteNoteEmbedding,
  deleteNoteEmbeddingSections,
  fetchCardsForEmbedding,
  getCardEmbeddings,
  getAllTaskEmbeddingsForWorkspace,
  upsertTaskEmbedding,
  deleteTaskEmbeddingSections,
} from "../db/queries";
import type { NoteEmbeddingRecord } from "../db/queries";
import { projectTo2d, normaliseProjection } from "./projection";
import { toFloat32 } from "./cosine";
import { splitIntoSections } from "./sections";
import { EMBED_MODEL_ID, EMBED_DIM } from "./types";
import type { EmbedTask } from "./types";
import { stripMarkdown } from "../shared/text-utils";

export type EmbedFn = (texts: string[], task: EmbedTask, model?: string) => Promise<number[][]>;

const defaultEmbed: EmbedFn = async (texts, task, model) => {
  const { embed: runtimeEmbed } = await import("../runtime/client");
  return runtimeEmbed(texts, task, model);
};

const BATCH_SIZE = 16;
const CHUNK_CHAR_LIMIT = 4000;
const CHUNK_OVERLAP = 200;

const queryCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 64;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function chunkLongText(text: string): string[] {
  if (text.length <= CHUNK_CHAR_LIMIT) {
    return [text];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHAR_LIMIT, text.length);
    if (end < text.length) {
      const lastBreak = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(" ", end),
      );
      if (lastBreak > start + CHUNK_CHAR_LIMIT / 2) end = lastBreak;
    }
    if (end <= start) end = start + 1;
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    const nextStart = end - CHUNK_OVERLAP;
    if (nextStart <= start) break;
    start = nextStart;
  }
  return chunks;
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return new Array(EMBED_DIM).fill(0);
  if (vectors.length === 1) return vectors[0];
  const out = new Array<number>(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = 0;
  for (const v of vectors) {
    for (let i = 0; i < EMBED_DIM; i++) out[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return out;
  for (let i = 0; i < EMBED_DIM; i++) out[i] = out[i] / norm;
  return out;
}

async function embedSectionText(
  embed: EmbedFn,
  text: string,
  task: EmbedTask,
  model: string,
): Promise<number[]> {
  const chunks = chunkLongText(text);
  if (chunks.length === 1) {
    const [v] = await embed([chunks[0]], task, model);
    return v;
  }
  const vectors: number[][] = [];
  for (const chunk of chunks) {
    const [v] = await embed([chunk], task, model);
    vectors.push(v);
  }
  return averageVectors(vectors);
}

interface NoteStub {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  archived_at: string | null;
}

function fetchNotes(db: Database.Database, workspaceId: string, noteIds?: string[]): NoteStub[] {
  if (noteIds && noteIds.length > 0) {
    const placeholders = noteIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, workspace_id, title, content, archived_at
       FROM notes WHERE workspace_id = ? AND id IN (${placeholders})`
    ).all(workspaceId, ...noteIds) as NoteStub[];
  }
  return db.prepare(
    `SELECT id, workspace_id, title, content, archived_at
     FROM notes WHERE workspace_id = ? AND archived_at IS NULL`
  ).all(workspaceId) as NoteStub[];
}

export interface ReindexResult {
  indexed: number;
  skipped: number;
  total: number;
}

interface SectionToEmbed {
  noteId: string;
  idx: number;
  title: string;
  text: string;
  hash: string;
}

export async function reindexNotes(
  db: Database.Database,
  workspaceId: string,
  noteIds: string[] | undefined,
  model: string = EMBED_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
  onProgress?: (done: number, total: number) => void,
): Promise<ReindexResult> {
  if (!noteIds) {
    const pruned = pruneOrphanedClusteringRows(db);
    if (pruned > 0) console.log(`[embeddings] pruned ${pruned} orphaned clustering rows`);
  }
  const notes = fetchNotes(db, workspaceId, noteIds);
  let indexed = 0;
  let skipped = 0;
  let done = 0;
  const total = notes.length;
  if (total > 0) onProgress?.(done, total);

  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    const batch = notes.slice(i, i + BATCH_SIZE);

    for (const n of batch) {
      const plain = stripMarkdown(n.content);
      if (!plain || plain.trim().length === 0) {
        deleteNoteEmbedding(db, n.id);
        skipped++;
        done++;
        onProgress?.(done, total);
        continue;
      }
      const sections = splitIntoSections(n.title, plain);
      const existing = getNoteEmbeddings(db, n.id);
      const existingBySectionIdx = new Map(existing.map((e) => [e.sectionIdx, e]));

      const todo: SectionToEmbed[] = [];
      for (const s of sections) {
        const text = `${n.title}\n\n## ${s.title}\n${s.text}`;
        const hash = sha256(text);
        const ex = existingBySectionIdx.get(s.idx);
        if (ex && ex.contentHash === hash && ex.model === model && ex.task === "search_document") {
          continue;
        }
        todo.push({ noteId: n.id, idx: s.idx, title: s.title, text, hash });
      }

      if (sections.length > 0) {
        deleteNoteEmbeddingSections(db, n.id, sections.length);
      }

      if (todo.length === 0) {
        skipped++;
        done++;
        onProgress?.(done, total);
        continue;
      }

      for (const s of todo) {
        const [v] = await embed([s.text], "search_document", model);
        upsertNoteEmbedding(db, {
          noteId: s.noteId,
          sectionIdx: s.idx,
          sectionTitle: s.title,
          workspaceId,
          model,
          task: "search_document",
          contentHash: s.hash,
          vector: v,
        });
        indexed++;
      }

      done++;
      onProgress?.(done, total);
    }
  }
  return { indexed, skipped, total };
}

export interface AdjacentNote {
  noteId: string;
  title: string;
  score: number;
  sectionTitle: string;
}

export async function searchAdjacent(
  db: Database.Database,
  workspaceId: string,
  queryText: string,
  k: number = 5,
  excludeIds: string[] = [],
  model: string = EMBED_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
): Promise<AdjacentNote[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const queryHash = sha256(`q|${model}|${trimmed}`);
  let queryVec = queryCache.get(queryHash);
  if (queryVec) {
    queryCache.delete(queryHash);
    queryCache.set(queryHash, queryVec);
  } else {
    queryVec = await embedSectionText(embed, trimmed, "search_query", model);
    if (queryCache.size >= QUERY_CACHE_MAX) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) queryCache.delete(firstKey);
    }
    queryCache.set(queryHash, queryVec);
  }
  const stored = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  if (stored.length === 0) return [];
  const query = toFloat32(queryVec);
  const excludeSet = new Set(excludeIds);

  const bestPerNote = new Map<string, { noteId: string; score: number; sectionTitle: string }>();
  for (const s of stored) {
    if (excludeSet.has(s.noteId)) continue;
    const sim = cosineDot(query, toFloat32(s.vector));
    const cur = bestPerNote.get(s.noteId);
    if (!cur || sim > cur.score) {
      bestPerNote.set(s.noteId, { noteId: s.noteId, score: sim, sectionTitle: s.sectionTitle });
    }
  }

  const sorted = Array.from(bestPerNote.values()).sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, k);
  if (top.length === 0) return [];

  const idToTitle = new Map<string, string>();
  const placeholders = top.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, title FROM notes WHERE id IN (${placeholders})`
  ).all(...top.map((r) => r.noteId)) as Array<{ id: string; title: string }>;
  for (const r of rows) idToTitle.set(r.id, r.title);
  return top.map((r) => ({
    noteId: r.noteId,
    title: idToTitle.get(r.noteId) ?? r.noteId,
    score: Math.round(r.score * 1000) / 1000,
    sectionTitle: r.sectionTitle,
  }));
}

function cosineDot(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ── Task-card embeddings ─────────────────────────────────────────────────────
// Mirrors reindexNotes/searchAdjacent against the parallel task_embeddings table.
// bge-small is discriminative on its own, so (like notes) no centroid/hybrid
// rerank is needed — that's Apple-model-specific on mobile.

/** (Re)embed task cards for a workspace (all, or a specific set of card ids). */
export async function reindexTasks(
  db: Database.Database,
  workspaceId: string,
  cardIds: string[] | undefined,
  model: string = EMBED_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
  onProgress?: (done: number, total: number) => void,
): Promise<ReindexResult> {
  const cards = fetchCardsForEmbedding(db, workspaceId, cardIds);
  let indexed = 0;
  let skipped = 0;
  let done = 0;
  const total = cards.length;
  if (total > 0) onProgress?.(done, total);

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);
    for (const c of batch) {
      const body = (c.description ?? "").trim();
      // A card always has a title; embed "title + description" as one document.
      // If archived (only reachable via an explicit cardIds request), drop it.
      if (c.archived_at) {
        deleteTaskEmbeddingSections(db, c.id);
        skipped++; done++; onProgress?.(done, total);
        continue;
      }
      const sections = splitIntoSections(c.title, body || c.title);
      const existing = getCardEmbeddings(db, c.id);
      const existingBySectionIdx = new Map(existing.map((e) => [e.sectionIdx, e]));

      const todo: SectionToEmbed[] = [];
      for (const s of sections) {
        const text = `${c.title}\n\n## ${s.title}\n${s.text}`;
        const hash = sha256(text);
        const ex = existingBySectionIdx.get(s.idx);
        if (ex && ex.contentHash === hash && ex.model === model && ex.task === "search_document") continue;
        todo.push({ noteId: c.id, idx: s.idx, title: s.title, text, hash });
      }
      if (sections.length > 0) deleteTaskEmbeddingSections(db, c.id, sections.length);

      if (todo.length === 0) {
        skipped++; done++; onProgress?.(done, total);
        continue;
      }
      for (const s of todo) {
        const [v] = await embed([s.text], "search_document", model);
        upsertTaskEmbedding(db, {
          cardId: s.noteId,
          sectionIdx: s.idx,
          sectionTitle: s.title,
          workspaceId,
          model,
          task: "search_document",
          contentHash: s.hash,
          vector: v,
        });
        indexed++;
      }
      done++; onProgress?.(done, total);
    }
  }
  return { indexed, skipped, total };
}

export interface AdjacentTask {
  cardId: string;
  title: string;
  score: number;
  sectionTitle: string;
}

/** Semantic search over task cards (parallel to searchAdjacent for notes). */
export async function searchAdjacentTasks(
  db: Database.Database,
  workspaceId: string,
  queryText: string,
  k: number = 5,
  model: string = EMBED_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
): Promise<AdjacentTask[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const queryHash = sha256(`q|${model}|${trimmed}`);
  let queryVec = queryCache.get(queryHash);
  if (queryVec) {
    queryCache.delete(queryHash);
    queryCache.set(queryHash, queryVec);
  } else {
    queryVec = await embedSectionText(embed, trimmed, "search_query", model);
    if (queryCache.size >= QUERY_CACHE_MAX) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) queryCache.delete(firstKey);
    }
    queryCache.set(queryHash, queryVec);
  }
  const stored = getAllTaskEmbeddingsForWorkspace(db, workspaceId, "search_document");
  if (stored.length === 0) return [];
  const query = toFloat32(queryVec);

  // Rank the WHOLE corpus (best section per card), then slice — never a
  // per-batch cut, so a card that ranks low in one section isn't dropped early.
  const bestPerCard = new Map<string, { cardId: string; score: number; sectionTitle: string }>();
  for (const s of stored) {
    const sim = cosineDot(query, toFloat32(s.vector));
    const cur = bestPerCard.get(s.cardId);
    if (!cur || sim > cur.score) {
      bestPerCard.set(s.cardId, { cardId: s.cardId, score: sim, sectionTitle: s.sectionTitle });
    }
  }
  const top = Array.from(bestPerCard.values()).sort((a, b) => b.score - a.score).slice(0, k);
  if (top.length === 0) return [];

  const idToTitle = new Map<string, string>();
  const placeholders = top.map(() => "?").join(",");
  // Restrict to live cards — archived cards may still have stale embedding rows
  // (e.g. archived outside the app), so exclude them from results here too.
  const rows = db.prepare(
    `SELECT id, title FROM task_cards WHERE id IN (${placeholders}) AND archived_at IS NULL`,
  ).all(...top.map((r) => r.cardId)) as Array<{ id: string; title: string }>;
  for (const r of rows) idToTitle.set(r.id, r.title);
  // Drop any ranked card that didn't resolve to a live row (archived/deleted).
  return top
    .filter((r) => idToTitle.has(r.cardId))
    .map((r) => ({
      cardId: r.cardId,
      title: idToTitle.get(r.cardId) ?? r.cardId,
      score: Math.round(r.score * 1000) / 1000,
      sectionTitle: r.sectionTitle,
    }));
}

export interface ProjectionResult {
  projected: number;
  total: number;
}

export async function recomputeProjections(
  db: Database.Database,
  workspaceId: string,
  model: string = EMBED_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
  onProgress?: (done: number, total: number) => void,
): Promise<ProjectionResult> {
  const existing = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  const byNote = new Map<string, NoteEmbeddingRecord[]>();
  for (const e of existing) {
    if (!byNote.has(e.noteId)) byNote.set(e.noteId, []);
    byNote.get(e.noteId)!.push(e);
  }

  const allNotes = fetchNotes(db, workspaceId);
  const missing: NoteStub[] = [];
  for (const n of allNotes) {
    const recs = byNote.get(n.id);
    const plain = stripMarkdown(n.content);
    const sections = splitIntoSections(n.title, plain);
    const sectionHashes = sections.map((s) => {
      const text = `${n.title}\n\n## ${s.title}\n${s.text}`;
      return sha256(text);
    });
    const stale =
      !recs || recs.length === 0 ||
      recs.length !== sections.length ||
      recs.some((r) =>
        r.model !== model ||
        r.task !== "search_document" ||
        !sectionHashes.includes(r.contentHash),
      );
    if (stale && plain && plain.trim().length > 0) {
      missing.push(n);
    }
  }

  const totalToProcess = missing.length;
  let done = 0;
  if (totalToProcess > 0) onProgress?.(done, totalToProcess);

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    for (const n of batch) {
      const sections = splitIntoSections(n.title, stripMarkdown(n.content));
      deleteNoteEmbeddingSections(db, n.id, sections.length);
      for (const s of sections) {
        const text = `${n.title}\n\n## ${s.title}\n${s.text}`;
        const [v] = await embed([text], "search_document", model);
        upsertNoteEmbedding(db, {
          noteId: n.id,
          sectionIdx: s.idx,
          sectionTitle: s.title,
          workspaceId,
          model,
          task: "search_document",
          contentHash: sha256(text),
          vector: v,
        });
      }
      done++;
      onProgress?.(done, totalToProcess);
    }
  }

  const all = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  return projectExisting(db, all);
}

function projectExisting(db: Database.Database, records: NoteEmbeddingRecord[]): ProjectionResult {
  if (records.length === 0) return { projected: 0, total: 0 };

  const byNote = new Map<string, number[][]>();
  for (const r of records) {
    if (!byNote.has(r.noteId)) byNote.set(r.noteId, []);
    byNote.get(r.noteId)!.push(r.vector);
  }

  const noteIds = Array.from(byNote.keys());
  const avgVectors = noteIds.map((id) => {
    const vecs = byNote.get(id)!;
    return toFloat32(averageVectors(vecs));
  });

  const raw = projectTo2d(avgVectors);
  const normalised = normaliseProjection(raw);
  for (let i = 0; i < noteIds.length; i++) {
    const p = normalised[i];
    markEmbeddingProjectionFresh(db, noteIds[i], p.x, p.y);
  }
  return { projected: noteIds.length, total: noteIds.length };
}

export function getEmbeddingsForClustering(db: Database.Database, workspaceId: string): NoteEmbeddingRecord[] {
  return getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
}

export function getEmbeddingsForSearch(db: Database.Database, workspaceId: string): NoteEmbeddingRecord[] {
  return getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
}
