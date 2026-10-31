/**
 * Hybrid retrieval glue for desktop: FTS5 (bm25) keyword hits + the dense
 * cosine ranking go through the shared ranker in `shared/retrieval/hybrid.ts`.
 * The ranker itself is platform-free; this file only does the SQLite I/O.
 */
import type Database from "better-sqlite3";
import { ftsOrQuery, hybridRank, type RetrievalCandidate } from "../../shared/retrieval/hybrid";

/** Rows fetched from FTS per query (the keyword candidate pool). */
const FTS_LIMIT = 50;
/** Body text kept per candidate for coverage / MMR similarity. */
const TEXT_CHARS = 4000;

export interface KeywordDoc {
  id: string;
  title: string;
  text: string;
  /** bm25 relevance, higher is better (FTS5 reports lower-is-better negatives). */
  keyword?: number;
}

type FtsKind = {
  fts: string;
  table: string;
  body: string;
  extraWhere: string;
};
const NOTES: FtsKind = { fts: "notes_fts", table: "notes", body: "content", extraWhere: "AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.type = 'note'" };
const TASKS: FtsKind = { fts: "tasks_fts", table: "task_cards", body: "description", extraWhere: "AND t.archived_at IS NULL" };

function ftsHits(db: Database.Database, kind: FtsKind, workspaceId: string, query: string): KeywordDoc[] {
  const match = ftsOrQuery(query);
  if (!match) return [];
  try {
    const rows = db
      .prepare(
        `SELECT t.id AS id, t.title AS title, substr(coalesce(t.${kind.body}, ''), 1, ${TEXT_CHARS}) AS text,
                bm25(${kind.fts}, 10.0, 1.0) AS score
           FROM ${kind.fts} JOIN ${kind.table} t ON t.rowid = ${kind.fts}.rowid
          WHERE ${kind.fts} MATCH ? AND t.workspace_id = ? ${kind.extraWhere}
          ORDER BY score LIMIT ${FTS_LIMIT}`,
      )
      .all(match, workspaceId) as { id: string; title: string; text: string; score: number }[];
    return rows.map((r) => ({ id: r.id, title: r.title, text: r.text, keyword: -r.score }));
  } catch {
    // FTS table missing (very old DB) or MATCH rejected: dense-only is still valid.
    return [];
  }
}

export const noteKeywordHits = (db: Database.Database, workspaceId: string, query: string) => ftsHits(db, NOTES, workspaceId, query);
export const taskKeywordHits = (db: Database.Database, workspaceId: string, query: string) => ftsHits(db, TASKS, workspaceId, query);

/** Title + text for dense hits the keyword query didn't already return. */
export function loadDocs(db: Database.Database, kind: "notes" | "tasks", ids: string[], liveOnly = false): Map<string, KeywordDoc> {
  const out = new Map<string, KeywordDoc>();
  if (ids.length === 0) return out;
  const k = kind === "notes" ? NOTES : TASKS;
  const rows = db
    .prepare(
      `SELECT id, title, substr(coalesce(${k.body}, ''), 1, ${TEXT_CHARS}) AS text FROM ${k.table}
        WHERE id IN (${ids.map(() => "?").join(",")})${liveOnly && kind === "tasks" ? " AND archived_at IS NULL" : ""}`,
    )
    .all(...ids) as { id: string; title: string; text: string }[];
  for (const r of rows) out.set(r.id, { id: r.id, title: r.title, text: r.text });
  return out;
}

export interface DenseEntity {
  id: string;
  score: number;
  sectionTitle: string;
  vector?: Float32Array;
}

export interface FusedHit {
  id: string;
  /** Raw dense cosine of the best section, 0 when the entity has no embedding yet. */
  score: number;
  sectionTitle: string;
}

/**
 * Fuse the best-section dense ranking with FTS keyword hits. `dense` is one entry
 * per entity (already best-section). Keyword-only entities (not embedded yet)
 * are kept with score 0 so freshly written notes are still findable.
 */
export function fuseDenseAndKeyword(
  query: string,
  dense: DenseEntity[],
  keyword: KeywordDoc[],
  docs: Map<string, KeywordDoc>,
  maxK: number,
): FusedHit[] {
  const byId = new Map<string, RetrievalCandidate>();
  const meta = new Map<string, DenseEntity>();
  for (const d of dense) {
    const doc = docs.get(d.id);
    byId.set(d.id, { id: d.id, group: d.id, dense: d.score, title: doc?.title, text: doc?.text, vector: d.vector });
    meta.set(d.id, d);
  }
  for (const kw of keyword) {
    const cur = byId.get(kw.id);
    if (cur) {
      cur.keyword = kw.keyword;
      cur.title = kw.title;
      cur.text = kw.text;
    } else {
      byId.set(kw.id, { id: kw.id, group: kw.id, keyword: kw.keyword, title: kw.title, text: kw.text });
    }
  }
  return hybridRank(query, [...byId.values()], { maxK }).map((r) => {
    const d = meta.get(r.id);
    return { id: r.id, score: d?.score ?? 0, sectionTitle: d?.sectionTitle ?? "" };
  });
}
