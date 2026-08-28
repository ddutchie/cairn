/**
 * Shared row/graph types for the mobile query layer. These are pure type
 * declarations (no runtime), extracted from queries.ts so they can be imported
 * without pulling in the whole query module. Re-exported from queries.ts so
 * existing `@/db/queries` imports keep working unchanged.
 */

export interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string | null;
  folder: string;
  tag_ids: string;
  updated_at: string;
  is_pinned?: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  icon: string | null;
}

export interface ColumnRow {
  id: string;
  project_id: string;
  name: string;
  /** Column semantics — "done" columns trigger the task-complete celebration. */
  type: string;
  order: number;
  /** Optional WIP limit — drives the honest WIP status on the Overview instrument. */
  card_limit?: number | null;
}

export interface CardRow {
  id: string;
  column_id: string;
  project_id: string;
  title: string;
  description: string | null;
  priority: string;
  tag_ids: string;
  order: number;
  due_date?: string | null;
  assignee?: string | null;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

// ── Knowledge graph ─────────────────────────────────────────────────────────

export type GraphNodeType = "project" | "note" | "card" | "tag";
export type GraphEdgeType =
  | "project-member"
  | "note-note"
  | "note-card"
  | "tag-member"
  | "semantic";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  title: string;
  /** Tag colour (tag nodes) or priority accent (card nodes), for rendering. */
  color?: string;
  priority?: string;
  /** Owning project id (note/card nodes) — used to draw cluster hulls. */
  projectId?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  /** Similarity (0–1) for 'semantic' edges; drives dash-line weight/threshold. */
  weight?: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
