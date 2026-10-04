/**
 * Leaf domain types shared by desktop (renderer + Electron) and mobile.
 * Platform row/UI shapes build on these; keep this file dependency-free.
 */

export type ID = string;

export type ProjectStatus = "active" | "on_hold" | "completed" | "archived";

/** Task priorities, low → urgent. `PRIORITIES` in `../ui/constants` lists them in order. */
export type Priority = "low" | "medium" | "high" | "urgent";

/** Board column types. */
export type ColumnType = "backlog" | "todo" | "in_progress" | "review" | "done" | "custom";

/** Knowledge-graph node kinds. */
export type GraphNodeType = "project" | "note" | "card" | "tag";

/** Knowledge-graph edge kinds. Mobile's simplified graph uses a subset. */
export type GraphEdgeType =
  | "note-note" | "note-card" | "tag-member" | "project-member"
  | "flow-ref" | "flow-edge" | "co-mention" | "keyword" | "assignee"
  | "wikilink" | "semantic";
