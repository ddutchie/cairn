/**
 * Graph slice — knowledge graph data, filters, layout mode, and selected node.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type {
  KnowledgeGraph,
  GraphNode,
  GraphLayoutMode,
  GraphFilters,
  GraphNodeType,
  GraphEdgeType,
} from "@/types";
import { nodeTypeToken } from "../../../shared/ui/graph";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface GraphSlice {
  // Data
  graphData: KnowledgeGraph;
  graphLoading: boolean;
  graphError: string | null;

  // View state
  graphLayout: GraphLayoutMode;
  graphFilters: GraphFilters;
  selectedGraphNodeId: string | null;

  // Actions
  loadGraph: (workspaceId: string) => Promise<void>;
  recomputeGraphRelationships: (workspaceId: string) => Promise<void>;
  recomputeGraphRelationshipsIncremental: (workspaceId: string, entityIds: string[]) => Promise<void>;
  setGraphLayout: (layout: GraphLayoutMode) => void;
  setGraphFilters: (patch: Partial<GraphFilters>) => void;
  setSelectedGraphNode: (id: string | null) => void;
}

// ── Default filters ───────────────────────────────────────────────────────────

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  projectIds: [],
  nodeTypes: ["project", "note", "card", "tag"],
  edgeTypes: [
    "note-note", "note-card", "tag-member", "project-member",
    "flow-ref", "flow-edge", "co-mention", "keyword", "assignee", "wikilink",
    "semantic",
  ],
  includeAuto: true,
};

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createGraphSlice: StateCreator<CairnStore, [], [], GraphSlice> = (
  set,
  get
) => ({
  graphData: { nodes: [], edges: [] },
  graphLoading: false,
  graphError: null,

  graphLayout: "force",
  graphFilters: DEFAULT_GRAPH_FILTERS,
  selectedGraphNodeId: null,

  async loadGraph(workspaceId) {
    set({ graphLoading: true, graphError: null });
    try {
      const filters = get().graphFilters;
      const data = await window.electron!.graph.get(workspaceId, {
        projectIds: filters.projectIds.length > 0 ? filters.projectIds : undefined,
        includeAuto: filters.includeAuto,
        nodeTypes: filters.nodeTypes,
        edgeTypes: filters.edgeTypes,
      }) as KnowledgeGraph;
      set({ graphData: data, graphLoading: false });
    } catch (e) {
      set({ graphError: e instanceof Error ? e.message : String(e), graphLoading: false });
    }
  },

  async recomputeGraphRelationships(workspaceId) {
    await window.electron!.graph.recompute(workspaceId);
    await get().loadGraph(workspaceId);
  },

  async recomputeGraphRelationshipsIncremental(workspaceId, entityIds) {
    await window.electron!.graph.recompute(workspaceId, entityIds);
    await get().loadGraph(workspaceId);
  },

  setGraphLayout(layout) {
    set({ graphLayout: layout });
  },

  setGraphFilters(patch) {
    set((s) => ({ graphFilters: { ...s.graphFilters, ...patch } }));
  },

  setSelectedGraphNode(id) {
    set({ selectedGraphNodeId: id });
  },
});

// ── Selector helpers ──────────────────────────────────────────────────────────

/** Returns only the nodes that pass the current nodeType filter */
export function filterGraphNodes(
  nodes: GraphNode[],
  filters: GraphFilters
): GraphNode[] {
  let result = nodes;
  if (filters.projectIds.length > 0) {
    result = result.filter(
      (n) => n.type === "project"
        ? filters.projectIds.includes(n.id)
        : n.projectId == null || filters.projectIds.includes(n.projectId)
    );
  }
  if (filters.nodeTypes.length < 4) {
    result = result.filter((n) => (filters.nodeTypes as string[]).includes(n.type));
  }
  return result;
}

/** Return only edges where both endpoints survive the node filter */
export function filterGraphEdges(
  edges: KnowledgeGraph["edges"],
  filters: GraphFilters,
  nodeIds: Set<string>
): KnowledgeGraph["edges"] {
  return edges.filter(
    (e) =>
      (filters.edgeTypes as string[]).includes(e.type) &&
      nodeIds.has(e.source) &&
      nodeIds.has(e.target)
  );
}

/** Node type → CSS variable colour token (camelCase token → kebab-case var). */
export function nodeTypeColor(type: GraphNodeType): string {
  const token = nodeTypeToken(type).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `var(--${token})`;
}

/** Edge type → display label */
export function edgeTypeLabel(type: GraphEdgeType): string {
  switch (type) {
    case "note-note":      return "Note link";
    case "note-card":      return "Note ↔ Card";
    case "tag-member":     return "Tag";
    case "project-member": return "Project";
    case "flow-ref":       return "Flow ref";
    case "flow-edge":      return "Flow edge";
    case "co-mention":     return "Co-mention";
    case "keyword":        return "Keyword";
    case "assignee":       return "Assignee";
    case "wikilink":       return "Wikilink";
    case "semantic":       return "Semantic";
  }
}
