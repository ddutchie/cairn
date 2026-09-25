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

// Trailing debounce for db:changed-triggered refreshes (saves land ~300ms
// apart while typing — without this every pause fires a full graph query).
let graphRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const GRAPH_REFRESH_DEBOUNCE_MS = 1200;

// Number of loadGraph calls (foreground or silent) awaiting IPC. Silent
// refreshes don't toggle `graphLoading`, so the coalescing check needs this; a
// counter (not a flag) because view mounts, filter changes and refreshes can
// overlap — the queued refresh runs only once the LAST load settles.
let graphLoadsInFlight = 0;

// Serialized payload of the last graph committed to the store. The WAL poller
// fires db:changed for every write from any source (sync drain, usage recorder,
// automations…), most of which don't touch the graph — when a refresh returns
// an identical payload we skip the `set` so graphData keeps its identity and no
// canvas re-renders, rebuilds its layout, or resets its drill-down.
let lastGraphSignature: string | null = null;

// ── Slice interface ───────────────────────────────────────────────────────────

export interface GraphSlice {
  // Data
  graphData: KnowledgeGraph;
  graphLoading: boolean;
  graphError: string | null;
  /** True after the first successful loadGraph (gates refresh-if-loaded). */
  graphLoaded: boolean;
  /**
   * Workspace that produced `graphData`. Views treat the graph as stale (and
   * show the loading state instead of the old canvas) while it differs from
   * `activeWorkspaceId`, e.g. right after a workspace switch.
   */
  graphWorkspaceId: string | null;

  // View state
  graphLayout: GraphLayoutMode;
  graphFilters: GraphFilters;
  selectedGraphNodeId: string | null;

  // Actions
  /**
   * Fetch the graph. `silent` (background db:changed refreshes) keeps the
   * current graph on screen: it doesn't toggle `graphLoading`, so the view
   * never flashes its loading overlay for a refresh the user didn't ask for.
   */
  loadGraph: (workspaceId: string, opts?: { silent?: boolean }) => Promise<void>;
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

/**
 * Stable empty graph. Views select this instead of `graphData` while the data
 * belongs to another workspace (see `graphWorkspaceId`), so they show the
 * loading state rather than the previous workspace's canvas.
 */
export const EMPTY_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };

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
  graphWorkspaceId: null,

  graphLayout: "force",
  graphFilters: DEFAULT_GRAPH_FILTERS,
  selectedGraphNodeId: null,

  async loadGraph(workspaceId, opts) {
    const silent = !!opts?.silent;
    if (!silent) set({ graphLoading: true, graphError: null });
    graphLoadsInFlight++;
    try {
      const filters = get().graphFilters;
      const data = await ipcData((e) => e.graph.get(workspaceId, {
        projectIds: filters.projectIds.length > 0 ? filters.projectIds : undefined,
        includeAuto: filters.includeAuto,
        nodeTypes: filters.nodeTypes,
        edgeTypes: filters.edgeTypes,
      }) as Promise<KnowledgeGraph>);
      // The user switched workspace while this was in flight: drop the stale
      // payload rather than showing workspace A's graph under workspace B.
      if (get().activeWorkspaceId !== workspaceId) return;
      if (!data) {
        // Off-Electron (or empty backend): latch loaded so first-read hooks
        // don't refetch in a loop; there is simply nothing to show.
        set({ graphError: "Not in Electron", graphLoading: false, graphLoaded: true, graphWorkspaceId: workspaceId });
        return;
      }
      const signature = JSON.stringify(data);
      const cur = get();
      if (signature === lastGraphSignature && cur.graphLoaded && !cur.graphError) {
        // Unchanged — keep graphData's identity (no downstream re-render). Two
        // workspaces can have identical graphs (e.g. both empty), so still
        // record which workspace this data now belongs to.
        if (cur.graphLoading || cur.graphWorkspaceId !== workspaceId) {
          set({ graphLoading: false, graphWorkspaceId: workspaceId });
        }
        return;
      }
      lastGraphSignature = signature;
      set({ graphData: data, graphLoading: false, graphLoaded: true, graphError: null, graphWorkspaceId: workspaceId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (silent) {
        // A failed background refresh keeps the graph that's on screen; only a
        // user-visible load surfaces graphError (which replaces the canvas).
        console.warn("[graph] background refresh failed:", message);
      } else {
        set({ graphError: message, graphLoading: false });
      }
    } finally {
      graphLoadsInFlight--;
      if (graphLoadsInFlight === 0) {
        // A stale (workspace-switched) foreground load returns without
        // committing; don't leave the loading state stuck on.
        if (get().graphLoading) set({ graphLoading: false });
        if (graphRefreshQueued) {
          graphRefreshQueued = false;
          // Re-read the workspace: it may have switched (or closed) mid-load.
          // The queued re-run is always a background refresh.
          const ws = get().activeWorkspaceId;
          if (ws) await get().loadGraph(ws, { silent: true });
        }
      }
    }
  },

  async refreshGraphIfLoaded() {
    const s = get();
    if (!s.graphLoaded) return;
    const wsId = s.activeWorkspaceId;
    if (!wsId) return;
    // Trailing debounce: db:changed fires per save while typing.
    if (graphRefreshTimer) clearTimeout(graphRefreshTimer);
    graphRefreshTimer = setTimeout(() => {
      graphRefreshTimer = null;
      const cur = get();
      if (!cur.graphLoaded || !cur.activeWorkspaceId) return;
      if (cur.graphLoading || graphLoadsInFlight > 0) {
        graphRefreshQueued = true;
        return;
      }
      void cur.loadGraph(cur.activeWorkspaceId, { silent: true });
    }, GRAPH_REFRESH_DEBOUNCE_MS);
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
