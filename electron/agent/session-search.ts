/**
 * Semantic index over past chats and coding sessions. One vector per exchange
 * (a user message plus the replies up to the next one). Vectors live in SQLite;
 * the text stays in the session log and is read back when a hit is shown.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { deleteSessionEmbeddings, getSessionChunkHashes, getSessionEmbeddingsForWorkspace, upsertSessionChunk } from "../db/embeddings-queries";
import { toFloat32 } from "../embeddings/cosine";
import type { EmbedTask } from "../embeddings/types";
import { listSessions, readSession, SESSION_FILE } from "./session/log";
import { turnsOf } from "./tools/sessions";

export type EmbedFn = (texts: string[], task: EmbedTask, model?: string) => Promise<number[][]>;

const CHUNK_CHARS = 1500;
const BATCH = 16;
/** Newest sessions first; one call never embeds more than this many exchanges. */
const INDEX_BUDGET = 160;
/** bge-small: unrelated text sits around 0.3–0.45. */
const MIN_SCORE = 0.55;

export interface Exchange { idx: number; text: string; hash: string }

/** Split a session's turns into exchanges; `idx` is the turn index of the user message that starts one. */
export function exchangesOf(records: Parameters<typeof turnsOf>[0]): Exchange[] {
  const out: Exchange[] = [];
  let cur: { idx: number; parts: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join("\n").slice(0, CHUNK_CHARS);
    out.push({ idx: cur.idx, text, hash: createHash("sha256").update(text).digest("hex") });
  };
  for (const t of turnsOf(records)) {
    if (t.role === "user") { flush(); cur = { idx: t.index, parts: [`User: ${t.text}`] }; }
    else if (cur) cur.parts.push(`Assistant: ${t.text}`);
  }
  flush();
  return out;
}

const inFlight = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(key);
  if (prev) await prev.catch(() => undefined);
  const p = run();
  inFlight.set(key, p);
  try { return await p; } finally { if (inFlight.get(key) === p) inFlight.delete(key); }
}

export interface SessionIndexDeps { db: Database.Database; root: string; workspaceId: string; model: string; embed: EmbedFn }

/** Embed the exchanges of `sessionIds` that are new or changed. Returns how many are still waiting for a later call. */
export function indexSessions(d: SessionIndexDeps, sessionIds: string[], budget = INDEX_BUDGET): Promise<{ embedded: number; remaining: number }> {
  return exclusive(`index:${d.workspaceId}`, async () => {
    let embedded = 0;
    let remaining = 0;
    for (const id of sessionIds) {
      const log = await readSession(d.root, id).catch(() => undefined);
      if (!log || log.header.parentId) continue;
      const have = getSessionChunkHashes(d.db, id, d.model);
      const todo = exchangesOf(log.records).filter((e) => have.get(e.idx) !== e.hash);
      const take = todo.slice(0, Math.max(0, budget - embedded));
      remaining += todo.length - take.length;
      for (let i = 0; i < take.length; i += BATCH) {
        const batch = take.slice(i, i + BATCH);
        const vectors = await d.embed(batch.map((e) => e.text), "search_document", d.model);
        batch.forEach((e, j) => upsertSessionChunk(d.db, { sessionId: id, chunkIdx: e.idx, workspaceId: d.workspaceId, model: d.model, contentHash: e.hash, vector: vectors[j] }));
        embedded += batch.length;
      }
    }
    return { embedded, remaining };
  });
}

export interface SemanticHit { sessionId: string; idx: number; score: number }

/** Best exchange per session for `query`, restricted to `allowed` sessions. */
export async function searchSessionsSemantic(d: SessionIndexDeps, allowed: Set<string>, query: string, limit: number): Promise<{ hits: SemanticHit[]; remaining: number }> {
  // Newest sessions first, so a partial index still covers recent work.
  const existing = await listSessions(d.root);
  const dated = await Promise.all(existing.filter((id) => allowed.has(id)).map(async (id) => ({ id, m: await stat(path.join(d.root, id, SESSION_FILE)).then((s) => s.mtimeMs).catch(() => 0) })));
  const ids = dated.sort((a, b) => b.m - a.m).map((x) => x.id);
  const { remaining } = await indexSessions(d, ids);
  const [qv] = await d.embed([query], "search_query", d.model);
  const q = toFloat32(qv);
  const best = new Map<string, SemanticHit>();
  const gone = new Set<string>();
  const present = new Set(existing);
  for (const row of getSessionEmbeddingsForWorkspace(d.db, d.workspaceId, d.model)) {
    if (!allowed.has(row.sessionId)) continue;
    if (!present.has(row.sessionId)) { gone.add(row.sessionId); continue; }
    const v = toFloat32(row.vector);
    let dot = 0;
    for (let i = 0; i < Math.min(q.length, v.length); i++) dot += q[i] * v[i];
    const cur = best.get(row.sessionId);
    if (!cur || dot > cur.score) best.set(row.sessionId, { sessionId: row.sessionId, idx: row.chunkIdx, score: dot });
  }
  for (const id of gone) deleteSessionEmbeddings(d.db, id); // the log was deleted: drop its vectors
  const hits = [...best.values()].filter((h) => h.score >= MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits, remaining };
}

/** The app's embedding runtime (lazy: it pulls in the worker client). */
export const runtimeEmbed: EmbedFn = async (texts, task, model) => (await import("../runtime/client")).embed(texts, task, model);
