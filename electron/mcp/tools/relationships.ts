/**
 * Cairn — MCP relationship-cache maintenance
 *
 * `relationship_cache` holds DERIVED knowledge-graph edges (co-mention, keyword,
 * assignee, wikilink, semantic). It is not recomputed lazily on read —
 * `getKnowledgeGraph` / `getNeighbors` / `getSemanticNeighbors` just SELECT from
 * it. The Electron IPC write path therefore invalidates + recomputes on every
 * note/card mutation (see `electron/ipc/db-handlers.ts`).
 *
 * The MCP write tools bypassed that entirely, so an agent that created or edited
 * notes through MCP left the cache describing the *previous* state of the
 * workspace — and `get_knowledge_graph` / `get_neighbors` served stale auto-edges
 * indefinitely (restarting the MCP does NOT fix this, because the staleness is
 * persisted in the DB, not held in memory). This module closes that gap.
 *
 * Only the synchronous, DB-only recompute is done here. Semantic edges depend on
 * embeddings produced by the app's embeddings server, so those are left to the
 * app to recompute when it reindexes — we merely drop the stale rows.
 */

import type Database from "better-sqlite3";
import { invalidateRelationshipCache, computeAutoRelationships } from "../../db/graph-queries";

/**
 * Argument keys that carry a note/card entity id. Anything else in an args
 * object (titles, content, folders, column ids…) is not a knowledge-graph node.
 */
const ID_ARG_KEYS = ["noteId", "cardId", "nodeId", "sourceNodeId", "targetNodeId"] as const;
const ID_ARRAY_ARG_KEYS = ["noteIds", "cardIds"] as const;

/**
 * MCP tools that can change a note's or card's content, title, membership, or
 * links — i.e. anything the derived edges are computed from. Read-only tools and
 * tools that only touch non-graph entities (dashboards, flow layout, codebase
 * index) are deliberately excluded so we don't pay a recompute for nothing.
 */
export const RELATIONSHIP_AFFECTING_TOOLS = new Set([
  "ensure_note",
  "append_to_note",
  "patch_note",
  "rename_note",
  "delete_note",
  "bulk_move_notes",
  "instantiate_template",
  "create_task",
  "update_task",
  "delete_task",
  "bulk_update_task_status",
  "link_note_to_task",
  "unlink_note_from_task",
  "tag_note",
  "tag_task",
  "delete_project",
  "create_idea_flow_node",
]);

/** Pull every plausible note/card id out of a tool's args and its result. */
export function collectEntityIds(
  args: Record<string, unknown>,
  result: unknown,
): string[] {
  const ids = new Set<string>();

  const add = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) ids.add(v);
  };

  for (const key of ID_ARG_KEYS) add(args[key]);
  for (const key of ID_ARRAY_ARG_KEYS) {
    const arr = args[key];
    if (Array.isArray(arr)) for (const v of arr) add(v);
  }

  // Write tools return the row they created/updated; `id` is the entity itself.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    add(r.id);
    // create_idea_flow_node inline-creates a backing note/task and reports both.
    add(r.noteId);
    add(r.cardId);
  }

  return [...ids];
}

/**
 * Invalidate and recompute the auto-relationship edges touching `entityIds`.
 *
 * Ids that aren't notes or cards (project ids, tag ids, flow node ids) simply
 * resolve to no workspace and are skipped. Best-effort: a failure here must
 * never fail the tool call that already succeeded.
 */
export function refreshRelationshipsFor(
  db: Database.Database,
  entityIds: string[],
): void {
  if (entityIds.length === 0) return;

  try {
    // Resolve each id to its workspace so the recompute is correctly scoped.
    // A deleted entity has no row left — invalidating its cache rows is still
    // correct (and necessary), it just can't be recomputed.
    const placeholders = entityIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, workspace_id FROM notes WHERE id IN (${placeholders})
         UNION ALL
         SELECT id, workspace_id FROM task_cards WHERE id IN (${placeholders})`,
      )
      .all(...entityIds, ...entityIds) as Array<{ id: string; workspace_id: string }>;

    for (const id of entityIds) invalidateRelationshipCache(db, id);

    // Group the surviving entities by workspace — computeAutoRelationships loads
    // the whole workspace once, so one call per workspace beats one call per id.
    const byWorkspace = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.workspace_id) continue;
      const list = byWorkspace.get(r.workspace_id);
      if (list) list.push(r.id);
      else byWorkspace.set(r.workspace_id, [r.id]);
    }

    for (const [workspaceId, ids] of byWorkspace) {
      computeAutoRelationships(db, workspaceId, ids);
    }
  } catch (err) {
    process.stderr.write(
      `[cairn:mcp] relationship cache refresh skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
