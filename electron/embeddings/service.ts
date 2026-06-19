import * as crypto from "crypto";

import type Database from "better-sqlite3";
import {
  upsertNoteEmbedding,
  getNoteEmbedding,
  getAllEmbeddingsForWorkspace,
  markEmbeddingProjectionFresh,
  pruneOrphanedClusteringRows,
  deleteNoteEmbedding,
} from "../db/queries";
import type { NoteEmbeddingRecord } from "../db/queries";
import { embed as clientEmbed } from "./client";
import { projectTo2d, normaliseProjection } from "./projection";
import { topK, toFloat32 } from "./cosine";
import { NOMIC_MODEL_ID, NOMIC_DIM } from "./types";
import type { NomicTask } from "./types";

export type EmbedFn = (texts: string[], task: NomicTask, model?: string) => Promise<number[][]>;

const defaultEmbed: EmbedFn = (texts, task, model) => clientEmbed(texts, task, model);

const BATCH_SIZE = 16;
const CHUNK_CHAR_LIMIT = 4000;
const CHUNK_OVERLAP = 200;

const queryCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 64;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

interface TextChunk {
  text: string;
  hash: string;
}

function chunkLongText(text: string): TextChunk[] {
  if (text.length <= CHUNK_CHAR_LIMIT) {
    return [{ text, hash: sha256(text) }];
  }
  const chunks: TextChunk[] = [];
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
    chunks.push({ text: text.slice(start, end), hash: sha256(text.slice(start, end)) });
    if (end >= text.length) break;
    const nextStart = end - CHUNK_OVERLAP;
    if (nextStart <= start) break;
    start = nextStart;
  }
  return chunks;
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return new Array(NOMIC_DIM).fill(0);
  if (vectors.length === 1) return vectors[0];
  const out = new Array<number>(NOMIC_DIM);
  for (let i = 0; i < NOMIC_DIM; i++) out[i] = 0;
  for (const v of vectors) {
    for (let i = 0; i < NOMIC_DIM; i++) out[i] += v[i];
  }
  let norm = 0;
  for (let i = 0; i < NOMIC_DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return out;
  for (let i = 0; i < NOMIC_DIM; i++) out[i] = out[i] / norm;
  return out;
}

async function embedChunkedDocument(
  embed: EmbedFn,
  text: string,
  task: NomicTask,
  model: string,
): Promise<{ vector: number[]; hash: string }> {
  const chunks = chunkLongText(text);
  const hash = sha256(text);
  if (chunks.length === 1) {
    const [v] = await embed([chunks[0].text], task, model);
    return { vector: v, hash };
  }
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => c.text);
    const res = await embed(batch, task, model);
    vectors.push(...res);
  }
  return { vector: averageVectors(vectors), hash };
}

interface NoteStub {
  id: string;
  workspace_id: string;
  title: string;
  content_text: string;
  archived_at: string | null;
}

function fetchNotes(db: Database.Database, workspaceId: string, noteIds?: string[]): NoteStub[] {
  if (noteIds && noteIds.length > 0) {
    const placeholders = noteIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, workspace_id, title, content_text, archived_at
       FROM notes WHERE workspace_id = ? AND id IN (${placeholders})`
    ).all(workspaceId, ...noteIds) as NoteStub[];
  }
  return db.prepare(
    `SELECT id, workspace_id, title, content_text, archived_at
     FROM notes WHERE workspace_id = ? AND archived_at IS NULL`
  ).all(workspaceId) as NoteStub[];
}

export interface ReindexResult {
  indexed: number;
  skipped: number;
  total: number;
}

export async function reindexNotes(
  db: Database.Database,
  workspaceId: string,
  noteIds: string[] | undefined,
  model: string = NOMIC_MODEL_ID,
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
    const todo: Array<{ note: NoteStub; text: string }> = [];
    for (const n of batch) {
      if (!n.content_text || n.content_text.trim().length === 0) {
        deleteNoteEmbedding(db, n.id);
        skipped++;
        done++;
        onProgress?.(done, total);
        continue;
      }
      const text = `${n.title}\n\n${n.content_text}`;
      const hash = sha256(text);
      const existing = getNoteEmbedding(db, n.id);
      if (existing && existing.contentHash === hash && existing.model === model && existing.task === "search_document") {
        skipped++;
        done++;
        onProgress?.(done, total);
        continue;
      }
      todo.push({ note: n, text });
    }
    if (todo.length === 0) continue;
    const chunkedResults = await Promise.all(
      todo.map((t) => embedChunkedDocument(embed, t.text, "search_document", model)),
    );
    for (let j = 0; j < todo.length; j++) {
      const { note } = todo[j];
      const { vector, hash } = chunkedResults[j];
      upsertNoteEmbedding(db, {
        noteId: note.id,
        workspaceId,
        model,
        task: "search_document",
        contentHash: hash,
        vector,
      });
      indexed++;
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
}

export async function searchAdjacent(
  db: Database.Database,
  workspaceId: string,
  queryText: string,
  k: number = 5,
  excludeIds: string[] = [],
  model: string = NOMIC_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
): Promise<AdjacentNote[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const queryHash = sha256(`q|${model}|${trimmed}`);
  let queryVec = queryCache.get(queryHash);
  if (queryVec) {
    // refresh recency for LRU behaviour
    queryCache.delete(queryHash);
    queryCache.set(queryHash, queryVec);
  } else {
    const { vector } = await embedChunkedDocument(embed, trimmed, "search_query", model);
    queryVec = vector;
    if (queryCache.size >= QUERY_CACHE_MAX) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) queryCache.delete(firstKey);
    }
    queryCache.set(queryHash, queryVec);
  }
  const stored = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  if (stored.length === 0) return [];
  const query = toFloat32(queryVec);
  const pool = stored.map((s) => ({
    noteId: s.noteId,
    vector: toFloat32(s.vector),
  }));
  const excludeSet = new Set(excludeIds);
  const results = topK(query, pool, k, 0, excludeSet);
  if (results.length === 0) return [];
  const idToTitle = new Map<string, string>();
  const placeholders = results.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, title FROM notes WHERE id IN (${placeholders})`
  ).all(...results.map((r) => r.item.noteId)) as Array<{ id: string; title: string }>;
  for (const r of rows) idToTitle.set(r.id, r.title);
  return results.map((r) => ({
    noteId: r.item.noteId,
    title: idToTitle.get(r.item.noteId) ?? r.item.noteId,
    score: Math.round(r.score * 1000) / 1000,
  }));
}
export interface ProjectionResult {
  projected: number;
  total: number;
}

export async function recomputeProjections(
  db: Database.Database,
  workspaceId: string,
  model: string = NOMIC_MODEL_ID,
  embed: EmbedFn = defaultEmbed,
  onProgress?: (done: number, total: number) => void,
): Promise<ProjectionResult> {
  const existing = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  const existingMap = new Map(existing.map((e) => [e.noteId, e]));
  const allNotes = fetchNotes(db, workspaceId);
  const missing: Array<typeof allNotes[number]> = [];
  for (const n of allNotes) {
    const cur = existingMap.get(n.id);
    const text = `${n.title}\n\n${n.content_text}`;
    const hash = sha256(text);
    if (!cur
      || cur.model !== model
      || cur.contentHash !== hash) {
      if (n.content_text && n.content_text.trim().length > 0) {
        missing.push(n);
      }
    }
  }
  const totalToProcess = missing.length;
  let done = 0;
  if (totalToProcess > 0) onProgress?.(done, totalToProcess);
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const chunkedResults = await Promise.all(
      batch.map((n) => embedChunkedDocument(embed, `${n.title}\n\n${n.content_text}`, "search_document", model)),
    );
    for (let j = 0; j < batch.length; j++) {
      const n = batch[j];
      const { vector, hash } = chunkedResults[j];
      upsertNoteEmbedding(db, {
        noteId: n.id,
        workspaceId,
        model,
        task: "search_document",
        contentHash: hash,
        vector,
      });
      done++;
      onProgress?.(done, totalToProcess);
    }
  }
  const all = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  return projectExisting(db, all);
}

function projectExisting(db: Database.Database, records: NoteEmbeddingRecord[]): ProjectionResult {
  if (records.length === 0) return { projected: 0, total: 0 };
  const vectors = records.map((r) => toFloat32(r.vector));
  const raw = projectTo2d(vectors);
  const normalised = normaliseProjection(raw);
  for (let i = 0; i < records.length; i++) {
    const p = normalised[i];
    markEmbeddingProjectionFresh(db, records[i].noteId, p.x, p.y);
  }
  return { projected: records.length, total: records.length };
}

export function getEmbeddingsForClustering(db: Database.Database, workspaceId: string): NoteEmbeddingRecord[] {
  return getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
}

export function getEmbeddingsForSearch(db: Database.Database, workspaceId: string): NoteEmbeddingRecord[] {
  return getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
}
