"use client";

/**
 * useGraphData — graph data without the mount-order trap.
 *
 * graphData is lazy (only loaded when a graph view mounts). Components that
 * read it outside those views (e.g. the chat panel's graph context) would
 * silently see an empty graph unless KGV/Insights had mounted first. This
 * hook triggers a load on first read when the graph is empty and idle —
 * filters are preserved because loadGraph reads them from the store.
 */

import { useEffect } from "react";
import { useCairnStore } from "@/store";
import type { KnowledgeGraph } from "@/types";

export function useGraphData(): KnowledgeGraph {
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const graphData = useCairnStore((s) => s.graphData);
  const graphLoading = useCairnStore((s) => s.graphLoading);
  const graphLoaded = useCairnStore((s) => s.graphLoaded);
  const loadGraph = useCairnStore((s) => s.loadGraph);

  useEffect(() => {
    if (activeWorkspaceId && !graphLoaded && !graphLoading) {
      void loadGraph(activeWorkspaceId);
    }
  }, [activeWorkspaceId, graphLoaded, graphLoading, loadGraph]);

  return graphData;
}
