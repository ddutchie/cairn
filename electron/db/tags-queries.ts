/**
 * Cairn — tag + slash-command queries (workspace-scoped catalogs).
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
import { toTag, toSlashCommand, type DbRow } from "../shared/db-mappers";

// ── Tags ──────────────────────────────────────

export function getTags(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM tags WHERE workspace_id = ?").all(workspaceId)
    : db.prepare("SELECT * FROM tags").all();
  return rows.map((row) => toTag(row as DbRow));
}

export function createTag(db: Database.Database, t: { id: string; workspaceId: string; name: string; color: string }) {
  db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run(t.id, t.workspaceId, t.name, t.color);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(t.id) as DbRow);
}

export function updateTag(db: Database.Database, id: string, patch: { name?: string; color?: string }) {
  db.prepare("UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?")
    .run(patch.name ?? null, patch.color ?? null, id);
  return toTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as DbRow);
}

export function deleteTag(db: Database.Database, id: string) {
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
}

// ── Slash commands ────────────────────────────

export function getSlashCommands(db: Database.Database, workspaceId?: string) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM slash_commands WHERE workspace_id = ? ORDER BY name").all(workspaceId)
    : db.prepare("SELECT * FROM slash_commands ORDER BY name").all();
  return rows.map((row) => toSlashCommand(row as DbRow));
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
  return toSlashCommand(db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(c.id) as DbRow);
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
  return toSlashCommand(db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(id) as DbRow);
}

export function deleteSlashCommand(db: Database.Database, id: string) {
  db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id);
}
