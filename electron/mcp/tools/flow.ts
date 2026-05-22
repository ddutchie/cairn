/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import dagre from "@dagrejs/dagre";
import { newId, ts } from "../../db/utils";
import { Snapshot, insertNotification } from "../db";

export function get_idea_flow(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  // Get or create the flow
  const existingFlow = db.prepare("SELECT * FROM idea_flows WHERE project_id = ?").get(args.projectId) as
    | { id: string; project_id: string; created_at: string; updated_at: string } | undefined;
  let flowId: string;
  if (existingFlow) {
    flowId = existingFlow.id;
  } else {
    flowId = newId();
    const now = ts();
    db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(flowId, args.projectId, now, now);
  }
  const rawNodes = db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ? ORDER BY created_at").all(flowId) as any[];
  const rawEdges = db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ? ORDER BY created_at").all(flowId) as any[];
  const nodes = rawNodes.map((row) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data); } catch { /* empty */ }
    const node = {
      id: row.id as string,
      type: row.type as string,
      position: { x: row.x as number, y: row.y as number },
      width: row.width as number | null,
      height: row.height as number | null,
      parentId: row.parent_id as string | null,
      data,
    };
    // Resolve note_ref
    if (node.type === "note_ref" && data.noteId) {
      const noteRow = db.prepare("SELECT id, title, content_text FROM notes WHERE id = ?").get(data.noteId) as
        | { id: string; title: string; content_text: string } | undefined;
      if (noteRow) {
        return { ...node, data: { ...data, resolvedTitle: noteRow.title, resolvedSnippet: noteRow.content_text?.slice(0, 200) ?? "" } };
      }
    }
    // Resolve task_ref
    if (node.type === "task_ref" && data.cardId) {
      const cardRow = db.prepare(`
        SELECT tc.id, tc.title, tc.priority, bc.name as column_name
        FROM task_cards tc LEFT JOIN board_columns bc ON tc.column_id = bc.id
        WHERE tc.id = ?
      `).get(data.cardId) as { id: string; title: string; priority: string; column_name: string } | undefined;
      if (cardRow) {
        return { ...node, data: { ...data, resolvedTitle: cardRow.title, resolvedPriority: cardRow.priority, resolvedColumnName: cardRow.column_name } };
      }
    }
    return node;
  });
  const edges = rawEdges.map((row) => ({
    id: row.id as string,
    source: row.source_node_id as string,
    target: row.target_node_id as string,
    label: row.label as string | null,
  }));
  // Build group position map for absolute coord computation
  const groupPos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (n.type === "group") groupPos.set(n.id, { x: n.position.x, y: n.position.y });
  }

  // Enrich nodes with absoluteX/absoluteY (children use relative coords in DB)
  const enriched = nodes.map((n) => {
    const parent = n.parentId ? groupPos.get(n.parentId) : undefined;
    return {
      ...n,
      absoluteX: parent ? parent.x + n.position.x : n.position.x,
      absoluteY: parent ? parent.y + n.position.y : n.position.y,
    };
  });

  // Spatial summary uses absolute coordinates
  const contentNodes = enriched.filter((n) => n.type !== "group");
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

  // Per-group free slots (relative to group top-left)
  const groupSlots: Record<string, { x: number; y: number }> = {};
  for (const g of enriched.filter((n) => n.type === "group")) {
    const children = enriched.filter((n) => n.parentId === g.id);
    if (children.length === 0) {
      groupSlots[g.id] = { x: 40, y: 40 };
    } else {
      let childMaxY = -Infinity;
      for (const c of children) childMaxY = Math.max(childMaxY, c.position.y + (c.height ?? 80));
      groupSlots[g.id] = { x: 40, y: Math.round(childMaxY + 20) };
    }
  }

  const spatial = {
    bounds: hasNodes ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
    nextPosition: hasNodes ? { x: Math.round(minX), y: Math.round(maxY + 120) } : { x: 40, y: 40 },
    groupSlots,
  };
  return { flowId, projectId: args.projectId, nodes: enriched, edges, spatial };
}

export function create_idea_flow_node(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const validTypes = ["idea", "note_ref", "task_ref", "group", "url", "ai_summary"];
  if (!validTypes.includes(args.type as string)) return { error: `Invalid node type. Must be one of: ${validTypes.join(", ")}` };
  // Get or create flow
  const existingFlow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(args.projectId) as { id: string } | undefined;
  let flowId: string;
  if (existingFlow) {
    flowId = existingFlow.id;
  } else {
    flowId = newId();
    const fnow = ts();
    db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(flowId, args.projectId, fnow, fnow);
  }
  const nodeId = newId();
  const now = ts();
  const dataJson = JSON.stringify(args.data ?? {});
  db.prepare(`
    INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nodeId, flowId, args.type, args.x ?? 0, args.y ?? 0, args.width ?? null, args.height ?? null, args.parentId ?? null, dataJson, now, now);
  insertNotification(db, "create_idea_flow_node", "Idea Flow updated", `Added ${args.type} node to flow`);

  // Optionally create edges inline
  const createdEdges: { id: string; source: string; target: string; label: string | null }[] = [];
  if (Array.isArray(args.edges)) {
    for (const edgeDef of args.edges as Array<{ targetNodeId?: string; sourceNodeId?: string; label?: string }>) {
      const edgeId = newId();
      const edgeNow = ts();
      const src = edgeDef.sourceNodeId ?? nodeId;
      const tgt = edgeDef.targetNodeId ?? nodeId;
      db.prepare(`
        INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(edgeId, flowId, src, tgt, edgeDef.label ?? null, edgeNow);
      const created = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(edgeId) as any;
      if (created) createdEdges.push({ id: edgeId, source: src, target: tgt, label: edgeDef.label ?? null });
    }
  }

  return { id: nodeId, flowId, type: args.type, position: { x: args.x ?? 0, y: args.y ?? 0 }, data: args.data ?? {}, createdAt: now, edges: createdEdges };
}

export function update_idea_flow_node(db: Database.Database, args: Record<string, any>) {
  const existingRow = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as any;
  if (!existingRow) return { error: "Node not found" };
  let existingData: Record<string, unknown> = {};
  try { existingData = JSON.parse(existingRow.data); } catch { /* empty */ }
  const mergedData = args.data !== undefined ? { ...existingData, ...(args.data as Record<string, unknown>) } : existingData;
  const now = ts();
  db.prepare(`
    UPDATE idea_flow_nodes SET
      x          = COALESCE(?, x),
      y          = COALESCE(?, y),
      width      = COALESCE(?, width),
      height     = COALESCE(?, height),
      data       = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    args.x !== undefined ? args.x : null,
    args.y !== undefined ? args.y : null,
    args.width !== undefined ? args.width : null,
    args.height !== undefined ? args.height : null,
    JSON.stringify(mergedData),
    now,
    args.nodeId,
  );
  insertNotification(db, "update_idea_flow_node", "Idea Flow updated", `Node updated`);
  return { id: args.nodeId, data: mergedData, updatedAt: now };
}

export function delete_idea_flow_node(db: Database.Database, args: Record<string, any>) {
  const existingNode = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as any;
  if (!existingNode) return { error: "Node not found" };
  db.prepare("DELETE FROM idea_flow_nodes WHERE id = ?").run(args.nodeId);
  insertNotification(db, "delete_idea_flow_node", "Idea Flow updated", `Node removed from flow`);
  return { deleted: true, id: args.nodeId };
}

export function create_idea_flow_edge(db: Database.Database, args: Record<string, any>) {
  const srcNode = db.prepare("SELECT id, flow_id FROM idea_flow_nodes WHERE id = ?").get(args.sourceNodeId) as any;
  if (!srcNode) return { error: "Source node not found" };
  const tgtNode = db.prepare("SELECT id FROM idea_flow_nodes WHERE id = ?").get(args.targetNodeId) as any;
  if (!tgtNode) return { error: "Target node not found" };
  const edgeId = newId();
  const now = ts();
  db.prepare(`
    INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(edgeId, srcNode.flow_id, args.sourceNodeId, args.targetNodeId, args.label ?? null, now);
  // Check if INSERT OR IGNORE silently skipped (duplicate edge)
  const created = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(edgeId) as any;
  if (!created) {
    const existing = db.prepare("SELECT id FROM idea_flow_edges WHERE flow_id = ? AND source_node_id = ? AND target_node_id = ?")
      .get(srcNode.flow_id, args.sourceNodeId, args.targetNodeId) as any;
    return { id: existing?.id ?? null, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, note: "Edge already exists" };
  }
  insertNotification(db, "create_idea_flow_edge", "Idea Flow updated", `Nodes connected`);
  return { id: edgeId, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, createdAt: now };
}

export function delete_idea_flow_edge(db: Database.Database, args: Record<string, any>) {
  const existingEdge = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(args.edgeId) as any;
  if (!existingEdge) return { error: "Edge not found" };
  db.prepare("DELETE FROM idea_flow_edges WHERE id = ?").run(args.edgeId);
  insertNotification(db, "delete_idea_flow_edge", "Idea Flow updated", `Connection removed`);
  return { deleted: true, id: args.edgeId };
}

export function layout_idea_flow(db: Database.Database, args: Record<string, any>) {
  const flowRow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(args.projectId) as any;
  if (!flowRow) return { arranged: 0 };
  const rawNodes = db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ?").all(flowRow.id) as any[];
  const rawEdges = db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ?").all(flowRow.id) as any[];
  if (rawNodes.length === 0) return { arranged: 0 };

  const dir = (args.direction as string) === "TB" ? "TB" : "LR";
  const NODE_W = 220, NODE_H = 80, GROUP_PADDING = 48, GROUP_PADDING_TOP = 56, GROUP_GAP = 80;

  function makeG(rankdir: string, nodesep: number, ranksep: number) {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir, nodesep, ranksep, marginx: 40, marginy: 40 });
    return g;
  }

  const groups    = rawNodes.filter((n: { type: string }) => n.type === "group");
  const ungrouped = rawNodes.filter((n: { type: string; parent_id: string | null }) => n.type !== "group" && !n.parent_id);
  const grouped   = rawNodes.filter((n: { type: string; parent_id: string | null }) => n.type !== "group" && !!n.parent_id);

  const now = ts();
  const posStmt  = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?");
  const sizeStmt = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, width = ?, height = ?, updated_at = ? WHERE id = ?");
  const groupSizes = new Map<string, { width: number; height: number }>();

  // Phase 1: layout children inside each group
  for (const group of groups) {
    const children = grouped.filter((n: { parent_id: string }) => n.parent_id === group.id);
    if (children.length === 0) {
      groupSizes.set(group.id, { width: group.width ?? 320, height: group.height ?? 200 });
      continue;
    }
    const childIds = new Set(children.map((n: { id: string }) => n.id));
    const g = makeG(dir, 60, 120);
    for (const c of children) g.setNode(c.id, { width: NODE_W, height: NODE_H });
    for (const e of rawEdges) {
      if (e.source_node_id !== e.target_node_id && childIds.has(e.source_node_id) && childIds.has(e.target_node_id)) {
        g.setEdge(e.source_node_id, e.target_node_id);
      }
    }
    dagre.layout(g);
    let innerMaxX = 0, innerMaxY = 0;
    for (const c of children) {
      const pos = g.node(c.id);
      if (!pos) continue;
      const rx = pos.x - pos.width / 2 + GROUP_PADDING;
      const ry = pos.y - pos.height / 2 + GROUP_PADDING_TOP;
      innerMaxX = Math.max(innerMaxX, rx + pos.width);
      innerMaxY = Math.max(innerMaxY, ry + pos.height);
      posStmt.run(rx, ry, now, c.id);
    }
    const gw = innerMaxX + GROUP_PADDING;
    const gh = innerMaxY + GROUP_PADDING;
    groupSizes.set(group.id, { width: gw, height: gh });
  }

  // Phase 2: layout groups + ungrouped together
  const topLevel = [...groups, ...ungrouped];
  if (topLevel.length > 0) {
    const g = makeG(dir, GROUP_GAP, GROUP_GAP + 40);
    for (const n of topLevel) {
      const size = groupSizes.get(n.id);
      g.setNode(n.id, { width: size?.width ?? NODE_W, height: size?.height ?? NODE_H });
    }
    const topIds = new Set(topLevel.map((n: { id: string }) => n.id));
    for (const e of rawEdges) {
      if (e.source_node_id !== e.target_node_id && topIds.has(e.source_node_id) && topIds.has(e.target_node_id)) {
        g.setEdge(e.source_node_id, e.target_node_id);
      }
    }
    dagre.layout(g);
    for (const n of topLevel) {
      const pos = g.node(n.id);
      if (!pos) continue;
      const x = pos.x - pos.width / 2;
      const y = pos.y - pos.height / 2;
      if (n.type === "group") {
        const size = groupSizes.get(n.id)!;
        sizeStmt.run(x, y, size.width, size.height, now, n.id);
      } else {
        posStmt.run(x, y, now, n.id);
      }
    }
  }

  insertNotification(db, "layout_idea_flow", "Idea Flow updated", `Auto-arranged ${rawNodes.length} nodes`);
  return { arranged: rawNodes.length, direction: dir };
}
