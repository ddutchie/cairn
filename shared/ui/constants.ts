/**
 * Shared UI constants — pure data (no React, no platform deps) so desktop and
 * mobile render the SAME icon set and priority colours.
 *
 * The icon *names* are Lucide identifiers; each platform maps them to its own
 * Lucide component (lucide-react on desktop, lucide-react-native on mobile).
 */

/** Workspace/project icon names (Lucide). Mirrors src/lib/workspace-icons. */
export const WORKSPACE_ICON_NAMES = [
  "Layers",
  "Folder",
  "BookOpen",
  "Briefcase",
  "Code2",
  "Cpu",
  "Globe",
  "Home",
  "Inbox",
  "Lightbulb",
  "Map",
  "Mountain",
  "Pencil",
  "Rocket",
  "Star",
  "Target",
  "TreePine",
  "Waves",
  "Zap",
] as const;

export type WorkspaceIconName = (typeof WORKSPACE_ICON_NAMES)[number];

export const DEFAULT_WORKSPACE_ICON = "Layers";
export const DEFAULT_PROJECT_ICON = "Folder";

/** Resolve a stored icon name to a valid Lucide name, falling back sensibly. */
export function resolveProjectIconName(name?: string | null): string {
  if (name && (WORKSPACE_ICON_NAMES as readonly string[]).includes(name)) return name;
  return DEFAULT_PROJECT_ICON;
}

/** Task priority → colour. Mirrors src analyticsUtils PRIORITY_COLOR. */
export const PRIORITY_COLOR: Record<string, string> = {
  low: "#94a3b8",
  medium: "#6366f1",
  high: "#f59e0b",
  urgent: "#ef4444",
};

/** Task priorities, low → urgent. The canonical order for pickers/chips. */
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Board column types. Mirrors src/types ColumnType (minus "custom" edge cases). */
export type ColumnType = "backlog" | "todo" | "in_progress" | "review" | "done" | "custom";

/**
 * Canonical accent colour per column type. Mirrors desktop src/lib/constants
 * COLUMN_COLORS so the Overview column breakdown / board snapshot render the
 * same hues on desktop and mobile.
 */
export const COLUMN_COLORS: Record<string, string> = {
  backlog: "#666360",
  todo: "#60a5fa",
  in_progress: "#f59e0b",
  review: "#a78bfa",
  done: "#3ecf8e",
  custom: "#9ca3af",
};

/** Canonical sort order for column types on the overview / breakdowns. */
export const COLUMN_TYPE_ORDER: ColumnType[] = ["backlog", "todo", "in_progress", "review", "done"];

/**
 * Prettify a tool label/name for display. Both apps show identical tool-call
 * chip labels via this single implementation.
 *
 * Behaviour:
 *   - A raw namespaced id (`mcp__<id>__<tool>` / `svc__<id>__<tool>`) always has
 *     its prefix stripped and the tool part humanised: `Search designs`.
 *   - Otherwise the label is returned UNCHANGED by default — the desktop main
 *     process already emits friendly labels (`Canva · Search designs`), so a
 *     bare string must not be mangled.
 *   - `prettifyBare: true` additionally humanises a plain `snake_case` /
 *     `kebab-case` name (`create_task` → `Create task`). The mobile agent emits
 *     raw tool names with no namespace, so it opts in.
 */
export function prettifyToolLabel(
  label: string,
  opts?: { prettifyBare?: boolean },
): string {
  if (typeof label !== "string") return label;
  const match = /^(?:mcp|svc)__.+?__(.+)$/.exec(label);
  if (match && match[1]) {
    const tool = match[1].replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!tool) return label;
    return tool.charAt(0).toUpperCase() + tool.slice(1);
  }
  // Not a namespaced id. Only rewrite bare snake/kebab names when asked, and
  // only when the label looks like a raw identifier (no spaces already).
  if (opts?.prettifyBare && !/\s/.test(label) && /[_.\-]/.test(label)) {
    const tool = label.replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
    if (tool) return tool.charAt(0).toUpperCase() + tool.slice(1);
  }
  return label;
}
