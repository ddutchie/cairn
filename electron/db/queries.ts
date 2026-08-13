/**
 * Cairn — SQLite query helpers (single source of truth for all SQL).
 *
 * All reads return TypeScript domain types (from src/types/index.ts).
 * JSON columns are parsed on read and serialised on write.
 *
 * Naming: snake_case columns → camelCase fields in returned objects.
 *
 * ── Governance ──────────────────────────────────────────────────────────────
 * This module is imported by BOTH the Electron main process and the esbuild-
 * bundled MCP server (see `electron/mcp/tools/codebase.ts`, `tags.ts`,
 * `projects.ts`, `notes.ts`, `tasks.ts`, `flow.ts`, `dashboards.ts`, `graph.ts`,
 * and `electron/mcp/db.ts`). It is safe to import from `mcp/tools/*` because the
 * only ABI-sensitive operation in better-sqlite3 is constructing the `Database`
 * instance — that happens once in `electron/mcp-server.ts:140`
 * (`new Database(dbPath, { nativeBinding: MCP_NATIVE_BINDING })`). All
 * `db.prepare(...).run(...)` calls here execute on that already-constructed
 * handle regardless of which TS file defines them.
 *
 * **Never** construct a `Database` instance in this file. The two bootstrap
 * sites are `electron/db/client.ts` (Electron ABI, `electron-native/<arch>/`)
 * and `electron/mcp-server.ts` (pkg Node 24 ABI, `pkg-native/<arch>/`). The
 * standalone `cairn-mcp` binary must run independently of the app (so agents
 * can read/write the workspace while Cairn is closed), which is why it ships
 * its own Node-ABI sqlite binary separate from the Electron one.
 *
 * For knowledge-graph traversal, see `electron/db/graph-queries.ts` which
 * exports `getKnowledgeGraph` and `getNeighbours` (also safe to import from
 * `mcp/tools/*` — see `electron/mcp/tools/graph.ts`).
 */

import type Database from "better-sqlite3";
import { ts, newId } from "./utils";
import {
  j,
  p,
  toWorkspace,
  toProject,
  toCodingAgent,
  toMcpServer,
  toCustomService,
  toToolAttachment,
  toNote,
  toColumn,
  toCard,
  toTag,
  toSlashCommand,
  toChatThread,
  toChatMessage,
  toMcpNotification,
  toIdeaFlow,
  toIdeaFlowNode,
  toIdeaFlowEdge,
  type McpNotification
} from "../shared/db-mappers";
import { normalizeNoteTitle, stripMarkdown } from "../shared/text-utils";
import { ftsMatchQuery } from "../../shared/notes/text";

/** Re-export for callers that only need a new ID without importing utils directly. */
export { newId as generateId };

// ── Workspace ─────────────────────────────────

export function getAllWorkspaces(db: Database.Database) {
  return db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace);
}

export function createWorkspace(db: Database.Database, ws: { id: string; name: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    INSERT INTO workspaces (id, name, description, icon, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ws.id, ws.name, ws.description ?? null, ws.icon ?? null, now, now);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ws.id));
}

export function updateWorkspace(db: Database.Database, id: string, patch: { name?: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description),
    icon = COALESCE(?, icon), updated_at = ? WHERE id = ?
  `).run(patch.name ?? null, patch.description ?? null, patch.icon ?? null, now, id);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id));
}

// ── Projects ──────────────────────────────────

export function getProjects(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at").all(workspaceId)
    : db.prepare("SELECT * FROM projects ORDER BY created_at").all();
  return rows.map(toProject);
}

export function createProject(db: Database.Database, p: {
  id: string; workspaceId: string; name: string;
  description?: string; icon?: string; status?: string; priority?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO projects (id, workspace_id, name, description, icon, status, priority, tag_ids, project_settings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?)
  `).run(p.id, p.workspaceId, p.name, p.description ?? null, p.icon ?? null,
         p.status ?? "active", p.priority ?? "medium", now, now);
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id));
}

export function updateProject(db: Database.Database, id: string, patch: Partial<{
  name: string; description: string; icon: string; status: string;
  priority: string; dueDate: string; tagIds: string[]; archivedAt: string;
  codeDirectory: string | null;
}>) {
  const now = ts();
  // codeDirectory is nullable — use a sentinel to distinguish "not provided" from "set to null"
  const hasCodeDir = Object.prototype.hasOwnProperty.call(patch, "codeDirectory");
  db.prepare(`
    UPDATE projects SET
      name           = COALESCE(?, name),
      description    = COALESCE(?, description),
      icon           = COALESCE(?, icon),
      status         = COALESCE(?, status),
      priority       = COALESCE(?, priority),
      due_date       = COALESCE(?, due_date),
      tag_ids        = COALESCE(?, tag_ids),
      archived_at    = COALESCE(?, archived_at),
      code_directory = ${hasCodeDir ? "?" : "code_directory"},
      updated_at     = ?
    WHERE id = ?
  `).run(
    patch.name ?? null, patch.description ?? null, patch.icon ?? null,
    patch.status ?? null, patch.priority ?? null, patch.dueDate ?? null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.archivedAt ?? null,
    ...(hasCodeDir ? [patch.codeDirectory ?? null] : []),
    now, id,
  );
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

export function deleteProject(db: Database.Database, id: string) {
  // Cascade: delete cards, columns, notes (caller deletes .md files first)
  db.prepare("DELETE FROM task_cards WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM notes WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function getProjectById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? toProject(row) : null;
}

/** A note that was repointed by mergeProject — the IPC layer uses this to
 *  relocate the .md file from the source folder into the destination folder. */
export interface MergedNoteMove {
  id: string;
  type: string;
  folder: string;
}

export interface MergeProjectResult {
  /** Notes repointed from source → target (for .md relocation by the caller). */
  movedNotes: MergedNoteMove[];
  /** Source project name (for locating/removing its on-disk notes folder). */
  sourceName: string;
  /** Target project name (destination folder). */
  targetName: string;
  counts: { notes: number; cards: number; columns: number; flowNodes: number };
}

/**
 * Merge every entity owned by `sourceId` into `targetId`, then delete the now
 * empty source project. Runs entirely in one transaction so it is all-or-nothing.
 *
 * Why this exists: a project's SQLite id is a random nanoid (so two projects can
 * share a name), but notes are written to disk under a folder keyed by the
 * project NAME slug — so two same-named projects collide on disk. Rather than a
 * one-off repair script, this consolidates two projects into one from the UI.
 *
 * What it repoints (source → target), each via direct SET so project_id /
 * workspace_id actually persist (updateCard/updateNote COALESCE lists omit those
 * columns and would silently drop the change):
 *   - notes          → target project + target workspace
 *   - board_columns  → standard columns (backlog/todo/…): cards move into the
 *                      target's column of the SAME type; the source column is
 *                      dropped. Custom columns are re-created in the target
 *                      (preserving name/order) and their cards follow.
 *   - task_cards     → target project + workspace + remapped column_id
 *   - idea_flow      → source flow's nodes/edges are moved into the target's flow
 *   - chat_threads   → repointed (no FK, so a bare project delete would orphan them)
 *   - tool_attachments, pi_agent_sessions → repointed
 *
 * Returns the moved notes so the caller can relocate their .md files (the DB
 * move alone leaves the files under the old project's folder).
 */
export function mergeProject(db: Database.Database, sourceId: string, targetId: string): MergeProjectResult {
  if (sourceId === targetId) throw new Error("Cannot merge a project into itself");
  const source = getProjectById(db, sourceId);
  const target = getProjectById(db, targetId);
  if (!source) throw new Error(`Source project not found: ${sourceId}`);
  if (!target) throw new Error(`Target project not found: ${targetId}`);

  const now = ts();
  const targetWs = target.workspaceId;

  return db.transaction((): MergeProjectResult => {
    // ── 1. Board columns + cards ──────────────────────────────────────────
    // Build the target's column map by type. Standard types are unique per
    // board; for a card in a source column we find the target column of the
    // same type. Custom source columns have no canonical target, so recreate
    // them in the target and route their cards there.
    const targetCols = db.prepare(
      `SELECT id, type, name, "order" FROM board_columns WHERE project_id = ?`,
    ).all(targetId) as { id: string; type: string; name: string; order: number }[];

    const targetByType = new Map<string, string>(); // type → columnId (standard only)
    let maxOrder = -1;
    for (const c of targetCols) {
      if (c.type !== "custom") targetByType.set(c.type, c.id);
      if (c.order > maxOrder) maxOrder = c.order;
    }
    const fallbackColId = targetByType.get("backlog") ?? targetCols[0]?.id ?? null;

    const sourceCols = db.prepare(
      `SELECT id, type, name, "order" FROM board_columns WHERE project_id = ? ORDER BY "order"`,
    ).all(sourceId) as { id: string; type: string; name: string; order: number }[];

    // Map each SOURCE column id → the TARGET column id its cards should land in.
    const colRemap = new Map<string, string>();
    for (const sc of sourceCols) {
      if (sc.type !== "custom") {
        const dest = targetByType.get(sc.type) ?? fallbackColId;
        if (dest) colRemap.set(sc.id, dest);
      } else {
        // Recreate the custom column in the target (append after existing ones).
        const newColId = newId();
        maxOrder += 1;
        db.prepare(
          `INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", card_limit, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'custom', ?, NULL, ?, ?)`,
        ).run(newColId, targetId, targetWs, sc.name, maxOrder, now, now);
        colRemap.set(sc.id, newColId);
      }
    }

    // Repoint every source card to the target project/workspace and its remapped
    // column. Append cards to the end of their destination column (recompute
    // order as current live count) so nothing overlaps.
    const sourceCards = db.prepare(
      "SELECT id, column_id FROM task_cards WHERE project_id = ?",
    ).all(sourceId) as { id: string; column_id: string }[];
    let cardCount = 0;
    for (const card of sourceCards) {
      const destCol = colRemap.get(card.column_id) ?? fallbackColId;
      if (!destCol) continue; // target has no columns at all — should never happen
      const orderRow = db.prepare(
        "SELECT COUNT(*) AS n FROM task_cards WHERE column_id = ? AND archived_at IS NULL",
      ).get(destCol) as { n: number };
      db.prepare(
        `UPDATE task_cards SET project_id = ?, workspace_id = ?, column_id = ?, "order" = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(targetId, targetWs, destCol, orderRow.n, now, card.id);
      cardCount += 1;
    }
    // Drop the source project's (now card-less) columns.
    db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(sourceId);

    // ── 2. Notes ──────────────────────────────────────────────────────────
    const movedNotes = db.prepare(
      "SELECT id, type, folder FROM notes WHERE project_id = ? AND deleted_at IS NULL",
    ).all(sourceId) as MergedNoteMove[];
    db.prepare(
      "UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ?, version = version + 1 WHERE project_id = ?",
    ).run(targetId, targetWs, now, sourceId);

    // ── 3. Idea flow: move source flow's nodes/edges into the target flow ──
    let flowNodeCount = 0;
    const sourceFlow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(sourceId) as
      | { id: string } | undefined;
    if (sourceFlow) {
      const targetFlow = getOrCreateFlow(db, targetId);
      const nodeCountRow = db.prepare(
        "SELECT COUNT(*) AS n FROM idea_flow_nodes WHERE flow_id = ?",
      ).get(sourceFlow.id) as { n: number };
      flowNodeCount = nodeCountRow.n;
      db.prepare("UPDATE idea_flow_nodes SET flow_id = ? WHERE flow_id = ?").run(targetFlow.id, sourceFlow.id);
      db.prepare("UPDATE idea_flow_edges SET flow_id = ? WHERE flow_id = ?").run(targetFlow.id, sourceFlow.id);
      db.prepare("DELETE FROM idea_flows WHERE id = ?").run(sourceFlow.id);
    }

    // ── 4. FK-less / satellite tables that a bare project delete would orphan ─
    db.prepare("UPDATE chat_threads SET project_id = ? WHERE project_id = ?").run(targetId, sourceId);
    // tool_attachments PK is (project_id, tool_type, tool_id) — a plain repoint
    // could collide if both projects attached the same tool. INSERT OR IGNORE the
    // target rows, then clear the source's.
    db.prepare(
      `INSERT OR IGNORE INTO tool_attachments (project_id, tool_type, tool_id, enabled)
       SELECT ?, tool_type, tool_id, enabled FROM tool_attachments WHERE project_id = ?`,
    ).run(targetId, sourceId);
    db.prepare("DELETE FROM tool_attachments WHERE project_id = ?").run(sourceId);
    db.prepare("UPDATE pi_agent_sessions SET project_id = ? WHERE project_id = ?").run(targetId, sourceId);

    // ── 5. Delete the emptied source project ──────────────────────────────
    // Everything owned by it has been repointed; a direct row delete (rather
    // than deleteProject's cascade) avoids nuking the notes/cards we just moved.
    db.prepare("DELETE FROM projects WHERE id = ?").run(sourceId);

    return {
      movedNotes,
      sourceName: source.name,
      targetName: target.name,
      counts: { notes: movedNotes.length, cards: cardCount, columns: sourceCols.length, flowNodes: flowNodeCount },
    };
  })();
}

export function updateProjectSettings(db: Database.Database, projectId: string, patch: Record<string, unknown>) {
  const row = db.prepare("SELECT project_settings FROM projects WHERE id = ?").get(projectId) as { project_settings: string } | undefined;
  if (!row) return null;
  const existing: Record<string, unknown> = (() => {
    try { return JSON.parse(row.project_settings); } catch { return {}; }
  })();
  const merged = { ...existing, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === null || patch[key] === undefined) {
      delete merged[key];
    }
  }
  const now = ts();
  db.prepare("UPDATE projects SET project_settings = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(merged), now, projectId,
  );
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId));
}

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
  return rows.map(toNote);
}

/**
 * Find a live (non-archived, non-deleted) note in a project whose title matches
 * `title` under the same normalization ensure_note uses (trim + collapse inner
 * whitespace, case-sensitive). Returns the note or undefined.
 *
 * This is the AUTHORITATIVE existence check for ensure_note — it reads the live
 * DB rather than a pre-call snapshot, so it stays correct when two ensure_note
 * calls for the same title run in the same agent turn (the pi-agent-loop fires a
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
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(n.id));
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
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
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
  return row ? toNote(row) : null;
}

/** Fetch a note by id INCLUDING tombstoned rows (deleted_at set). For the few
 *  paths that must read a tombstone (e.g. cleanup / projection bookkeeping). */
export function getNoteByIdIncludingTombstoned(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return row ? toNote(row) : null;
}

/**
 * Move a note to a different folder (or root when folder="").
 * Uses a direct SET rather than COALESCE so an empty string is not silently
 * ignored the way a NULL patch.folder would be in updateNote().
 */
export function moveNoteFolder(db: Database.Database, id: string, folder: string) {
  const now = ts();
  db.prepare("UPDATE notes SET folder = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(folder, now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
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
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

/**
 * Explicitly clear archived_at for a note (cannot use COALESCE for NULL clears).
 */
export function restoreNote(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE notes SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
}

// ── Board Columns ─────────────────────────────

export function getColumns(db: Database.Database, projectId?: string) {
  const rows = projectId
    ? db.prepare(`SELECT * FROM board_columns WHERE project_id = ? ORDER BY "order"`).all(projectId)
    : db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all();
  return rows.map(toColumn);
}

export function createColumn(db: Database.Database, c: {
  id: string; projectId: string; workspaceId: string;
  name: string; type?: string; order?: number;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.projectId, c.workspaceId, c.name, c.type ?? "custom", c.order ?? 0, now, now);
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(c.id));
}

export function updateColumn(db: Database.Database, id: string, patch: Partial<{ name: string; order: number; cardLimit: number }>) {
  const now = ts();
  db.prepare(`
    UPDATE board_columns SET
      name       = COALESCE(?, name),
      "order"    = COALESCE(?, "order"),
      card_limit = COALESCE(?, card_limit),
      updated_at = ?
    WHERE id = ?
  `).run(patch.name ?? null, patch.order ?? null, patch.cardLimit ?? null, now, id);
  return toColumn(db.prepare("SELECT * FROM board_columns WHERE id = ?").get(id));
}

export function deleteColumn(db: Database.Database, id: string) {
  db.prepare("DELETE FROM task_cards WHERE column_id = ?").run(id);
  db.prepare("DELETE FROM board_columns WHERE id = ?").run(id);
}

// ── Task Cards ────────────────────────────────

export function getCards(db: Database.Database, opts?: { projectId?: string; columnId?: string }) {
  // Filter tombstones (deleted_at) — a card deleted on a peer keeps a tombstone
  // row so sync converges; it must not show on the board. (Same rationale as
  // getNotes.)
  let rows;
  if (opts?.columnId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE column_id = ? AND deleted_at IS NULL ORDER BY "order"`).all(opts.columnId);
  } else if (opts?.projectId) {
    rows = db.prepare(`SELECT * FROM task_cards WHERE project_id = ? AND deleted_at IS NULL ORDER BY "order"`).all(opts.projectId);
  } else {
    rows = db.prepare(`SELECT * FROM task_cards WHERE deleted_at IS NULL ORDER BY "order"`).all();
  }
  return rows.map(toCard);
}

export function createCard(db: Database.Database, c: {
  id: string; columnId: string; projectId: string; workspaceId: string;
  title: string; description?: string; priority?: string; dueDate?: string;
  order?: number; tagIds?: string[]; assignee?: string;
}) {
  const now = ts();
  const tagIds = JSON.stringify(c.tagIds ?? []);
  db.prepare(`
    INSERT INTO task_cards
      (id, column_id, project_id, workspace_id, title, description, tag_ids,
       priority, due_date, linked_note_ids, blocked_by_ids, "order", assignee, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)
  `).run(c.id, c.columnId, c.projectId, c.workspaceId, c.title,
         c.description ?? null, tagIds, c.priority ?? "medium", c.dueDate ?? null,
         c.order ?? 0, c.assignee ?? null, now, now);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(c.id));
}

export function updateCard(db: Database.Database, id: string, patch: Partial<{
  columnId: string; title: string; description: string; priority: string;
  dueDate: string; tagIds: string[]; linkedNoteIds: string[]; blockedByIds: string[];
  order: number; assignee: string | null; archivedAt: string;
}>) {
  const now = ts();
  // assignee uses CASE WHEN instead of COALESCE so it can be explicitly cleared to NULL.
  // Pass (1, null) when explicitly setting assignee; pass (0, null) when not touching it.
  const assigneeSentinel = "assignee" in patch ? 1 : 0;
  const assigneeValue    = "assignee" in patch ? (patch.assignee || null) : null;
  db.prepare(`
    UPDATE task_cards SET
      column_id       = COALESCE(?, column_id),
      title           = COALESCE(?, title),
      description     = COALESCE(?, description),
      priority        = COALESCE(?, priority),
      due_date        = COALESCE(?, due_date),
      tag_ids         = COALESCE(?, tag_ids),
      linked_note_ids = COALESCE(?, linked_note_ids),
      blocked_by_ids  = COALESCE(?, blocked_by_ids),
      "order"         = COALESCE(?, "order"),
      assignee        = CASE WHEN ? = 1 THEN ? ELSE assignee END,
      archived_at     = COALESCE(?, archived_at),
      updated_at      = ?,
      version         = version + 1
    WHERE id = ?
  `).run(
    patch.columnId ?? null, patch.title ?? null, patch.description ?? null,
    patch.priority ?? null, patch.dueDate ?? null,
    patch.tagIds ? j(patch.tagIds) : null,
    patch.linkedNoteIds ? j(patch.linkedNoteIds) : null,
    patch.blockedByIds ? j(patch.blockedByIds) : null,
    patch.order ?? null,
    assigneeSentinel, assigneeValue,
    patch.archivedAt ?? null,
    now, id,
  );
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Move a card to a different project (and its owning workspace), landing it in a
 * specific column of that project.
 *
 * Like moveNoteToProject, this uses a direct SET rather than updateCard()'s
 * COALESCE list, which has no project_id/workspace_id columns — so routing a
 * cross-project move through updateCard() silently dropped the project change,
 * leaving the row with a column_id in the new project but project_id still in
 * the old one. On the next board refresh / sync reconcile (both scope by
 * project_id) the card resurfaced in the source project.
 *
 * The destination workspace is resolved from the target project itself (not
 * trusted from the caller); the target column must belong to the target project.
 */
export function moveCardToProject(
  db: Database.Database,
  id: string,
  projectId: string,
  columnId: string,
  order: number,
) {
  const project = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as
    | { workspace_id: string }
    | undefined;
  if (!project) throw new Error(`Target project not found: ${projectId}`);
  const column = db.prepare("SELECT project_id FROM board_columns WHERE id = ?").get(columnId) as
    | { project_id: string }
    | undefined;
  if (!column) throw new Error(`Target column not found: ${columnId}`);
  if (column.project_id !== projectId) {
    throw new Error(`Target column ${columnId} does not belong to project ${projectId}`);
  }
  const now = ts();
  db.prepare(
    `UPDATE task_cards SET project_id = ?, workspace_id = ?, column_id = ?, "order" = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(projectId, project.workspace_id, columnId, order, now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

export function deleteCard(db: Database.Database, id: string) {
  // Remove this card from any other card's blocked_by_ids before deleting
  const affected = db.prepare(
    "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
  ).all(id) as { id: string; blocked_by_ids: string }[];
  const now = ts();
  for (const row of affected) {
    const ids = p(row.blocked_by_ids) as string[];
    if (ids.includes(id)) {
      const updated = ids.filter((bid) => bid !== id);
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(j(updated), now, row.id);
    }
  }
  db.prepare("DELETE FROM task_cards WHERE id = ?").run(id);
}

export function getCardById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id);
  return row ? toCard(row) : null;
}

/**
 * Explicitly clear archived_at for a card (cannot use COALESCE for NULL clears).
 */
export function restoreCard(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Explicitly clear due_date for a card.
 */
export function clearCardDueDate(db: Database.Database, id: string) {
  const now = ts();
  db.prepare("UPDATE task_cards SET due_date = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, id);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(id));
}

/**
 * Add a blocker to a card's blocked_by_ids. Caller must verify no circular dep first.
 */
export function addCardBlocker(db: Database.Database, cardId: string, blockerCardId: string) {
  const now = ts();
  const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
  if (!row) throw new Error(`Card ${cardId} not found`);
  const ids = p(row.blocked_by_ids) as string[];
  if (!ids.includes(blockerCardId)) {
    ids.push(blockerCardId);
    db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), now, cardId);
  }
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId));
}

/**
 * Remove a blocker from a card's blocked_by_ids.
 */
export function removeCardBlocker(db: Database.Database, cardId: string, blockerCardId: string) {
  const now = ts();
  const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(cardId) as { blocked_by_ids: string } | undefined;
  if (!row) throw new Error(`Card ${cardId} not found`);
  const ids = (p(row.blocked_by_ids) as string[]).filter((id) => id !== blockerCardId);
  db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), now, cardId);
  return toCard(db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId));
}

/**
 * When a card (or a set of cards) moves to a done column, remove those card IDs
 * from every other task's blocked_by_ids so get_task no longer reports them as
 * pending blockers.
 */
export function clearBlockersFromAll(db: Database.Database, doneCardIds: string[]) {
  if (doneCardIds.length === 0) return;
  const now = ts();
  const affected = db.prepare(
    "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]'"
  ).all() as { id: string; blocked_by_ids: string }[];
  for (const row of affected) {
    if (doneCardIds.includes(row.id)) continue; // skip the tasks we just moved
    const ids = p(row.blocked_by_ids) as string[];
    const cleaned = ids.filter((bid) => !doneCardIds.includes(bid));
    if (cleaned.length !== ids.length) {
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(j(cleaned), now, row.id);
    }
  }
}

/**
 * Return active, non-done cards that have no pending blockers.
 * A card is "ready" when:
 *   - Not archived
 *   - Not in a column with type = 'done'
 *   - Every entry in blocked_by_ids refers to a card that is archived OR in a done column
 */
export function getReadyCards(db: Database.Database, projectId?: string) {
  const whereProject = projectId ? "AND tc.project_id = ?" : "";
  const params: string[] = projectId ? [projectId] : [];

  // All active non-done cards
  const candidates = db.prepare(`
    SELECT tc.* FROM task_cards tc
    JOIN board_columns bc ON tc.column_id = bc.id
    WHERE tc.archived_at IS NULL
      AND bc.type != 'done'
      ${whereProject}
    ORDER BY tc."order"
  `).all(...params).map(toCard);

  if (candidates.length === 0) return [];

  // Build a lookup of all project cards for blocker resolution
  const allProjectIds = [...new Set(candidates.map((c) => c.projectId))];
  const allCards = allProjectIds.flatMap((pid) =>
    (db.prepare(`
      SELECT tc.*, bc.type as col_type FROM task_cards tc
      JOIN board_columns bc ON tc.column_id = bc.id
      WHERE tc.project_id = ?
    `).all(pid) as Array<{ id: string; archived_at: string | null; col_type: string }>)
  );
  const cardMap = new Map(allCards.map((c) => [c.id, c]));

  function isResolved(blockerId: string): boolean {
    const blocker = cardMap.get(blockerId);
    if (!blocker) return true; // orphaned blocker → treat as resolved
    return blocker.archived_at !== null || blocker.col_type === "done";
  }

  return candidates.filter((card) =>
    card.blockedByIds.length === 0 || card.blockedByIds.every(isResolved)
  );
}

// ── Tags ──────────────────────────────────────

export function getTags(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM tags WHERE workspace_id = ?").all(workspaceId)
    : db.prepare("SELECT * FROM tags").all();
  return rows.map(toTag);
}

export function createTag(db: Database.Database, t: { id: string; workspaceId: string; name: string; color: string }) {
  db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run(t.id, t.workspaceId, t.name, t.color);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(t.id));
}

export function updateTag(db: Database.Database, id: string, patch: { name?: string; color?: string }) {
  db.prepare("UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?")
    .run(patch.name ?? null, patch.color ?? null, id);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(id));
}

export function deleteTag(db: Database.Database, id: string) {
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
}

// ── Slash commands ────────────────────────────

export function getSlashCommands(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM slash_commands WHERE workspace_id = ? ORDER BY name").all(workspaceId)
    : db.prepare("SELECT * FROM slash_commands ORDER BY name").all();
  return rows.map(toSlashCommand);
}

export function createSlashCommand(db: Database.Database, c: {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  insertText?: string;
  scope?: string;
  source?: string;
  communityId?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO slash_commands
      (id, workspace_id, name, description, insert_text, scope, source, community_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.id,
    c.workspaceId,
    c.name,
    c.description ?? "",
    c.insertText ?? "",
    c.scope ?? "both",
    c.source ?? "custom",
    c.communityId ?? null,
    now,
    now
  );
  return toSlashCommand(db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(c.id));
}

export function updateSlashCommand(db: Database.Database, id: string, patch: {
  name?: string;
  description?: string;
  insertText?: string;
  scope?: string;
}) {
  const now = ts();
  db.prepare(`
    UPDATE slash_commands SET
      name        = COALESCE(?, name),
      description = COALESCE(?, description),
      insert_text = COALESCE(?, insert_text),
      scope       = COALESCE(?, scope),
      updated_at  = ?
    WHERE id = ?
  `).run(
    patch.name ?? null,
    patch.description ?? null,
    patch.insertText ?? null,
    patch.scope ?? null,
    now,
    id
  );
  return toSlashCommand(db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(id));
}

export function deleteSlashCommand(db: Database.Database, id: string) {
  db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id);
}

// ── Chat ──────────────────────────────────────

export function getChatThreads(db: Database.Database, workspaceId: string) {
  return db.prepare("SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId).map(toChatThread);
}

export function upsertChatThread(db: Database.Database, t: {
  id: string; scope: string; workspaceId: string; projectId?: string; title?: string; useSubagents?: boolean;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_threads (id, scope, workspace_id, project_id, title, use_subagents, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, use_subagents = excluded.use_subagents, updated_at = excluded.updated_at
  `).run(t.id, t.scope, t.workspaceId, t.projectId ?? null, t.title ?? null, t.useSubagents ? 1 : 0, now, now);
  return toChatThread(db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(t.id));
}

export function deleteChatThread(db: Database.Database, threadId: string) {
  db.prepare("DELETE FROM chat_messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
}

export function getChatMessages(db: Database.Database, threadId: string) {
  return db.prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at").all(threadId).map(toChatMessage);
}

export function addChatMessage(db: Database.Database, m: {
  id: string; threadId: string; role: string; content: string; contextRefs?: unknown; toolCalls?: unknown; reasoning?: string; reasoningSummary?: string; subagents?: unknown; reasoningItems?: unknown; reasoningField?: string; reasoningModel?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, role, content, context_refs, tool_calls, reasoning, reasoning_summary, reasoning_items, reasoning_field, reasoning_model, subagents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.id, m.threadId, m.role, m.content, m.contextRefs ? JSON.stringify(m.contextRefs) : null, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.reasoning ?? null, m.reasoningSummary ?? null, m.reasoningItems ? JSON.stringify(m.reasoningItems) : null, m.reasoningField ?? null, m.reasoningModel ?? null, m.subagents ? JSON.stringify(m.subagents) : null, now);
  return toChatMessage(db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(m.id));
}

// ── MCP Notifications ─────────────────────────

export function getUnreadMcpNotifications(db: Database.Database): McpNotification[] {
  return db.prepare("SELECT * FROM mcp_notifications WHERE read = 0 ORDER BY created_at ASC").all().map(toMcpNotification);
}

/** Recent notifications (read + unread), newest first. */
export function listMcpNotifications(db: Database.Database, limit = 100): McpNotification[] {
  return db
    .prepare("SELECT * FROM mcp_notifications ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit)
    .map(toMcpNotification);
}

export function countUnreadMcpNotifications(db: Database.Database): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM mcp_notifications WHERE read = 0").get() as { n: number };
  return r.n;
}

export function markMcpNotificationRead(db: Database.Database, id: string): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE id = ?").run(id);
}

export function markMcpNotificationsRead(db: Database.Database): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE read = 0").run();
}

/** Remove every notification (manual "Clear all"). Returns rows deleted. */
export function clearMcpNotifications(db: Database.Database): number {
  const info = db.prepare("DELETE FROM mcp_notifications").run();
  return info.changes;
}

/**
 * Retention/pruning for mcp_notifications: delete notifications older than
 * `maxAgeDays`, then cap the table to the newest `maxRows`. Returns the number
 * of rows deleted. Notifications are transient activity (toasts/inbox), so they
 * don't need indefinite retention.
 */
export function pruneMcpNotifications(db: Database.Database, opts: { maxAgeDays?: number; maxRows?: number } = {}): number {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const maxRows = opts.maxRows ?? 1000;
  const cutoffIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const prune = db.transaction((cutoff: string, cap: number) => {
    const ageInfo = db.prepare("DELETE FROM mcp_notifications WHERE created_at < ?").run(cutoff);
    const capInfo = db.prepare(`
      DELETE FROM mcp_notifications
      WHERE id NOT IN (
        SELECT id FROM mcp_notifications ORDER BY created_at DESC, rowid DESC LIMIT ?
      )
    `).run(cap);
    return ageInfo.changes + capInfo.changes;
  });
  return prune(cutoffIso, maxRows);
}

/**
 * Returns the set of note IDs currently being written by the MCP server process.
 * Used by mcp-poller to diff against the previous poll and fire aiWriteStarted/Ended events.
 * Returns an empty set if the table doesn't exist yet (e.g. pre-v11 DB).
 */
export function getActiveMcpWrites(db: Database.Database): Set<string> {
  try {
    const rows = db.prepare("SELECT note_id FROM mcp_active_writes").all() as { note_id: string }[];
    return new Set(rows.map((r) => r.note_id));
  } catch {
    return new Set();
  }
}

export function insertMcpNotification(db: Database.Database, n: { id: string; tool: string; title: string; body: string; targetType?: "note" | "task"; targetId?: string }): void {
  db.prepare("INSERT INTO mcp_notifications (id, tool, title, body, read, created_at, target_type, target_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(n.id, n.tool, n.title, n.body, ts(), n.targetType ?? null, n.targetId ?? null);
}

// ── Idea Flow ─────────────────────────────────

/** Get or lazily create the single IdeaFlow for a project. */
export function getOrCreateFlow(db: Database.Database, projectId: string) {
  const existing = db.prepare("SELECT * FROM idea_flows WHERE project_id = ?").get(projectId);
  if (existing) return toIdeaFlow(existing);
  const now = ts();
  const id = newId();
  db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, projectId, now, now);
  return toIdeaFlow(db.prepare("SELECT * FROM idea_flows WHERE id = ?").get(id));
}

export function getFlowNodes(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map(toIdeaFlowNode);
}

export function getFlowEdges(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map(toIdeaFlowEdge);
}

export function createFlowNode(db: Database.Database, n: {
  id: string; flowId: string; type: string;
  x: number; y: number; width?: number; height?: number;
  parentId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(n.id, n.flowId, n.type, n.x, n.y, n.width ?? null, n.height ?? null, n.parentId ?? null, JSON.stringify(n.data), now, now);
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(n.id));
}

export function updateFlowNode(db: Database.Database, id: string, patch: Partial<{
  x: number; y: number; width: number; height: number;
  parentId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}>) {
  const now = ts();
  const existing = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(id);
  if (!existing) throw new Error(`Flow node not found: ${id}`);
  const node = toIdeaFlowNode(existing);
  const newData = patch.data !== undefined
    ? JSON.stringify({ ...node.data, ...patch.data })
    : JSON.stringify(node.data);

  // parentId: null means explicitly clear it; undefined means don't touch it
  const parentIdValue = patch.parentId === null ? null
    : patch.parentId !== undefined ? patch.parentId
    : node.parentId ?? null;

  db.prepare(`
    UPDATE idea_flow_nodes SET
      x          = COALESCE(?, x),
      y          = COALESCE(?, y),
      width      = COALESCE(?, width),
      height     = COALESCE(?, height),
      parent_id  = ?,
      data       = ?,
      updated_at = ?
    WHERE id = ?
  `).run(patch.x ?? null, patch.y ?? null, patch.width ?? null, patch.height ?? null, parentIdValue, newData, now, id);
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(id));
}

export function deleteFlowNode(db: Database.Database, id: string) {
  // Edges referencing this node are cascade-deleted via FK
  db.prepare("DELETE FROM idea_flow_nodes WHERE id = ?").run(id);
}

export function createFlowEdge(db: Database.Database, e: {
  id: string; flowId: string; sourceNodeId: string; targetNodeId: string; label?: string;
}) {
  const now = ts();
  db.prepare(`
    INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.id, e.flowId, e.sourceNodeId, e.targetNodeId, e.label ?? null, now);
  return toIdeaFlowEdge(db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(e.id));
}

export function deleteFlowEdge(db: Database.Database, id: string) {
  db.prepare("DELETE FROM idea_flow_edges WHERE id = ?").run(id);
}

/**
 * Returns the full resolved graph for a project — ready for the renderer and AI/MCP.
 * note_ref and task_ref nodes have their linked entity's data merged in as resolved* fields.
 */
export function getResolvedFlow(db: Database.Database, projectId: string) {
  const flow = getOrCreateFlow(db, projectId);
  const nodes = getFlowNodes(db, flow.id);
  const edges = getFlowEdges(db, flow.id);

  // Build a map of group positions for absolute coord computation
  const groupPositions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (n.type === "group") groupPositions.set(n.id, { x: n.x, y: n.y });
  }

  const resolved = nodes.map((node) => {
    // Compute absolute position — children store relative coords in DB
    const parent = node.parentId ? groupPositions.get(node.parentId) : undefined;
    const absoluteX = parent ? parent.x + node.x : node.x;
    const absoluteY = parent ? parent.y + node.y : node.y;

    let base = { ...node, absoluteX, absoluteY };

    if (node.type === "note_ref" && node.data.noteId) {
      const noteRow = db.prepare("SELECT id, title, content FROM notes WHERE id = ?").get(node.data.noteId) as
        | { id: string; title: string; content: string } | undefined;
      if (noteRow) {
        base = { ...base, resolvedTitle: noteRow.title, resolvedSnippet: stripMarkdown(noteRow.content ?? "").slice(0, 200) } as typeof base & { resolvedTitle: string; resolvedSnippet: string };
      }
    }
    if (node.type === "task_ref" && node.data.cardId) {
      const cardRow = db.prepare(`
        SELECT tc.id, tc.title, tc.priority, bc.name as column_name
        FROM task_cards tc
        LEFT JOIN board_columns bc ON tc.column_id = bc.id
        WHERE tc.id = ?
      `).get(node.data.cardId) as
        | { id: string; title: string; priority: string; column_name: string } | undefined;
      if (cardRow) {
        base = { ...base, resolvedTitle: cardRow.title, resolvedPriority: cardRow.priority, resolvedColumnName: cardRow.column_name } as typeof base & { resolvedTitle: string; resolvedPriority: string; resolvedColumnName: string };
      }
    }
    return base;
  });

  // Spatial summary uses absolute coordinates
  const contentNodes = resolved.filter((n) => n.type !== "group");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of contentNodes) {
    const w = n.width ?? 220;
    const h = n.height ?? 80;
    minX = Math.min(minX, n.absoluteX);
    minY = Math.min(minY, n.absoluteY);
    maxX = Math.max(maxX, n.absoluteX + w);
    maxY = Math.max(maxY, n.absoluteY + h);
  }
  const hasNodes = contentNodes.length > 0;

  // Per-group free slots: 40px padding from group top-left, stacked below existing children
  const groups = resolved.filter((n) => n.type === "group");
  const groupSlots: Record<string, { x: number; y: number }> = {};
  for (const g of groups) {
    const children = resolved.filter((n) => n.parentId === g.id);
    if (children.length === 0) {
      groupSlots[g.id] = { x: 40, y: 40 }; // relative to group
    } else {
      let childMaxY = -Infinity;
      for (const c of children) {
        childMaxY = Math.max(childMaxY, c.y + (c.height ?? 80));
      }
      groupSlots[g.id] = { x: 40, y: Math.round(childMaxY + 20) };
    }
  }

  const spatial = {
    bounds: hasNodes ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
    nextPosition: hasNodes ? { x: Math.round(minX), y: Math.round(maxY + 120) } : { x: 40, y: 40 },
    // Per-group suggested positions (relative to group top-left)
    groupSlots,
  };

  return {
    flowId: flow.id,
    projectId,
    nodes: resolved,
    edges,
    spatial,
  };
}

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((row) => toNote(row as any));
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((row) => toCard(row as any));
}

// ── Coding Agents ─────────────────────────────────────────────────────────────

export function getCodingAgents(db: Database.Database) {
  return (db.prepare("SELECT * FROM coding_agents ORDER BY created_at").all() as unknown[])
    .map(toCodingAgent);
}

export function getCodingAgentById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM coding_agents WHERE id = ?").get(id);
  return row ? toCodingAgent(row) : null;
}

export function saveCodingAgent(
  db: Database.Database,
  agent: { id: string; name: string; binaryPath: string; args: string; isDefault: boolean },
) {
  const now = ts();
  db.prepare(`
    INSERT INTO coding_agents (id, name, binary_path, args, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      binary_path = excluded.binary_path,
      args        = excluded.args,
      is_default  = excluded.is_default,
      updated_at  = excluded.updated_at
  `).run(agent.id, agent.name, agent.binaryPath, agent.args, agent.isDefault ? 1 : 0, now, now);
  return getCodingAgentById(db, agent.id)!;
}

export function setDefaultCodingAgent(db: Database.Database, id: string) {
  const setDefault = db.transaction(() => {
    db.prepare("UPDATE coding_agents SET is_default = 0, updated_at = ?").run(ts());
    db.prepare("UPDATE coding_agents SET is_default = 1, updated_at = ? WHERE id = ?").run(ts(), id);
  });
  setDefault();
}

export function deleteCodingAgent(db: Database.Database, id: string) {
  db.prepare("DELETE FROM coding_agents WHERE id = ?").run(id);
}

export function setProjectCodeDirectory(db: Database.Database, projectId: string, path: string | null) {
  db.prepare("UPDATE projects SET code_directory = ?, updated_at = ? WHERE id = ?")
    .run(path ?? null, ts(), projectId);
}

// ── External Tools: MCP servers ───────────────────────────────────────────────

interface McpServerInput {
  id: string; workspaceId: string; name: string; description?: string;
  transport: "sse" | "http"; baseUrl: string; headers?: Record<string, string>;
  authMode?: "none" | "oauth"; oauthScope?: string;
  oauthClientId?: string; oauthRedirectUri?: string; oauthClientIdRequired?: boolean;
  enabled: boolean; source: string; communityId?: string; version?: string;
  /** Raw (un-namespaced) tool names disabled for this server, workspace-wide. */
  disabledTools?: string[];
}

export function getMcpServers(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map(toMcpServer);
}

export function getMcpServerById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  return row ? toMcpServer(row) : null;
}

export function saveMcpServer(db: Database.Database, s: McpServerInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO mcp_servers (id, workspace_id, name, description, transport, base_url, headers, auth_mode, oauth_scope, oauth_client_id, oauth_redirect_uri, oauth_client_id_required, enabled, source, community_id, version, disabled_tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      transport   = excluded.transport,
      base_url    = excluded.base_url,
      headers     = excluded.headers,
      auth_mode   = excluded.auth_mode,
      oauth_scope = excluded.oauth_scope,
      oauth_client_id        = excluded.oauth_client_id,
      oauth_redirect_uri     = excluded.oauth_redirect_uri,
      oauth_client_id_required = excluded.oauth_client_id_required,
      enabled     = excluded.enabled,
      source      = excluded.source,
      community_id= excluded.community_id,
      version     = excluded.version,
      disabled_tools = excluded.disabled_tools,
      updated_at  = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.transport, s.baseUrl,
    j(s.headers ?? {}), s.authMode ?? "none", s.oauthScope ?? null,
    s.oauthClientId ?? null, s.oauthRedirectUri ?? null, s.oauthClientIdRequired ? 1 : 0,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null,
    j(s.disabledTools ?? []), now, now,
  );
  return getMcpServerById(db, s.id)!;
}

export function deleteMcpServer(db: Database.Database, id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'mcp' AND tool_id = ?").run(id);
}

// ── External Tools: custom HTTP services ──────────────────────────────────────

interface CustomServiceInput {
  id: string; workspaceId: string; name: string; description?: string;
  apiUrl?: string; method?: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>;
  toolDefinition?: string; responseKeys?: string[]; apiKeyUrl?: string;
  baseUrl?: string; operations?: unknown[];
  authMode?: "none" | "oauth";
  oauth?: { serverUrl?: string; scope?: string; clientId?: string; redirectUri?: string; authorizationUrl?: string; tokenUrl?: string };
  enabled: boolean; source: string; communityId?: string; version?: string;
}

export function getCustomServices(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM custom_services WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map(toCustomService);
}

export function getCustomServiceById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM custom_services WHERE id = ?").get(id);
  return row ? toCustomService(row) : null;
}

export function saveCustomService(db: Database.Database, s: CustomServiceInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO custom_services (id, workspace_id, name, description, api_url, method, headers, tool_definition, base_url, operations, response_keys, api_key_url, enabled, source, community_id, version, auth_mode, oauth_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      description     = excluded.description,
      api_url         = excluded.api_url,
      method          = excluded.method,
      headers         = excluded.headers,
      tool_definition = excluded.tool_definition,
      base_url        = excluded.base_url,
      operations      = excluded.operations,
      response_keys   = excluded.response_keys,
      api_key_url     = excluded.api_key_url,
      enabled         = excluded.enabled,
      source          = excluded.source,
      community_id    = excluded.community_id,
      version         = excluded.version,
      auth_mode       = excluded.auth_mode,
      oauth_config    = excluded.oauth_config,
      updated_at      = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.apiUrl ?? "", s.method ?? "GET",
    j(s.headers ?? {}), s.toolDefinition ?? "", s.baseUrl ?? null,
    s.operations ? JSON.stringify(s.operations) : null,
    j(s.responseKeys ?? []), s.apiKeyUrl ?? null,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null,
    s.authMode ?? "none", s.oauth ? JSON.stringify(s.oauth) : null, now, now,
  );
  return getCustomServiceById(db, s.id)!;
}

export function deleteCustomService(db: Database.Database, id: string) {
  db.prepare("DELETE FROM custom_services WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'service' AND tool_id = ?").run(id);
}

// ── External Tools: per-project attachments ───────────────────────────────────

export function getToolAttachments(db: Database.Database, projectId: string) {
  return (db.prepare("SELECT * FROM tool_attachments WHERE project_id = ?").all(projectId) as unknown[])
    .map(toToolAttachment);
}

export function setToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string; enabled: boolean },
) {
  db.prepare(`
    INSERT INTO tool_attachments (project_id, tool_type, tool_id, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, tool_type, tool_id) DO UPDATE SET enabled = excluded.enabled
  `).run(a.projectId, a.toolType, a.toolId, a.enabled ? 1 : 0);
  return a;
}

export function clearToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string },
) {
  db.prepare("DELETE FROM tool_attachments WHERE project_id = ? AND tool_type = ? AND tool_id = ?")
    .run(a.projectId, a.toolType, a.toolId);
}

// ── Pi Agent Sessions ────────────────────────────────────────────────────────────────────

export interface PiSessionRow {
  id: string;
  projectId: string;
  taskTitle: string;
  taskId: string | null;
  cwd: string;
  mode: "plan" | "execute";
  planNoteId: string | null;
  status: "running" | "exited";
  spawnedAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPiSession(row: any): PiSessionRow {
  return {
    id:          row.id as string,
    projectId:   row.project_id as string,
    taskTitle:   row.task_title as string,
    taskId:      row.task_id as string | null,
    cwd:         row.cwd as string,
    mode:        (row.mode ?? "execute") as "plan" | "execute",
    planNoteId:  row.plan_note_id as string | null,
    status:      (row.status ?? "running") as "running" | "exited",
    spawnedAt:   row.spawned_at as string,
    updatedAt:   row.updated_at as string,
  };
}

export function createPiSession(
  db: Database.Database,
  session: { id: string; projectId: string; taskTitle: string; taskId?: string | null; cwd: string; mode: "plan" | "execute"; spawnedAt: string },
): PiSessionRow {
  const now = ts();
  db.prepare(`
    INSERT INTO pi_agent_sessions (id, project_id, task_title, task_id, cwd, mode, status, spawned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(session.id, session.projectId, session.taskTitle, session.taskId ?? null, session.cwd, session.mode, session.spawnedAt, now);
  return getPiSessionById(db, session.id)!;
}

export function getPiSessionById(db: Database.Database, id: string): PiSessionRow | null {
  const row = db.prepare("SELECT * FROM pi_agent_sessions WHERE id = ?").get(id);
  return row ? toPiSession(row) : null;
}

export function getPiSessions(db: Database.Database, projectId: string): PiSessionRow[] {
  return (db.prepare("SELECT * FROM pi_agent_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50").all(projectId) as unknown[])
    .map(toPiSession);
}

export function updatePiSession(
  db: Database.Database,
  sessionId: string,
  patch: { mode?: "plan" | "execute"; planNoteId?: string | null; status?: "running" | "exited"; updatedAt?: string },
) {
  const now = patch.updatedAt ?? ts();
  if (patch.mode !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET mode = ?, updated_at = ? WHERE id = ?").run(patch.mode, now, sessionId);
  }
  if (patch.planNoteId !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET plan_note_id = ?, updated_at = ? WHERE id = ?").run(patch.planNoteId, now, sessionId);
  }
  if (patch.status !== undefined) {
    db.prepare("UPDATE pi_agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run(patch.status, now, sessionId);
  }
  if (patch.mode === undefined && patch.planNoteId === undefined && patch.status === undefined) {
    db.prepare("UPDATE pi_agent_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }
}

export function deletePiSession(db: Database.Database, sessionId: string) {
  db.prepare("DELETE FROM pi_agent_sessions WHERE id = ?").run(sessionId);
}

// ── Pi Agent Messages ───────────────────────────────────────────────────────────────────

export interface PiMessageRow {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  reasoning: string | null;
  toolCalls: unknown[] | null;
  subagents: unknown[] | null;
  timestamp: string;
  order: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPiMessage(row: any): PiMessageRow {
  return {
    id:        row.id as string,
    sessionId: row.session_id as string,
    role:      row.role as "user" | "assistant" | "error" | "system",
    content:   row.content as string,
    reasoning: (row.reasoning as string | null) ?? null,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : null,
    subagents: row.subagents ? JSON.parse(row.subagents as string) : null,
    timestamp: row.timestamp as string,
    order:     row.order as number,
  };
}

export function upsertPiMessage(
  db: Database.Database,
  msg: { id: string; sessionId: string; role: "user" | "assistant" | "error" | "system"; content: string; reasoning?: string | null; toolCalls?: unknown[] | null; subagents?: unknown[] | null; timestamp: string; order: number },
) {
  db.prepare(`
    INSERT INTO pi_agent_messages (id, session_id, role, content, reasoning, tool_calls, subagents, timestamp, "order")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content    = excluded.content,
      reasoning  = excluded.reasoning,
      tool_calls = excluded.tool_calls,
      subagents  = excluded.subagents
  `).run(
    msg.id, msg.sessionId, msg.role, msg.content,
    msg.reasoning ?? null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.subagents ? JSON.stringify(msg.subagents) : null,
    msg.timestamp, msg.order,
  );
}

export function savePiMessages(
  db: Database.Database,
  sessionId: string,
  messages: Array<{ id: string; role: "user" | "assistant" | "error" | "system"; content: string; reasoning?: string | null; toolCalls?: unknown[] | null; subagents?: unknown[] | null; timestamp: string }>,
) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM pi_agent_messages WHERE session_id = ?").run(sessionId);
    messages.forEach((msg, i) => {
      upsertPiMessage(db, { ...msg, sessionId, order: i });
    });
  });
  save();
}

export function getPiMessages(db: Database.Database, sessionId: string): PiMessageRow[] {
  return (db.prepare(`SELECT * FROM pi_agent_messages WHERE session_id = ? ORDER BY "order" ASC`).all(sessionId) as unknown[])
    .map(toPiMessage);
}

// ── Pi Agent Session Todos ─────────────────────────────────────────────────────

export interface PiSessionTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

interface PiTodoRow {
  content: string;
  status: string;
  priority: string;
}

function toPiTodo(row: PiTodoRow): PiSessionTodo {
  return {
    content: row.content,
    status: row.status as PiSessionTodo["status"],
    priority: row.priority as PiSessionTodo["priority"],
  };
}

/**
 * Replace-wholesale save for a session's todo list (the model sends the entire
 * list each `todowrite` call). Delete + insert by position in one transaction.
 */
export function saveSessionTodos(db: Database.Database, sessionId: string, todos: PiSessionTodo[]) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM pi_session_todos WHERE session_id = ?").run(sessionId);
    todos.forEach((todo, position) => {
      db.prepare("INSERT INTO pi_session_todos (session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, todo.content, todo.status, todo.priority, position);
    });
  });
  save();
}

export function getSessionTodos(db: Database.Database, sessionId: string): PiSessionTodo[] {
  return (db.prepare("SELECT content, status, priority FROM pi_session_todos WHERE session_id = ? ORDER BY position ASC").all(sessionId) as PiTodoRow[])
    .map(toPiTodo);
}

// ── Pi Agent LLM History ──────────────────────────────────────────────────────────────────

export interface LlmHistoryRow {
  role: string;
  content: string;
}

/**
 * Persist the full LLM message history for a session.
 *
 * Each message is serialised as JSON and stored in the `content` column so that
 * tool_calls (assistant→tool) and tool_call_id (tool result) are preserved across
 * restarts. The `role` column is kept for quick filtering without a JSON parse.
 */
export function saveLlmHistory(
  db: Database.Database,
  sessionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<Record<string, any>>,
) {
  const save = db.transaction(() => {
    db.prepare("DELETE FROM pi_agent_llm_history WHERE session_id = ?").run(sessionId);
    messages.forEach((msg, i) => {
      db.prepare(`INSERT INTO pi_agent_llm_history (session_id, "order", role, content) VALUES (?, ?, ?, ?)`)
        .run(sessionId, i, msg.role as string, JSON.stringify(msg));
    });
  });
  save();
}

/**
 * Restore the full LLM message history for a session.
 *
 * The `content` column contains a JSON-serialised AgentMessage object. We parse
 * it back out; if parsing fails (legacy plain-text rows) we fall back to a minimal
 * { role, content } shape so old sessions degrade gracefully.
 */
export function getLlmHistory(db: Database.Database, sessionId: string): LlmHistoryRow[] {
  const rows = db.prepare(`SELECT role, content FROM pi_agent_llm_history WHERE session_id = ? ORDER BY "order" ASC`).all(sessionId) as LlmHistoryRow[];
  return rows.map((row) => {
    try {
      const parsed = JSON.parse(row.content);
      if (parsed && typeof parsed === "object" && "role" in parsed) return parsed as LlmHistoryRow;
    } catch { /* legacy plain-text row — fall through */ }
    return row;
  });
}

// ── Codebase semantic indexing ────────────────
// The codebase file/symbol/relation/graph queries live in codebase-queries.ts;
// re-exported here so existing `./queries` / `../db/queries` imports are unchanged.
export * from "./codebase-queries";


// ── Embeddings ────────────────────────────────
// Note + task embedding queries live in embeddings-queries.ts; re-exported
// here so existing `./queries` / `../db/queries` imports are unchanged.
export * from "./embeddings-queries";

// ── User writing style ────────────────────────
// Persona + style guide queries live in user-style-queries.ts; re-exported
// here so tools/ipc can import from the single `./db/queries` surface.
export * from "./user-style-queries";
