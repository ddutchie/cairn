/**
 * Knowledge-graph payloads shared by the main-process graph queries
 * (`electron/db/graph-queries.ts`), the typed IPC contract and the renderer.
 */

import type { GraphEdgeType, GraphNodeType, ID } from "./domain";

export interface GraphNode {
  id: ID;
  type: GraphNodeType;
  title: string;
  projectId?: ID;
  workspaceId: string;
  /** Extra metadata for the detail panel. */
  meta?: {
    status?: string;
    priority?: string;
    assignee?: string;
    tagIds?: string[];
    isPinned?: boolean;
    snippet?: string;
    /** Tag colour. */
    color?: string;
    isArchived?: boolean;
  };
}

export interface GraphEdge {
  id: ID;
  source: ID;
  target: ID;
  type: GraphEdgeType;
  label?: string;
  weight?: number;
  sourceSectionTitle?: string;
  targetSectionTitle?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** `db:graph:get` filters; omitted fields mean "no filter". */
export interface GraphQueryFilters {
  /** Empty = all projects. */
  projectIds?: string[];
  /** Include relationship_cache (auto-computed) edges. */
  includeAuto?: boolean;
  nodeTypes?: GraphNodeType[];
  edgeTypes?: GraphEdgeType[];
}

export interface NeighbourNode {
  node: GraphNode;
  edge: GraphEdge;
  distance: number;
}

export interface NeighboursResult {
  center: GraphNode | null;
  neighbours: NeighbourNode[];
}
