/** Idea Flow. */

import type { ID } from "../../shared/types/domain";

// ── Idea Flow ────────────────────────────────
export type IdeaNodeType = "idea" | "note_ref" | "task_ref" | "url" | "ai_summary" | "group";

export interface IdeaNodeDataMap {
  idea:       { title: string; body?: string };
  note_ref:   { noteId: string };
  task_ref:   { cardId: string };
  url:        { url: string; title?: string; description?: string };
  ai_summary: { content: string };
  group:      { label?: string; color?: string };
}

/** Raw node as stored in / returned from the DB (data is opaque JSON). */
export interface IdeaFlowNode {
  id: ID;
  flowId: ID;
  type: IdeaNodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: ID;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaFlowEdge {
  id: ID;
  flowId: ID;
  sourceNodeId: ID;
  targetNodeId: ID;
  label?: string;
  createdAt: string;
}

export interface IdeaFlow {
  id: ID;
  projectId: ID;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolved graph returned to the renderer and AI/MCP.
 * note_ref and task_ref nodes have their linked entity's data merged in.
 */
export interface ResolvedIdeaFlowNode extends IdeaFlowNode {
  // Absolute canvas position (group children store relative x/y in DB)
  absoluteX: number;
  absoluteY: number;
  // For note_ref: title + snippet from the linked note
  resolvedTitle?: string;
  resolvedSnippet?: string;
  // For task_ref: title + priority + column name from the linked card
  resolvedPriority?: string;
  resolvedColumnName?: string;
}

export interface ResolvedIdeaFlow {
  flowId: ID;
  projectId: ID;
  nodes: ResolvedIdeaFlowNode[];
  edges: IdeaFlowEdge[];
  spatial: {
    bounds: { x: number; y: number; width: number; height: number } | null;
    nextPosition: { x: number; y: number };
    groupSlots: Record<string, { x: number; y: number }>;
  };
}
