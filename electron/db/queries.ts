/**
 * Cairn — SQLite query helpers (single source of truth for all SQL).
 *
 * All reads return TypeScript domain types (from src/types/index.ts).
 * JSON columns are parsed on read and serialised on write.
 *
 * Naming: snake_case columns → camelCase fields in returned objects.
 *
 * This module is the barrel for the per-domain query modules (cleanup
 * Phase 4 split of the former 1784-line god file — import from the domain
 * modules directly in new code):
 *   workspace-queries.ts — session profiles, workspaces, projects + merge
 *   notes-queries.ts     — notes
 *   board-queries.ts     — board columns + task cards
 *   tags-queries.ts      — tags + slash commands
 *   chat-queries.ts      — chat threads + MCP notifications
 *   flow-queries.ts      — idea flow
 *   tools-queries.ts     — coding-agent registry + MCP/services/attachments
 *   sessions-queries.ts  — coding-agent sessions/messages/todos
 * Cross-cutting reads (full snapshot, seed guard, FTS search) live here.
 *
 * ── Governance ──────────────────────────────────────────────────────────────
 * This module is imported by BOTH the Electron main process and the esbuild-
 * bundled MCP server (see `electron/mcp/tools/codebase.ts`, `tags.ts`,
 * `projects.ts`, `notes.ts`, `tasks.ts`, `flow.ts`, `dashboards.ts`, `graph.ts`,
 * and `electron/mcp/db.ts`). It is safe to import from `mcp/tools/*` because the
 * only ABI-sensitive operation in better-sqlite3 is constructing the `Database`
 * instance — that happens in `electron/db/client.ts` (Electron), the MCP
 * runtime (`mcp-server.ts`), and the readonly workspace-detection probe in
 * `electron/mcp/db.ts` (`findDbPath`, readonly + closed immediately). All
 * `db.prepare(...).run(...)` calls here execute on an already-constructed
 * handle regardless of which TS file defines them.
 *
 * **Never** construct a `Database` instance in this file or any query module.
 * (Test code is exempt — vitest runs in plain Node via the
 * `vitest-sqlite-shim.cjs` alias.)
 *
 * For knowledge-graph traversal, see `electron/db/graph-queries.ts` which
 * exports `getKnowledgeGraph` and `getNeighbours` (also safe to import from
 * `mcp/tools/*` — see `electron/mcp/tools/graph.ts`).
 */

import type Database from "better-sqlite3";
import { newId } from "./utils";
import { toNote, toCard, type DbRow } from "../host-shared/db-mappers";
import { ftsMatchQuery } from "../../shared/notes/text";
import { getAllWorkspaces, getProjects } from "./workspace-queries";
import { getNotes } from "./notes-queries";
import { getColumns, getCards } from "./board-queries";
import { getTags } from "./tags-queries";

/** Re-export for callers that only need a new ID without importing utils directly. */
export { newId as generateId };

// ── Full snapshot (for MCP / AI chat) ────────

export function getFullSnapshot(db: Database.Database) {
  return {
    workspaces: getAllWorkspaces(db),
    projects: getProjects(db),
    notes: getNotes(db),
    columns: getColumns(db),
    cards: getCards(db),
    tags: getTags(db),
  };
}

// ── Seed guard ────────────────────────────────

export function hasData(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM workspaces").get() as { cnt: number };
  return row.cnt > 0;
}

// ── Search ────────────────────────────────────

export interface SearchNotesOpts {
  query: string;
  projectId?: string;
  workspaceId?: string;
  limit?: number;
}

export interface SearchTasksOpts {
  query: string;
  projectId?: string;
  workspaceId?: string;
  limit?: number;
}

export function searchNotes(db: Database.Database, opts: SearchNotesOpts) {
  const match = ftsMatchQuery(opts.query);
  const limit = opts.limit ?? 10;
  if (!match) return [];
  return db
    .prepare(
      `SELECT n.* FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ?
         AND n.archived_at IS NULL AND n.deleted_at IS NULL AND n.type = 'note'
         AND (? IS NULL OR n.project_id = ?)
         AND (? IS NULL OR n.workspace_id = ?)
       ORDER BY n.updated_at DESC
       LIMIT ?`
    )
    .all(match, opts.projectId ?? null, opts.projectId ?? null, opts.workspaceId ?? null, opts.workspaceId ?? null, limit)
    .map((row) => toNote(row as DbRow));
}

export function searchTasks(db: Database.Database, opts: SearchTasksOpts) {
  const q = opts.query.toLowerCase();
  const limit = opts.limit ?? 10;
  return db
    .prepare(
      `SELECT * FROM task_cards
       WHERE archived_at IS NULL AND deleted_at IS NULL
         AND (? IS NULL OR project_id = ?)
         AND (lower(title) LIKE ? OR lower(description) LIKE ?)
       LIMIT ?`
    )
    .all(opts.projectId ?? null, opts.projectId ?? null, `%${q}%`, `%${q}%`, limit)
    .map((row) => toCard(row as DbRow));
}

// ── Per-domain modules (re-exported so existing importers keep working) ─────

export * from "./workspace-queries";
export * from "./notes-queries";
export * from "./board-queries";
export * from "./tags-queries";
export * from "./chat-queries";
export * from "./flow-queries";
export * from "./tools-queries";
export * from "./sessions-queries";

// ── Codebase semantic indexing ────────────────

export * from "./codebase-queries";

// ── Embeddings ────────────────────────────────

export * from "./embeddings-queries";

// ── User writing style ────────────────────────

export * from "./user-style-queries";
