/**
 * Cairn — shared UI constants.
 * Import from here instead of defining inline in components.
 */

import type { ColumnType, Priority, ProjectStatus } from "@/types";
import type { AIConfig, AgentConfig } from "@/store";

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
 * Tailwind text-colour classes per priority level.
 * Use for badges, icons, and text labels.
 */
export const PRIORITY_COLORS: Record<string, string> = {
  low:    "text-[var(--text-tertiary)]",
  medium: "text-[var(--warning)]",
  high:   "text-[var(--warning)]",
  urgent: "text-[var(--danger)]",
};

/**
 * CSS variable strings for priority stripe / inline indicators.
 * Use for inline `style` props where Tailwind isn't suitable.
 */
export const PRIORITY_CSS_COLORS: Record<Priority | string, string> = {
  urgent: "var(--danger)",
  high:   "var(--warning)",
  medium: "var(--info)",
  low:    "var(--text-tertiary)",
};

/** Default AI/LLM config values. */
export const DEFAULT_AI_CONFIG: AIConfig = {
  provider:     "localllm",
  baseUrl:      "https://api.openai.com",
  model:        "gpt-4o-mini",
  apiKey:       "",
  maxSteps:     20,
  temperature:  0.3,
  contextLimit: 128000,
  aiEnabled:    true,
};

/** Default Coding Agent config values. */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  baseUrl:      "https://api.openai.com",
  model:        "gpt-4o",
  apiKey:       "",
  maxSteps:     30,
  temperature:  0.3,
  contextLimit: 128000,
};

// ── localStorage keys ─────────────────────────────────────────────────────────

/** localStorage key for the persisted AI/LLM configuration. */
export const AI_CONFIG_KEY = "ai-config";

/** localStorage key for the persisted Coding Agent configuration. */
export const AGENT_CONFIG_KEY = "agent-config";

/** localStorage key for the last active project ID. */
export const ACTIVE_PROJECT_KEY = "active-project";

/** localStorage key for the persisted chat panel width (px). */
export const CHAT_PANEL_WIDTH_KEY = "chatPanelWidth";
