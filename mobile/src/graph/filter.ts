import type { GraphNode, GraphEdge, GraphNodeType } from "@/db/types";

export const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Node-type filter, then a search filter (title / tag name), then drop edges
 * whose endpoints were removed. Search keeps the parent projects of matches so
 * the radial hierarchy still has a bucket for them (mirrors desktop
 * searchedGraph). Pure — shared by the Skia renderer and its tests.
 */
export function filterGraph(graph: GraphData, activeTypes: ReadonlySet<GraphNodeType>, search: string): GraphData {
  let nodes = graph.nodes.filter((n) => activeTypes.has(n.type));
  const q = search.trim().toLowerCase();
  if (q) {
    const tagName = new Map<string, string>();
    for (const n of nodes) if (n.type === "tag") tagName.set(n.id, n.title.toLowerCase());
    const nodeTags = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.type !== "tag-member") continue;
      const list = nodeTags.get(e.source) ?? [];
      list.push(e.target);
      nodeTags.set(e.source, list);
    }
    const match = new Set(
      nodes
        .filter((n) => {
          if (n.title.toLowerCase().includes(q)) return true;
          return (nodeTags.get(n.id) ?? []).some((tid) => tagName.get(tid)?.includes(q));
        })
        .map((n) => n.id),
    );
    const keepProjects = new Set<string>();
    for (const n of nodes) if (match.has(n.id) && n.projectId) keepProjects.add(n.projectId);
    nodes = nodes.filter((n) => match.has(n.id) || (n.type === "project" && keepProjects.has(n.id)));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}
