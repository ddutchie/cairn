/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import dagre from "@dagrejs/dagre";
import * as q from "../../db/queries";
import { newId, ts } from "../../db/utils";
import { Snapshot, insertNotification } from "../db";

// Small helper: look up a single flow node's presence + flow_id.
// (q.getFlowNodeById doesn't exist; keeping this local avoids adding API surface
// to queries.ts purely for MCP-side validation.)
function getNodeFlowId(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT flow_id FROM idea_flow_nodes WHERE id = ?").get(nodeId) as
    | { flow_id: string } | undefined;
  return row?.flow_id ?? null;
}

export function get_idea_flow(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };

  // Delegate the BFS / resolution / spatial summary to the canonical implementation
  // in queries.ts (q.getResolvedFlow). Adapt the result to the MCP public shape:
  //   - nodes: { id, type, position: {x,y}, width, height, parentId, data, absoluteX, absoluteY, ...resolved* }
  //   - edges: { id, source, target, label }
  //   - spatial: unchanged
  const resolved = q.getResolvedFlow(db, args.projectId as string);

  const nodes = resolved.nodes.map((n) => {
    // Pull resolved* fields out of the top-level (where q.getResolvedFlow puts them)
    // and merge them into data (where MCP consumers expect them).
    const { resolvedTitle, resolvedSnippet, resolvedPriority, resolvedColumnName, ...rest } = n as any;
    const resolvedFields: Record<string, unknown> = {};
    if (resolvedTitle !== undefined) resolvedFields.resolvedTitle = resolvedTitle;
    if (resolvedSnippet !== undefined) resolvedFields.resolvedSnippet = resolvedSnippet;
    if (resolvedPriority !== undefined) resolvedFields.resolvedPriority = resolvedPriority;
    if (resolvedColumnName !== undefined) resolvedFields.resolvedColumnName = resolvedColumnName;
    return {
      id: rest.id,
      type: rest.type,
      position: { x: rest.x, y: rest.y },
      width: rest.width ?? null,
      height: rest.height ?? null,
      parentId: rest.parentId ?? null,
      data: { ...rest.data, ...resolvedFields },
      absoluteX: rest.absoluteX,
      absoluteY: rest.absoluteY,
    };
  });

  const edges = resolved.edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label ?? null,
  }));

  return {
    flowId: resolved.flowId,
    projectId: args.projectId,
    nodes,
    edges,
    spatial: resolved.spatial,
  };
}

export function create_idea_flow_node(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const validTypes = ["idea", "note_ref", "task_ref", "group", "url", "ai_summary"];
  if (!validTypes.includes(args.type as string)) return { error: `Invalid node type. Must be one of: ${validTypes.join(", ")}` };

  const flow = q.getOrCreateFlow(db, args.projectId as string);
  const nodeId = newId();
  const node = q.createFlowNode(db, {
    id: nodeId,
    flowId: flow.id,
    type: args.type as string,
    x: (args.x ?? 0) as number,
    y: (args.y ?? 0) as number,
    width: args.width,
    height: args.height,
    parentId: args.parentId,
    data: args.data ?? {},
  });
  insertNotification(db, "create_idea_flow_node", "Idea Flow updated", `Added ${args.type} node to flow`);

  // Optionally create edges inline (the `edges` array on create_idea_flow_node args)
  const createdEdges: { id: string; source: string; target: string; label: string | null }[] = [];
  if (Array.isArray(args.edges)) {
    for (const edgeDef of args.edges as Array<{ targetNodeId?: string; sourceNodeId?: string; label?: string }>) {
      const src = edgeDef.sourceNodeId ?? nodeId;
      const tgt = edgeDef.targetNodeId ?? nodeId;
      const edgeId = newId();
      q.createFlowEdge(db, {
        id: edgeId,
        flowId: flow.id,
        sourceNodeId: src,
        targetNodeId: tgt,
        label: edgeDef.label,
      });
      // q.createFlowEdge returns null on duplicate (INSERT OR IGNORE);
      // only include in the response if the edge was actually created.
      const created = db.prepare("SELECT 1 FROM idea_flow_edges WHERE id = ?").get(edgeId);
      if (created) {
        createdEdges.push({ id: edgeId, source: src, target: tgt, label: edgeDef.label ?? null });
      }
    }
  }

  return {
    id: nodeId,
    flowId: flow.id,
    type: args.type,
    position: { x: args.x ?? 0, y: args.y ?? 0 },
    data: args.data ?? {},
    createdAt: node.createdAt,
    edges: createdEdges,
  };
}

export function update_idea_flow_node(db: Database.Database, args: Record<string, any>) {
  // Existence check (q.updateFlowNode throws on missing — MCP returns { error }).
  const existing = db.prepare("SELECT data FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as
    | { data: string } | undefined;
  if (!existing) return { error: "Node not found" };

  // Build the patch that q.updateFlowNode expects. The q helper merges data via
  // { ...existing.data, ...patch.data } itself, so we just pass patch.data.
  const patch: Parameters<typeof q.updateFlowNode>[2] = {};
  if (args.x !== undefined) patch.x = args.x;
  if (args.y !== undefined) patch.y = args.y;
  if (args.width !== undefined) patch.width = args.width;
  if (args.height !== undefined) patch.height = args.height;
  if (args.parentId !== undefined) patch.parentId = args.parentId as string | null;
  if (args.data !== undefined) patch.data = args.data;

  const updated = q.updateFlowNode(db, args.nodeId as string, patch);
  insertNotification(db, "update_idea_flow_node", "Idea Flow updated", `Node updated`);
  return { id: args.nodeId, data: updated.data, updatedAt: updated.updatedAt };
}

export function delete_idea_flow_node(db: Database.Database, args: Record<string, any>) {
  const exists = db.prepare("SELECT 1 FROM idea_flow_nodes WHERE id = ?").get(args.nodeId);
  if (!exists) return { error: "Node not found" };
  q.deleteFlowNode(db, args.nodeId as string); // edges cascade-deleted via FK
  insertNotification(db, "delete_idea_flow_node", "Idea Flow updated", `Node removed from flow`);
  return { deleted: true, id: args.nodeId };
}

export function create_idea_flow_edge(db: Database.Database, args: Record<string, any>) {
  const flowId = getNodeFlowId(db, args.sourceNodeId as string);
  if (!flowId) return { error: "Source node not found" };
  // Verify target exists AND belongs to the same flow.
  const targetExists = db.prepare("SELECT 1 FROM idea_flow_nodes WHERE id = ? AND flow_id = ?").get(args.targetNodeId, flowId);
  if (!targetExists) return { error: "Target node not found" };

  const edgeId = newId();
  const created = q.createFlowEdge(db, {
    id: edgeId,
    flowId,
    sourceNodeId: args.sourceNodeId as string,
    targetNodeId: args.targetNodeId as string,
    label: args.label,
  });
  if (!created) {
    // INSERT OR IGNORE skipped — a duplicate edge exists. Find its id.
    const existing = db.prepare(
      "SELECT id FROM idea_flow_edges WHERE flow_id = ? AND source_node_id = ? AND target_node_id = ?"
    ).get(flowId, args.sourceNodeId, args.targetNodeId) as { id: string } | undefined;
    return { id: existing?.id ?? null, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, note: "Edge already exists" };
  }
  insertNotification(db, "create_idea_flow_edge", "Idea Flow updated", `Nodes connected`);
  return { id: edgeId, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, createdAt: created.createdAt };
}

export function delete_idea_flow_edge(db: Database.Database, args: Record<string, any>) {
  const exists = db.prepare("SELECT 1 FROM idea_flow_edges WHERE id = ?").get(args.edgeId);
  if (!exists) return { error: "Edge not found" };
  q.deleteFlowEdge(db, args.edgeId as string);
  insertNotification(db, "delete_idea_flow_edge", "Idea Flow updated", `Connection removed`);
  return { deleted: true, id: args.edgeId };
}

export function layout_idea_flow(db: Database.Database, args: Record<string, any>) {
  const flowRow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(args.projectId) as { id: string } | undefined;
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
