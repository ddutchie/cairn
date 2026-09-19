"use client";

/**
 * useGraphData — graph data without the mount-order trap.
 *
 * graphData is lazy (only loaded when a graph view mounts). Components that
 * read it outside those views (e.g. the chat panel's graph context) would
 * silently see an empty graph unless KGV/Insights had mounted first. This
 * hook triggers a load on first read when the graph is empty and idle —
 * filters are preserved because loadGraph reads them from the store.
 *
 * Pass `enabled=false` when the caller doesn't need the data on its current
 * view (e.g. chat outside the graph view) to avoid a one-time load for users
 * who never open graph views.
 */

import { useEffect } from "react";
import { useCairnStore } from "@/store";
import type { KnowledgeGraph } from "@/types";

export function useGraphData(enabled = true): KnowledgeGraph {
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const graphData = useCairnStore((s) => s.graphData);
  const graphLoading = useCairnStore((s) => s.graphLoading);
  const graphLoaded = useCairnStore((s) => s.graphLoaded);
  const loadGraph = useCairnStore((s) => s.loadGraph);

  useEffect(() => {
    if (enabled && activeWorkspaceId && !graphLoaded && !graphLoading) {
      void loadGraph(activeWorkspaceId);
    }
  }, [enabled, activeWorkspaceId, graphLoaded, graphLoading, loadGraph]);

  return graphData;
}
