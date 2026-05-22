/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { insertNotification } from "../db";

export function get_knowledge_graph(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, projectIds, includeAuto = true } = args;
  if (!workspaceId) return { error: "workspaceId is required" };

  // Get scoped projects
  const allProjects = db.prepare(
    "SELECT id, name, description, status, priority FROM projects WHERE workspace_id = ? AND archived_at IS NULL"
  ).all(workspaceId) as Record<string, unknown>[];

  const filteredProjects = projectIds && Array.isArray(projectIds) && projectIds.length > 0
    ? allProjects.filter((p) => (projectIds as string[]).includes(p.id as string))
    : allProjects;

  const projIds = filteredProjects.map((p) => p.id as string);
  if (projIds.length === 0) return { nodes: [], edges: [] };
  const ph = projIds.map(() => "?").join(",");

  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  let seq = 0;
  const nodeSet = new Set<string>();

  function eid(t: string, s: string, g: string) { return `${t}:${s}:${g}:${seq++}`; }
  function pj(v: unknown): string[] { try { return JSON.parse(v as string ?? "[]") as string[]; } catch { return []; } }

  // Projects
  for (const p of filteredProjects) {
    nodeSet.add(p.id as string);
    nodes.push({ id: p.id, type: "project", title: p.name, meta: { status: p.status, priority: p.priority } });
  }

  // Notes
  const notes = db.prepare(
    `SELECT id, project_id, title, content_text, tag_ids, linked_note_ids, linked_card_ids FROM notes WHERE project_id IN (${ph}) AND archived_at IS NULL`
  ).all(...projIds) as Record<string, unknown>[];
  for (const n of notes) {
    nodeSet.add(n.id as string);
    nodes.push({ id: n.id, type: "note", title: n.title, projectId: n.project_id,
      meta: { snippet: ((n.content_text as string) || "").slice(0, 120) } });
    edges.push({ id: eid("pm", n.project_id as string, n.id as string), source: n.project_id, target: n.id, type: "project-member" });
    for (const lid of pj(n.linked_note_ids)) {
      if ((n.id as string) < lid)
        edges.push({ id: eid("nn", n.id as string, lid), source: n.id, target: lid, type: "note-note", label: "linked" });
    }
  }

  // Cards
  const cards = db.prepare(
    `SELECT id, project_id, title, description, tag_ids, linked_note_ids, assignee, priority FROM task_cards WHERE project_id IN (${ph}) AND archived_at IS NULL`
  ).all(...projIds) as Record<string, unknown>[];
  for (const c of cards) {
    nodeSet.add(c.id as string);
    nodes.push({ id: c.id, type: "card", title: c.title, projectId: c.project_id,
      meta: { priority: c.priority, assignee: c.assignee, snippet: ((c.description as string) || "").slice(0, 120) } });
    edges.push({ id: eid("pm", c.project_id as string, c.id as string), source: c.project_id, target: c.id, type: "project-member" });
    for (const nid of pj(c.linked_note_ids))
      edges.push({ id: eid("nc", nid, c.id as string), source: nid, target: c.id, type: "note-card", label: "linked" });
  }

  // Tags
  const usedTagIds = new Set<string>();
  for (const n of notes) for (const t of pj(n.tag_ids)) usedTagIds.add(t);
  for (const c of cards) for (const t of pj(c.tag_ids)) usedTagIds.add(t);
  if (usedTagIds.size > 0) {
    const tph = [...usedTagIds].map(() => "?").join(",");
    const tags = db.prepare(`SELECT id, name, color FROM tags WHERE id IN (${tph})`).all(...usedTagIds) as Record<string, unknown>[];
    for (const t of tags) {
      nodeSet.add(t.id as string);
      nodes.push({ id: t.id, type: "tag", title: t.name, meta: { color: t.color } });
    }
    for (const n of notes) for (const tid of pj(n.tag_ids))
      if (nodeSet.has(tid)) edges.push({ id: eid("tm", n.id as string, tid), source: n.id, target: tid, type: "tag-member" });
    for (const c of cards) for (const tid of pj(c.tag_ids))
      if (nodeSet.has(tid)) edges.push({ id: eid("tm", c.id as string, tid), source: c.id, target: tid, type: "tag-member" });
  }

  // IdeaFlow explicit edges
  const flows = db.prepare(`SELECT id FROM idea_flows WHERE project_id IN (${ph})`).all(...projIds) as Record<string, unknown>[];
  for (const fl of flows) {
    const fEdges = db.prepare(
      `SELECT fe.id, sn.data as sdata, tn.data as tdata, fe.label
       FROM idea_flow_edges fe
       JOIN idea_flow_nodes sn ON sn.id = fe.source_node_id
       JOIN idea_flow_nodes tn ON tn.id = fe.target_node_id
       WHERE fe.flow_id = ?`
    ).all(fl.id) as Record<string, unknown>[];
    for (const fe of fEdges) {
      const sd = JSON.parse((fe.sdata as string) || "{}") as Record<string, string>;
      const td = JSON.parse((fe.tdata as string) || "{}") as Record<string, string>;
      const src = sd.noteId || sd.cardId;
      const tgt = td.noteId || td.cardId;
      if (src && tgt && nodeSet.has(src) && nodeSet.has(tgt))
        edges.push({ id: eid("fe", src, tgt), source: src, target: tgt, type: "flow-edge", label: fe.label || "connected" });
    }
  }

  // Auto relationships
  if (includeAuto && nodeSet.size > 0) {
    const autoRows = db.prepare(
      "SELECT source_id, target_id, type, weight FROM relationship_cache WHERE type IN ('co-mention','keyword','assignee')"
    ).all() as Record<string, unknown>[];
    for (const r of autoRows) {
      if (nodeSet.has(r.source_id as string) && nodeSet.has(r.target_id as string))
        edges.push({ id: eid(r.type as string, r.source_id as string, r.target_id as string), source: r.source_id, target: r.target_id, type: r.type, weight: r.weight });
    }
  }

  insertNotification(db, "get_knowledge_graph", "Knowledge graph retrieved", `${nodes.length} nodes, ${edges.length} edges`);
  return { nodes, edges };
}

export function get_neighbors(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, nodeId, depth = 1 } = args;
  if (!workspaceId || !nodeId) return { error: "workspaceId and nodeId are required" };
  // Build full graph then BFS
  const fullResult = get_knowledge_graph(db, { workspaceId, includeAuto: true });
  const graph = fullResult as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[]; error?: string };
  if (graph.error || !graph.nodes) return { center: null, neighbours: [] };

  const center = graph.nodes.find((n) => n.id === nodeId) ?? null;
  if (!center) return { center: null, neighbours: [] };

  const adj = new Map<string, { nodeId: string; edge: Record<string, unknown> }[]>();
  for (const e of graph.edges) {
    const s = e.source as string, t = e.target as string;
    if (!adj.has(s)) adj.set(s, []);
    if (!adj.has(t)) adj.set(t, []);
    adj.get(s)!.push({ nodeId: t, edge: e });
    adj.get(t)!.push({ nodeId: s, edge: e });
  }

  const visited = new Set<string>([nodeId]);
  const queue: { id: string; dist: number; edge: Record<string, unknown> }[] = [];
  const neighbours: unknown[] = [];
  for (const a of adj.get(nodeId) ?? []) {
    if (!visited.has(a.nodeId)) { visited.add(a.nodeId); queue.push({ id: a.nodeId, dist: 1, edge: a.edge }); }
  }
  while (queue.length > 0) {
    const item = queue.shift()!;
    const node = graph.nodes.find((n) => n.id === item.id);
    if (!node) continue;
    neighbours.push({ node, edge: item.edge, distance: item.dist });
    if (item.dist < (depth as number)) {
      for (const a of adj.get(item.id) ?? []) {
        if (!visited.has(a.nodeId)) { visited.add(a.nodeId); queue.push({ id: a.nodeId, dist: item.dist + 1, edge: a.edge }); }
      }
    }
  }
  return { center, neighbours };
}
