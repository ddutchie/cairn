/** Knowledge graph. */

import type { GraphNodeType, GraphEdgeType } from "../../shared/types/domain";

// ── Knowledge Graph ───────────────────────────
// Node/edge payloads are shared with the main process (shared/types/graph.ts).
export type { GraphNode, GraphEdge, KnowledgeGraph } from "../../shared/types/graph";

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
