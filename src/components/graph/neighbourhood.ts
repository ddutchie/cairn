import type { KnowledgeGraph } from "@/types";

export type NeighbourhoodHops = 1 | 2 | 3;
export const NEIGHBOURHOOD_HOPS: NeighbourhoodHops[] = [1, 2, 3];

/**
 * The part of `graph` within `hops` edges of `focusId`.
 *
 * Projects and tags are hubs: they join the neighbourhood when reached but the
 * walk doesn't continue through them (unless one is the focus), otherwise two
 * hops from any note would pull in its whole project. Each included node's
 * project is kept too, so the force layout still anchors it in its cluster.
 * Semantic edges below `semanticThreshold` are ignored, matching what the
 * canvas draws. Returns null when the focus isn't in the graph.
 */
export function neighbourhoodGraph(
  graph: KnowledgeGraph,
  focusId: string,
  hops: NeighbourhoodHops,
  semanticThreshold = 1,
): KnowledgeGraph | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(focusId)) return null;

  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const arr = adjacent.get(a);
    if (arr) arr.push(b);
    else adjacent.set(a, [b]);
  };
  for (const e of graph.edges) {
    if (e.type === "semantic" && (e.weight ?? 1) < semanticThreshold) continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }

  const isHub = (id: string) => {
    const t = byId.get(id)?.type;
    return id !== focusId && (t === "project" || t === "tag");
  };

  const included = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < hops && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (isHub(id)) continue;
      for (const other of adjacent.get(id) ?? []) {
        if (included.has(other) || !byId.has(other)) continue;
        included.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  for (const id of [...included]) {
    const pid = byId.get(id)?.projectId;
    if (pid && byId.has(pid)) included.add(pid);
  }

  return {
    nodes: graph.nodes.filter((n) => included.has(n.id)),
    edges: graph.edges.filter((e) => included.has(e.source) && included.has(e.target)),
  };
}
