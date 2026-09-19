/**
 * Cairn — workspace + project queries (incl. project merge).
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts, newId } from "./utils";
import { toWorkspace, toProject, j, type DbRow } from "../shared/db-mappers";import type { SessionProfileId } from "../../shared/agent/session-profile";
import { getOrCreateFlow } from "./flow-queries";

export interface SessionProfileRow {
  sessionId: string;
  profile: SessionProfileId;
  workspaceId: string | null;
  projectId: string | null;
  cwd: string | null;
  updatedAt: string;
}

export function upsertSessionProfile(db: Database.Database, profile: {
  sessionId: string;
  profile: SessionProfileId;
  workspaceId?: string | null;
  projectId?: string | null;
  cwd?: string | null;
  updatedAt?: string;
}): SessionProfileRow {
  const updatedAt = profile.updatedAt ?? ts();
  return db.transaction(() => {
    const row = db.prepare(`
      INSERT INTO session_profiles (session_id, profile, workspace_id, project_id, cwd, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        profile = excluded.profile, workspace_id = excluded.workspace_id,
        project_id = excluded.project_id, cwd = excluded.cwd, updated_at = excluded.updated_at
      RETURNING session_id, profile, workspace_id, project_id, cwd, updated_at
    `).get(profile.sessionId, profile.profile, profile.workspaceId ?? null, profile.projectId ?? null, profile.cwd ?? null, updatedAt) as {
      session_id: string; profile: SessionProfileId; workspace_id: string | null; project_id: string | null; cwd: string | null; updated_at: string;
    };
    return { sessionId: row.session_id, profile: row.profile, workspaceId: row.workspace_id, projectId: row.project_id, cwd: row.cwd, updatedAt: row.updated_at };
  })();
}

export function getSessionProfile(db: Database.Database, sessionId: string): SessionProfileRow | null {
  const row = db.prepare("SELECT session_id, profile, workspace_id, project_id, cwd, updated_at FROM session_profiles WHERE session_id = ?").get(sessionId) as {
    session_id: string; profile: SessionProfileId; workspace_id: string | null; project_id: string | null; cwd: string | null; updated_at: string;
  } | undefined;
  return row ? { sessionId: row.session_id, profile: row.profile, workspaceId: row.workspace_id, projectId: row.project_id, cwd: row.cwd, updatedAt: row.updated_at } : null;
}

// ── Workspace ─────────────────────────────────

export function getAllWorkspaces(db: Database.Database) {
  return db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map((row) => toWorkspace(row as DbRow));
}

export function createWorkspace(db: Database.Database, ws: { id: string; name: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    INSERT INTO workspaces (id, name, description, icon, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ws.id, ws.name, ws.description ?? null, ws.icon ?? null, now, now);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ws.id) as DbRow);
}

export function updateWorkspace(db: Database.Database, id: string, patch: { name?: string; description?: string; icon?: string }) {
  const now = ts();
  db.prepare(`
    UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description),
    icon = COALESCE(?, icon), updated_at = ? WHERE id = ?
  `).run(patch.name ?? null, patch.description ?? null, patch.icon ?? null, now, id);
  return toWorkspace(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbRow);
}

// ── Projects ──────────────────────────────────

export function getProjects(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at").all(workspaceId)
    : db.prepare("SELECT * FROM projects ORDER BY created_at").all();
  return rows.map((row) => toProject(row as DbRow));
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
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id) as DbRow);
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
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbRow);
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
  return row ? toProject(row as DbRow) : null;
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
 *   - tool_attachments, agent_session_metadata → repointed
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
    db.prepare("UPDATE agent_session_metadata SET project_id = ? WHERE project_id = ?").run(targetId, sourceId);

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
  return toProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as DbRow);
}
