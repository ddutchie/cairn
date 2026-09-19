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
} from "@/types";
import { nodeTypeToken } from "../../../shared/ui/graph";
import { ipcAwait, ipcData } from "../ipc";

// A refresh requested while a load is in flight re-runs once on completion
// (db:changed bursts). Module-level: never rendered, single store instance.
let graphRefreshQueued = false;

// ── Slice interface ───────────────────────────────────────────────────────────

export interface GraphSlice {
  // Data
  graphData: KnowledgeGraph;
  graphLoading: boolean;
  graphError: string | null;
  /** True after the first successful loadGraph (gates refresh-if-loaded). */
  graphLoaded: boolean;

  // View state
  graphLayout: GraphLayoutMode;
  graphFilters: GraphFilters;
  selectedGraphNodeId: string | null;

  // Actions
  loadGraph: (workspaceId: string) => Promise<void>;
  recomputeGraphRelationships: (workspaceId: string) => Promise<void>;
  recomputeGraphRelationshipsIncremental: (workspaceId: string, entityIds: string[]) => Promise<void>;
  /**
   * Reload the graph if (and only if) it was loaded before — preserves the
   * current filters. Called from the db:changed handler: entity slices are
   * optimistic (so hydration is skipped for own writes), but graphData has no
   * optimistic path and would otherwise go stale until a manual refresh.
   * Coalesces bursts: a refresh requested mid-load re-runs once on completion.
   */
  refreshGraphIfLoaded: () => Promise<void>;
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
  graphLoaded: false,

  graphLayout: "force",
  graphFilters: DEFAULT_GRAPH_FILTERS,
  selectedGraphNodeId: null,

  async loadGraph(workspaceId) {
    set({ graphLoading: true, graphError: null });
    try {
      const filters = get().graphFilters;
      const data = await ipcData((e) => e.graph.get(workspaceId, {
        projectIds: filters.projectIds.length > 0 ? filters.projectIds : undefined,
        includeAuto: filters.includeAuto,
        nodeTypes: filters.nodeTypes,
        edgeTypes: filters.edgeTypes,
      }) as Promise<KnowledgeGraph>);
      if (!data) {
        set({ graphError: "Not in Electron", graphLoading: false });
        return;
      }
      set({ graphData: data, graphLoading: false, graphLoaded: true });
    } catch (e) {
      set({ graphError: e instanceof Error ? e.message : String(e), graphLoading: false });
    } finally {
      if (graphRefreshQueued) {
        graphRefreshQueued = false;
        // Re-read the workspace: it may have switched mid-load.
        await get().loadGraph(get().activeWorkspaceId ?? workspaceId);
      }
    }
  },

  async refreshGraphIfLoaded() {
    const s = get();
    if (!s.graphLoaded) return;
    const wsId = s.activeWorkspaceId;
    if (!wsId) return;
    if (get().graphLoading) {
      graphRefreshQueued = true;
      return;
    }
    await get().loadGraph(wsId);
  },

  async recomputeGraphRelationships(workspaceId) {
    await ipcAwait((e) => e.graph.recompute(workspaceId));
    await get().loadGraph(workspaceId);
  },

  async recomputeGraphRelationshipsIncremental(workspaceId, entityIds) {
    await ipcAwait((e) => e.graph.recompute(workspaceId, entityIds));
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
