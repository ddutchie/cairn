/**
 * Cairn — note queries.
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";
import { toNote, j, type DbRow } from "../host-shared/db-mappers";
import { normalizeNoteTitle, stripMarkdown } from "../host-shared/text-utils";
import { EXCERPT_SOURCE_CHARS } from "../../shared/notes/excerpt";
import { matchesQuery, queryTerms } from "../../shared/notes/text";

// ── Notes ─────────────────────────────────────

export function getNotes(db: Database.Database, projectId?: string) {
  // Exclude tombstoned rows (deleted_at set). A delete arriving via sync keeps a
  // tombstone row (so the sync staleness guard trips and the delete doesn't
  // re-apply/re-publish every cycle — the "sent=31 forever" loop); filtering it
  // here is what makes such a note vanish from the UI, without physically
  // removing the row.
  const rows = projectId
    ? db.prepare("SELECT * FROM notes WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC").all(projectId)
    : db.prepare("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC").all();
  return rows.map((row) => toNote(row as DbRow));
}

/**
 * Find a live (non-archived, non-deleted) note in a project whose title matches
 * `title` under the same normalization ensure_note uses (trim + collapse inner
 * whitespace, case-sensitive). Returns the note or undefined.
 *
 * This is the AUTHORITATIVE existence check for ensure_note — it reads the live
 * DB rather than a pre-call snapshot, so it stays correct when two ensure_note
  * calls for the same title run in the same agent turn (the Cordis runtime fires a
 * turn's tool calls concurrently). better-sqlite3 is synchronous, so pairing
 * this lookup with the createNote INSERT inside a single db.transaction() makes
 * the check-then-create atomic — no other JS callback can interleave between the
 * SELECT and the INSERT.
 *
 * Matching is done in JS (not SQL) so it is byte-for-byte identical to
 * normalizeNoteTitle — SQL TRIM/REPLACE can't reproduce arbitrary whitespace-run
 * collapse (tabs, newlines) reliably.
 */
export function findLiveNoteByTitle(db: Database.Database, projectId: string, title: string) {
  const target = normalizeNoteTitle(title);
  const rows = db
    .prepare(
      "SELECT * FROM notes WHERE project_id = ? AND type = 'note' AND archived_at IS NULL AND deleted_at IS NULL",
    )
    .all(projectId) as Record<string, unknown>[];
  const hit = rows.find((r) => normalizeNoteTitle(String(r.title ?? "")) === target);
  return hit ? toNote(hit) : undefined;
}

/**
 * Rewrite inbound `[[wikilinks]]` when a note is renamed, updating the DB rows
 * of every OTHER note whose content links to the old title.
 *
 * A rename changes the note's on-disk filename, and Obsidian resolves
 * `[[links]]` by filename — so without this, every note pointing at
 * `[[Old Title]]` would dangle. This is the single source of truth for that
 * rewrite, shared by BOTH the MCP `rename_note` tool and the desktop
 * `db:note:update` handler (a title edit in the note editor) so the two paths
 * behave identically.
 *
 * Rewrites the bare form `[[Old Title]]` and the aliased/section forms
 * `[[Old Title|alias]]` and `[[Old Title#heading]]`, preserving the suffix.
 * `oldTargets` may be a single old title or several (e.g. the title AND the
 * note's original on-disk filename stem — Obsidian links imported notes by
 * filename, which can differ from the title). Each distinct target is rewritten
 * to `newTitle`. Candidates are scoped to the renamed note's own workspace and
 * to real notes (dashboards/templates carry no wikilinks). Does NOT write any
 * `.md` files — it only mutates the DB and returns the affected note rows so the
 * caller can persist them to disk (the caller owns file I/O, watcher
 * suppression, and locking). Must be run inside the same transaction as the
 * title update. Returns [] when nothing links to the note.
 */
export function rewriteInboundWikilinks(
  db: Database.Database,
  renamedNoteId: string,
  oldTargets: string | string[],
  newTitle: string,
): ReturnType<typeof toNote>[] {
  // Distinct, non-empty old targets that actually differ from the new title.
  const targets = Array.from(
    new Set((Array.isArray(oldTargets) ? oldTargets : [oldTargets]).filter((t) => t && t !== newTitle)),
  );
  if (targets.length === 0) return [];

  // Scope to the renamed note's workspace — wikilinks resolve within a vault
  // (workspace), so a note in another workspace can never link here, and
  // scanning them would be both wrong and wasteful.
  const owner = db.prepare("SELECT workspace_id FROM notes WHERE id = ?").get(renamedNoteId) as
    | { workspace_id: string }
    | undefined;
  if (!owner) return [];

  // Candidate rows: live NOTES (not dashboards/templates, not the renamed one)
  // in the same workspace whose content mentions any old target inside a
  // wikilink. Pre-filter in SQL with LIKE to avoid scanning every body in JS;
  // the precise rewrite happens below.
  const likeClause = targets.map(() => "content LIKE ?").join(" OR ");
  const candidates = db.prepare(
    `SELECT * FROM notes
       WHERE id != ? AND workspace_id = ? AND type = 'note'
         AND deleted_at IS NULL AND archived_at IS NULL
         AND (${likeClause})`,
  ).all(renamedNoteId, owner.workspace_id, ...targets.map((t) => `%[[${t}%`)) as Record<string, unknown>[];

  // One combined regex over all targets. Match a target only when immediately
  // followed by ]], |, or # so we never rewrite a title that is a PREFIX of
  // another note's title. Metacharacters in each target are escaped.
  const escaped = targets.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\[\\[(?:${escaped.join("|")})(?=[\\]|#])`, "g");

  const updated: ReturnType<typeof toNote>[] = [];
  for (const row of candidates) {
    const content = String(row.content ?? "");
    const next = content.replace(re, `[[${newTitle}`);
    if (next === content) continue; // LIKE matched but no real wikilink — skip
    const u = updateNote(db, String(row.id), {
      content: next,
    });
    updated.push(u);
  }
  return updated;
}

export function createNote(db: Database.Database, n: {
  id: string; projectId: string; workspaceId: string; title: string;
  content?: string; type?: "note" | "dashboard" | "template";
  tagIds?: string[]; isPinned?: boolean; folder?: string;
}) {
  const now = ts();
  const content = n.content ?? "";
  const type = n.type ?? "note";
  const tagIds = JSON.stringify(n.tagIds ?? []);
  const isPinned = n.isPinned ? 1 : 0;
  const folder = n.folder ?? "";
  db.prepare(`
    INSERT INTO notes (id, project_id, workspace_id, title, content,
      tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, 0)
  `).run(n.id, n.projectId, n.workspaceId, n.title, content, tagIds, isPinned, type, folder, now, now);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(n.id) as DbRow);
}

export function updateNote(db: Database.Database, id: string, patch: Partial<{
  title: string; content: string;
  tagIds: string[]; linkedNoteIds: string[]; linkedCardIds: string[];
  isPinned: boolean; archivedAt: string; type: "note" | "dashboard" | "template"; folder: string;
}>) {
  const now = ts();
  db.prepare(`
    UPDATE notes SET
      title           = COALESCE(?, title),
      content         = COALESCE(?, content),
      tag_ids         = COALESCE(?, tag_ids),
      linked_note_ids = COALESCE(?, linked_note_ids),
      linked_card_ids = COALESCE(?, linked_card_ids),
      is_pinned       = COALESCE(?, is_pinned),
      archived_at     = COALESCE(?, archived_at),
      type            = COALESCE(?, type),
      folder          = COALESCE(?, folder),
      updated_at      = ?,
      version         = version + 1
    WHERE id = ?
  `).run(
    patch.title ?? null,
    patch.content !== undefined ? patch.content : null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.linkedNoteIds ? j(patch.linkedNoteIds) : null,
    patch.linkedCardIds ? j(patch.linkedCardIds) : null,
    patch.isPinned !== undefined ? (patch.isPinned ? 1 : 0) : null,
    patch.archivedAt ?? null,
    patch.type ?? null,
    patch.folder !== undefined ? patch.folder : null,
    now, id,
  );
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as DbRow);
}

/**
 * Soft-delete a note (tombstone). The row is KEPT with `deleted_at` set rather
 * than physically removed. Desktop live queries all filter `deleted_at IS NULL`
 * (see getNotes/findLiveNoteByTitle/searchNotes/graph reads), so a tombstoned
 * note disappears from every list/search exactly like a hard delete — but the
 * durable tombstone row makes sync delete-safe:
 *   - The AFTER UPDATE capture trigger stages a `delete` op (it keys off
 *     `NEW.deleted_at IS NOT NULL`, schema.ts v26), so peers tombstone too.
 *   - Because the row survives, drainPending's normal delete branch stamps it
 *     in place — no tombstone-SHELL reconstruction needed (that hack existed
 *     ONLY to compensate for the old physical DELETE leaving no local row), and
 *     the staleness guard has a real row+hlc to compare a stale peer put against.
 *   - The .md file MUST still be removed by callers, and the file-watcher records
 *     the id in a short-lived "recently deleted" set so a peer that re-materialises
 *     the orphan file on disk can't re-import it. See file-watcher.ts
 *     suppressNextChange() (backed by suppressedNoteIds).
 *
 * Idempotent: re-deleting an already-tombstoned note is a no-op. The
 * `deleted_at IS NULL` guard means a retry touches zero rows, so the original
 * `deleted_at`, `updated_at`, and `version` are all left intact and the
 * tombstone HLC/time never churns.
 */
export function deleteNote(db: Database.Database, id: string) {
  const now = ts();
  db.prepare(
    "UPDATE notes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL",
  ).run(now, now, id);
}

/**
 * List tombstoned (deleted_at set) note rows, so a caller can clean up their
 * orphaned `.md` files. Does NOT delete the rows — a delete arriving via sync
 * KEEPS a tombstone row so the sync staleness guard trips (physically removing
 * it made every peer delete op re-apply and re-stage — the "sent=31 never
 * settles" loop). Live reads filter `deleted_at IS NULL`, so tombstones don't
 * show in the UI. Dashboards are excluded (no .md file).
 */
export function findTombstonedNotes(
  db: Database.Database,
): { id: string; projectId: string; type: string }[] {
  return db
    .prepare("SELECT id, project_id AS projectId, type FROM notes WHERE deleted_at IS NOT NULL")
    .all() as { id: string; projectId: string; type: string }[];
}

/**
 * Find NESTED conflict-copy notes — rows whose id contains the `_conflict_`
 * marker more than once (e.g. `n_conflict_mobile_x_conflict_desktop_y`). These
 * are junk: a conflict copy of a conflict copy, which should never be created
 * (the engine now guards against it). Left behind by an earlier bug where two
 * devices each cloned the other's copy, they piled up and churned as perpetual
 * delete tombstones (the "N pending never settles" storm). A SINGLE `_conflict_`
 * copy is legitimate (awaiting the user's resolution) and is NOT returned.
 *
 * This only IDENTIFIES them — it does not delete. The caller must tombstone them
 * through the sync engine (engine.remove) so the delete propagates with a fresh
 * HLC and BOTH devices converge; a raw physical DELETE here would be re-created
 * on the next sync from the peer's oplog (which still holds the row).
 */
export function findNestedConflictCopies(
  db: Database.Database,
): { id: string; projectId: string; type: string }[] {
  const candidates = db
    .prepare(
      "SELECT id, project_id AS projectId, type FROM notes WHERE deleted_at IS NULL AND id LIKE '%\\_conflict\\_%\\_conflict\\_%' ESCAPE '\\'",
    )
    .all() as { id: string; projectId: string; type: string }[];
  return candidates.filter((r) => (r.id.match(/_conflict_/g)?.length ?? 0) >= 2);
}

/**
 * Fetch a live note by id. Tombstoned rows (`deleted_at` set) are treated as
 * absent — now that desktop soft-deletes (see deleteNote), a raw `SELECT *`
 * would hand a "deleted" note back to callers (MCP append/patch/tag, the disk
 * projector) that would then edit or re-write it, effectively resurrecting it.
 * Excluding tombstones keeps a delete final. `getNoteByIdIncludingTombstoned`
 * exists for the rare caller that must inspect a tombstone.
 */
export function getNoteById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL").get(id);
  return row ? toNote(row as DbRow) : null;
}

/** Fetch a note by id INCLUDING tombstoned rows (deleted_at set). For the few
 *  paths that must read a tombstone (e.g. cleanup / projection bookkeeping). */
export function getNoteByIdIncludingTombstoned(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return row ? toNote(row as DbRow) : null;
}

/**
 * Move a note to a different folder (or root when folder="").
 * Uses a direct SET rather than COALESCE so an empty string is not silently
 * ignored the way a NULL patch.folder would be in updateNote().
 */
export function moveNoteFolder(db: Database.Database, id: string, folder: string) {
  const now = ts();
  db.prepare("UPDATE notes SET folder = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(folder, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as DbRow);
}

/**
 * Move a note to a different project (and its owning workspace).
 * Uses a direct SET rather than updateNote()'s COALESCE list, which has no
 * project_id/workspace_id columns at all — so a project move sent through
 * updateNote() was silently dropped, leaving the row (and its .md file) in the
 * old project and letting a DB refresh / file-watcher re-import / sync reconcile
 * resurface the note where it started. Callers must also move the .md file
 * (delete the old project's copy, write into the new one) — see the
 * db:note:moveToProject IPC handler.
 *
 * The destination workspace is resolved from the target project itself (not
 * trusted from the caller) so the note can never land in a project/workspace
 * mismatch; a missing target project is rejected.
 */
export function moveNoteToProject(db: Database.Database, id: string, projectId: string) {
  const project = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as
    | { workspace_id: string }
    | undefined;
  if (!project) throw new Error(`Target project not found: ${projectId}`);
  const now = ts();
  db.prepare(
    "UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
  ).run(projectId, project.workspace_id, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as DbRow);
}

/**
 * Explicitly clear archived_at for a note (cannot use COALESCE for NULL clears).
 */
export function restoreNote(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE notes SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as DbRow);
}

// ── Lazy note bodies (renderer) ───────────────────────────────────────────────
// The renderer keeps note METADATA for every note but loads bodies on demand
// (open note, template instantiation, AI context…). These helpers serve that:
// summaries carry everything except `content` (the preview excerpt is still
// derived from a bounded prefix), and bodies/search/backlinks are fetched by id.

const summaryColumnsByDb = new WeakMap<Database.Database, string>();

/** SELECT list for notes with the body replaced by the prefix the excerpt needs. */
function noteSummaryColumns(db: Database.Database): string {
  let cols = summaryColumnsByDb.get(db);
  if (!cols) {
    const names = (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
    cols = names
      .map((n) => (n === "content" ? `substr(content, 1, ${EXCERPT_SOURCE_CHARS}) AS content` : `"${n}"`))
      .join(", ");
    summaryColumnsByDb.set(db, cols);
  }
  return cols;
}

/** A note without its body (`content` omitted; `contentText` = preview excerpt). */
export function toNoteSummary(row: DbRow) {
  const { content: _content, ...summary } = toNote(row);
  void _content;
  return summary;
}

/** Every live note as a summary — the renderer snapshot's notes (no bodies). */
export function getNoteSummaries(db: Database.Database) {
  return db
    .prepare(`SELECT ${noteSummaryColumns(db)} FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC`)
    .all()
    .map((row) => toNoteSummary(row as DbRow));
}

/** Note summaries for the given ids that are live (deleted rows omitted). */
export function getNoteSummariesByIds(db: Database.Database, ids: string[]) {
  const out: ReturnType<typeof toNoteSummary>[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT ${noteSummaryColumns(db)} FROM notes WHERE deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as DbRow[];
    for (const r of rows) out.push(toNoteSummary(r));
  }
  return out;
}

export interface NoteBody {
  id: string;
  content: string;
  version: number;
  updatedAt: string;
  /** Body as it was before unseen external changes ("what's new" baseline). */
  previousContent?: string;
  /** When the first unseen change landed (ISO). */
  changedAt?: string;
}

/** Bodies for the given live note ids (missing / deleted ids are omitted). */
export function getNoteBodies(db: Database.Database, ids: string[]): NoteBody[] {
  const out: NoteBody[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT n.id, n.content, n.version, n.updated_at, b.previous_content, b.changed_at
           FROM notes n LEFT JOIN note_change_base b ON b.note_id = n.id
          WHERE n.deleted_at IS NULL AND n.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<{
        id: string; content: string | null; version: number | null; updated_at: string;
        previous_content: string | null; changed_at: string | null;
      }>;
    for (const r of rows) {
      const body: NoteBody = { id: r.id, content: r.content ?? "", version: r.version ?? 0, updatedAt: r.updated_at };
      if (r.previous_content !== null && r.changed_at !== null) {
        body.previousContent = r.previous_content;
        body.changedAt = r.changed_at;
      }
      out.push(body);
    }
  }
  return out;
}

/**
 * Ids of live notes matching `query` with the renderer's search semantics:
 * AND-of-terms, case-insensitive substring over `title + stripped body`
 * (dashboards: title only). Newest first. A cheap SQL prefilter narrows the
 * rows (ASCII terms only — SQLite's lower() is ASCII-only), then every
 * candidate is verified with the exact JS matcher.
 */
export function searchNoteIds(db: Database.Database, query: string, opts: { projectId?: string } = {}): string[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const where: string[] = ["deleted_at IS NULL"];
  const args: unknown[] = [];
  if (opts.projectId) { where.push("project_id = ?"); args.push(opts.projectId); }
  for (const t of terms) {
    if (!/^[\x00-\x7f]*$/.test(t)) continue;
    where.push("(instr(lower(title), ?) > 0 OR instr(lower(content), ?) > 0)");
    args.push(t, t);
  }
  const rows = db
    .prepare(`SELECT id, title, content, type FROM notes WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`)
    .all(...args) as Array<{ id: string; title: string; content: string | null; type: string | null }>;
  return rows
    .filter((r) => matchesQuery(query, `${r.title}\n${r.type === "dashboard" ? "" : stripMarkdown(r.content ?? "")}`))
    .map((r) => r.id);
}

/** Ids of live notes containing a `[[<title of noteId>]]` wikilink (case-insensitive, trimmed). */
export function wikilinkBacklinkIds(db: Database.Database, noteId: string): string[] {
  const target = db.prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string } | undefined;
  if (!target) return [];
  // Same comparison as the renderer scan it replaces: trimmed link text vs the
  // lower-cased title.
  const titleLower = target.title.toLowerCase();
  if (!titleLower.trim()) return [];
  const rows = db
    .prepare(`SELECT id, content FROM notes WHERE deleted_at IS NULL AND id != ? AND instr(content, '[[') > 0`)
    .all(noteId) as Array<{ id: string; content: string | null }>;
  const re = /\[\[([^\][\n]+?)\]\]/g;
  const out: string[] = [];
  for (const r of rows) {
    const content = r.content ?? "";
    // Cheap reject: a match needs the title's text somewhere in the body.
    if (!content.toLowerCase().includes(titleLower.trim())) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1].trim().toLowerCase() === titleLower) { out.push(r.id); break; }
    }
  }
  return out;
}

// ── "What's new" baselines (note_change_base, schema v57) ─────────────────────

/** Highest baseline rowid — taken before an own write so its rows can be discarded. */
export function noteChangeBaseHead(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM note_change_base").get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Drop baselines created after `rowid` (the user's own edit isn't news). */
export function discardNoteChangeBasesSince(db: Database.Database, rowid: number): void {
  db.prepare("DELETE FROM note_change_base WHERE rowid > ?").run(rowid);
}

/** The user has seen the note's current body. */
export function clearNoteChangeBase(db: Database.Database, noteId: string): void {
  db.prepare("DELETE FROM note_change_base WHERE note_id = ?").run(noteId);
}

/** Housekeeping: forget baselines for deleted notes and ones older than `maxAgeDays`. */
export function pruneNoteChangeBases(db: Database.Database, maxAgeDays = 30): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const res = db
    .prepare(
      `DELETE FROM note_change_base
        WHERE changed_at < ?
           OR note_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL)`,
    )
    .run(cutoff) as { changes: number };
  return res.changes;
}
