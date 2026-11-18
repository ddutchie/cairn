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

/** Knowledge-graph node kinds. `person` and `meeting` come from the People layer (only while it's on). */
export type GraphNodeType = "project" | "note" | "card" | "tag" | "person" | "meeting";

/** Every node kind, in filter-chip order. */
export const GRAPH_NODE_TYPES: readonly GraphNodeType[] = ["project", "note", "card", "tag", "person", "meeting"];

/**
 * Knowledge-graph edge kinds. Mobile's simplified graph uses a subset. The
 * People layer adds person → meeting (`attended`), note → person (`mentions`),
 * meeting → note (`meeting-note`) and the person-to-person edges
 * (`reports-to` runs report → manager; `mentor` mentor → mentee).
 */
export type GraphEdgeType =
  | "note-note" | "note-card" | "tag-member" | "project-member"
  | "flow-ref" | "flow-edge" | "co-mention" | "keyword" | "assignee"
  | "wikilink" | "semantic"
  | "attended" | "mentions" | "meeting-note"
  | "reports-to" | "mentor" | "partner" | "stakeholder";
