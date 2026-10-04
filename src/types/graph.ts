/** Knowledge graph. */

import type { ID, GraphNodeType, GraphEdgeType } from "../../shared/types/domain";

// ── Knowledge Graph ───────────────────────────

export interface GraphNode {
  id: ID;
  type: GraphNodeType;
  title: string;
  projectId?: ID;
  workspaceId: string;
  meta?: {
    status?: string;
    priority?: string;
    assignee?: string;
    tagIds?: string[];
    isPinned?: boolean;
    snippet?: string;
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

export type GraphLayoutMode = "force" | "radial";

/** How the currently selected conversation is presented in the app shell. */
export type SessionPresentation = "center" | "drawer" | "workbench";

/** Session families shown by the unified conversation browser. */
export type SessionKind = "chat" | "coding" | "terminal";

export type SessionLoadState =
  | { status: "idle" }
  | { status: "loading"; sessionId: string }
  | { status: "ready"; sessionId: string }
  | { status: "error"; sessionId: string; message: string };

/** Transient object preview shown beside a centered conversation. */
export type ContextPanel =
  | { type: "note" | "task"; id: string }
  | { type: "file"; path: string }
  | { type: "diff"; path?: string };

export interface GraphFilters {
  projectIds: string[];
  nodeTypes: GraphNodeType[];
  edgeTypes: GraphEdgeType[];
  includeAuto: boolean;
}
