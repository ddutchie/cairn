"use client";

/**
 * useLoadGraph — loads the knowledge graph when the active workspace changes.
 *
 * Encapsulates the repeated pattern:
 *   useEffect(() => { if (activeWorkspaceId) loadGraph(activeWorkspaceId); }, [activeWorkspaceId]);
 *
 * Used by KnowledgeGraphView and InsightsView. Zustand actions (loadGraph) are
 * stable references so excluding them from the effect deps is safe; this hook
 * documents that explicitly instead of suppressing the linter at each call-site.
 */

import { useEffect } from "react";
import { useCairnStore } from "@/store";

export function useLoadGraph(activeWorkspaceId: string | null | undefined): void {
  const loadGraph = useCairnStore((s) => s.loadGraph);

  useEffect(() => {
    if (activeWorkspaceId) loadGraph(activeWorkspaceId);
  }, [activeWorkspaceId, loadGraph]);
}
