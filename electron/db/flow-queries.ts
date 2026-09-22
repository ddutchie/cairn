/**
 * Cairn — idea flow queries.
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
import { toIdeaFlow, toIdeaFlowNode, toIdeaFlowEdge, type DbRow } from "../host-shared/db-mappers";
import { stripMarkdown } from "../host-shared/text-utils";

// ── Idea Flow ─────────────────────────────────

/** Get or lazily create the single IdeaFlow for a project. */
export function getOrCreateFlow(db: Database.Database, projectId: string) {
  const existing = db.prepare("SELECT * FROM idea_flows WHERE project_id = ?").get(projectId);
  if (existing) return toIdeaFlow(existing as DbRow);
  const now = ts();
  const id = newId();
  db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, projectId, now, now);
  return toIdeaFlow(db.prepare("SELECT * FROM idea_flows WHERE id = ?").get(id) as DbRow);
}

export function getFlowNodes(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map((row) => toIdeaFlowNode(row as DbRow));
}

export function getFlowEdges(db: Database.Database, flowId: string) {
  return db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ? ORDER BY created_at")
    .all(flowId).map((row) => toIdeaFlowEdge(row as DbRow));
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
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(n.id) as DbRow);
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
  const node = toIdeaFlowNode(existing as DbRow);
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
  return toIdeaFlowNode(db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(id) as DbRow);
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
  return toIdeaFlowEdge(db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(e.id) as DbRow);
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
