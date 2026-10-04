// ─────────────────────────────────────────────
// Cairn — Core Domain Types
// ─────────────────────────────────────────────
// Split by domain; import from "@/types" as before.

// Leaf unions shared with Electron and mobile.
export type { ID, ProjectStatus, Priority, ColumnType, GraphNodeType, GraphEdgeType } from "../../shared/types/domain";

export * from "./workspace";
export * from "./notes";
export * from "./board";
export * from "./tools";
export * from "./chat";
export * from "./flow";
export * from "./graph";
export * from "./app";
export * from "./agent";
