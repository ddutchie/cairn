/**
 * Cairn — shared UI constants.
 * Import from here instead of defining inline in components.
 */

import type { ColumnType, Priority, ProjectStatus } from "@/types";
import type { AIConfig } from "@/store";

/** Default board columns created with every new project (renderer-side copy). */
export const DEFAULT_COLUMNS = [
  { name: "Backlog",     type: "backlog"     as ColumnType, order: 0 },
  { name: "Todo",        type: "todo"        as ColumnType, order: 1 },
  { name: "In Progress", type: "in_progress" as ColumnType, order: 2 },
  { name: "Review",      type: "review"      as ColumnType, order: 3 },
  { name: "Done",        type: "done"        as ColumnType, order: 4 },
] as const;

/** Canonical accent colors per column type. */
export const COLUMN_COLORS: Record<ColumnType | string, string> = {
  backlog:     "#666360",
  todo:        "#60a5fa",
  in_progress: "#f59e0b",
  review:      "#a78bfa",
  done:        "#3ecf8e",
  custom:      "#9ca3af",
};

/** Canonical sort order for column types on the overview. */
export const COLUMN_TYPE_ORDER: ColumnType[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
];

/** Priority options list for UI pickers. */
export const PRIORITY_OPTIONS: Priority[] = ["low", "medium", "high", "urgent"];

/** Project status options for UI pickers. */
export const PROJECT_STATUS_OPTIONS: ProjectStatus[] = [
  "active",
  "on_hold",
  "completed",
  "archived",
];

/**
 * CSS variable strings for priority stripe / indicators.
 * Sourced from PRIORITY_STRIPE in project-overview.tsx.
 */
export const PRIORITY_CSS_COLORS: Record<Priority | string, string> = {
  urgent: "var(--danger)",
  high:   "var(--danger)",
  medium: "var(--accent)",
  low:    "var(--text-tertiary)",
};

/** Default AI/LLM config values. */
export const DEFAULT_AI_CONFIG: AIConfig = {
  baseUrl: "https://api.openai.com",
  model:   "gpt-4o-mini",
  apiKey:  "",
};
