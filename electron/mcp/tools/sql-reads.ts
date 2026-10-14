/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Read tools answered with targeted SQL instead of the full workspace snapshot.
 *
 * Before this, every tool call loaded every note body, card, column and tag
 * (`getFullSnapshot`) and filtered in JS — so a search or a single-card read
 * cost time and memory proportional to the whole workspace. These run indexed
 * queries and only touch the rows they return. Result shapes match the
 * snapshot-based implementations they replace (read-tools-pure.ts).
 *
 * Search ranking: full-text (FTS5, bm25 with title weighted over body) first,
 * then any notes/cards that only match as a substring — "auth" inside "oauth",
 * which token search can't see — newest first. So recall is unchanged from the
 * old substring-only search, and the best matches now come first.
 */
import type Database from "better-sqlite3";
import { ftsMatchQuery, matchesQuery, queryTerms } from "../../../shared/notes/text";
import { noteExcerpt } from "../../../shared/notes/excerpt";
import { isOverdue, isDueWithin } from "../../../shared/notes/due";
import { stripMarkdown } from "../../host-shared/text-utils";

type Args = Record<string, any>;

const ASCII = /^[\x00-\x7f]*$/;

function tagIdByName(db: Database.Database, name: string): string | undefined {
  return (db.prepare("SELECT id FROM tags WHERE lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1").get(name) as { id: string } | undefined)?.id;
}

/** Shared WHERE fragments for a filter set; `alias` is the table alias. */
function whereClause(alias: string, f: Array<[string, unknown[]] | false | undefined>): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const item of f) {
    if (!item) continue;
    parts.push(item[0].split("@").join(`${alias}.`));
    params.push(...item[1]);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params };
}

/**
 * The standalone MCP server never runs migrations, so it can meet a workspace the
 * app hasn't upgraded yet (no tasks_fts). Search then falls back to substring.
 */
function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

/**
 * SQL that requires every query term as a plain substring of `a` or `b`
 * (case-insensitive). `exact` is false when a term is non-ASCII — SQLite's
 * lower() only folds ASCII — and the caller must verify in JS.
 */
function plainTextCheck(query: string, a: string, b: string): { sql: string; params: string[]; exact: boolean } {
  const terms = queryTerms(query);
  const ascii = terms.filter((t) => ASCII.test(t));
  const sql = ascii.map(() => ` AND (instr(lower(${a}), ?) > 0 OR instr(lower(coalesce(${b}, '')), ?) > 0)`).join("");
  return { sql, params: ascii.flatMap((t) => [t, t]), exact: ascii.length === terms.length };
}

// ── Notes ──────────────────────────────────────────────────────────────────

export function searchNotesSql(db: Database.Database, args: Args): unknown {
  const query = String(args.query ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 10;
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const tagId = args.tag ? tagIdByName(db, String(args.tag)) : undefined;
  if (args.tag && !tagId) return [];
  const after = args.updatedAfter ? new Date(args.updatedAfter).toISOString() : undefined;
  const filters = whereClause("n", [
    ["@deleted_at IS NULL AND @archived_at IS NULL", []],
    args.projectId && ["@project_id = ?", [args.projectId]],
    args.folder !== undefined && ["lower(coalesce(@folder, '')) = lower(?)", [String(args.folder)]],
    args.type && ["coalesce(@type, 'note') = ?", [args.type]],
    tagId && ["EXISTS (SELECT 1 FROM json_each(@tag_ids) WHERE value = ?)", [tagId]],
    after && ["@updated_at >= ?", [after]],
  ]);

  let ids: string[];
  if (queryTerms(query).length === 0) {
    ids = (db.prepare(`SELECT n.id FROM notes n WHERE ${filters.sql} ORDER BY n.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...filters.params, limit, offset) as { id: string }[]).map((r) => r.id);
  } else {
    const want = offset + limit;
    // The tokenizer drops punctuation ("c++" would become prefix "c"), so every
    // FTS hit must also contain each term as plain text in the raw title/body.
    // The check runs in SQL for ASCII terms (lower() is ASCII-only); a query with
    // a non-ASCII term is verified in JS instead.
    const { sql: textSql, params: textParams, exact } = plainTextCheck(query, "n.title", "n.content");
    const ranked = (db.prepare(
      `SELECT n.id${exact ? "" : ", n.title, n.content"} FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ? AND ${filters.sql}${textSql}
        ORDER BY bm25(notes_fts, 10.0, 1.0), n.updated_at DESC${exact ? " LIMIT ?" : ""}`,
    ).all(ftsMatchQuery(query), ...filters.params, ...textParams, ...(exact ? [want] : [])) as { id: string; title?: string; content?: string | null }[])
      .filter((r) => exact || matchesQuery(query, `${r.title}\n${r.content ?? ""}`))
      .slice(0, want)
      .map((r) => r.id);
    if (ranked.length < want) {
      const seen = new Set(ranked);
      // Substring pass (same AND-of-terms semantics as before), SQL-prefiltered
      // on ASCII terms; every candidate is verified with the exact matcher.
      const terms = queryTerms(query).filter((t) => ASCII.test(t));
      const pre = terms.map(() => "(instr(lower(n.title), ?) > 0 OR instr(lower(coalesce(n.content, '')), ?) > 0)").join(" AND ");
      const rows = db.prepare(
        `SELECT n.id, n.title, n.content FROM notes n WHERE ${filters.sql}${pre ? ` AND ${pre}` : ""} ORDER BY n.updated_at DESC`,
      ).all(...filters.params, ...terms.flatMap((t) => [t, t])) as { id: string; title: string; content: string | null }[];
      for (const r of rows) {
        if (ranked.length >= want) break;
        if (!seen.has(r.id) && matchesQuery(query, `${r.title}\n${stripMarkdown(r.content ?? "")}`)) ranked.push(r.id);
      }
    }
    ids = ranked.slice(offset, offset + limit);
  }
  if (ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT id, title, project_id AS projectId, folder, updated_at AS updatedAt, substr(coalesce(content, ''), 1, 600) AS head
       FROM notes WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as { id: string; title: string; projectId: string; folder: string | null; updatedAt: string; head: string }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!).filter(Boolean).map((r) => ({
    id: r.id,
    title: r.title,
    snippet: noteExcerpt(r.head, stripMarkdown).slice(0, 120),
    projectId: r.projectId,
    folder: r.folder ?? "",
    updatedAt: r.updatedAt,
  }));
}

// ── Tasks ──────────────────────────────────────────────────────────────────

const DESCRIPTION_LIMIT = 400;

interface CardRow {
  id: string; title: string; description: string | null; columnId: string; columnName: string | null;
  columnType: string | null; priority: string; projectId: string; dueDate: string | null;
}

const CARD_SELECT = `SELECT c.id, c.title, c.description, c.column_id AS columnId, col.name AS columnName,
  col.type AS columnType, c.priority, c.project_id AS projectId, c.due_date AS dueDate
  FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id AND col.deleted_at IS NULL`;

function shapeSearchCard(c: CardRow): Record<string, unknown> {
  const desc = c.description ?? "";
  const out: Record<string, unknown> = {
    id: c.id,
    title: c.title,
    columnId: c.columnId,
    columnName: c.columnName ?? "Unknown",
    columnType: c.columnType ?? "custom",
    priority: c.priority,
    projectId: c.projectId,
  };
  if (c.description !== null) {
    out.description = desc.length > DESCRIPTION_LIMIT
      ? desc.slice(0, DESCRIPTION_LIMIT) + "\n... (description truncated, use get_item to read full description)"
      : desc;
  }
  if (c.dueDate) out.dueDate = c.dueDate;
  return out;
}

export function searchTasksSql(db: Database.Database, args: Args): unknown {
  const query = String(args.query ?? "");
  const limit = typeof args.limit === "number" ? args.limit : 10;
  const tagId = args.tag ? tagIdByName(db, String(args.tag)) : undefined;
  if (args.tag && !tagId) return [];
  const filters = whereClause("c", [
    ["@deleted_at IS NULL AND @archived_at IS NULL", []],
    args.projectId && ["@project_id = ?", [args.projectId]],
    args.assignee && ["lower(coalesce(@assignee, '')) = lower(?)", [String(args.assignee)]],
    tagId && ["EXISTS (SELECT 1 FROM json_each(@tag_ids) WHERE value = ?)", [tagId]],
    args.columnType && ["col.type = ?", [args.columnType]],
  ]);

  if (queryTerms(query).length === 0) {
    return (db.prepare(`${CARD_SELECT} WHERE ${filters.sql} ORDER BY c."order" LIMIT ?`)
      .all(...filters.params, limit) as CardRow[]).map(shapeSearchCard);
  }
  // Same plain-text check as notes: punctuation is invisible to the tokenizer.
  const { sql: textSql, params: textParams, exact } = plainTextCheck(query, "c.title", "c.description");
  const ranked = (!hasTable(db, "tasks_fts") ? [] : db.prepare(
    `${CARD_SELECT} JOIN tasks_fts ON tasks_fts.rowid = c.rowid
      WHERE tasks_fts MATCH ? AND ${filters.sql}${textSql}
      ORDER BY bm25(tasks_fts, 10.0, 1.0), c."order"${exact ? " LIMIT ?" : ""}`,
  ).all(ftsMatchQuery(query), ...filters.params, ...textParams, ...(exact ? [limit] : [])) as CardRow[])
    .filter((r) => exact || matchesQuery(query, `${r.title}\n${r.description ?? ""}`))
    .slice(0, limit);
  if (ranked.length < limit) {
    const seen = new Set(ranked.map((c) => c.id));
    const terms = queryTerms(query).filter((t) => ASCII.test(t));
    const pre = terms.map(() => "(instr(lower(c.title), ?) > 0 OR instr(lower(coalesce(c.description, '')), ?) > 0)").join(" AND ");
    const rows = db.prepare(`${CARD_SELECT} WHERE ${filters.sql}${pre ? ` AND ${pre}` : ""} ORDER BY c."order"`)
      .all(...filters.params, ...terms.flatMap((t) => [t, t])) as CardRow[];
    for (const r of rows) {
      if (ranked.length >= limit) break;
      if (!seen.has(r.id) && matchesQuery(query, `${r.title}\n${r.description ?? ""}`)) ranked.push(r);
    }
  }
  return ranked.map(shapeSearchCard);
}

/** Open (not done/archived/deleted) cards with a due date — the input to the due lists. */
function openDatedCards(db: Database.Database, projectId?: string) {
  return db.prepare(
    `SELECT c.id, c.title, c.priority, c.due_date AS dueDate, c.column_id AS columnId,
            coalesce(col.name, 'Unknown') AS columnName, col.type AS columnType, c.project_id AS projectId
       FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id AND col.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND c.due_date IS NOT NULL AND c.due_date != ''
        AND coalesce(col.type, '') != 'done' AND (? IS NULL OR c.project_id = ?)
      ORDER BY c.due_date`,
  ).all(projectId ?? null, projectId ?? null) as Array<{ id: string; title: string; priority: string; dueDate: string; columnId: string; columnName: string; columnType: string | null; projectId: string }>;
}

export function listOverdueTasksSql(db: Database.Database, args: Args): unknown {
  return openDatedCards(db, args.projectId).filter((c) => isOverdue(c.dueDate));
}

export function listTasksDueSql(db: Database.Database, args: Args): unknown {
  const days = typeof args.days === "number" ? args.days : 7;
  const includeOverdue = args.includeOverdue !== false;
  return openDatedCards(db, args.projectId).filter((c) => isDueWithin(c.dueDate, days) || (includeOverdue && isOverdue(c.dueDate)));
}
