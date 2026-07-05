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

/**
 * Prettify a tool label/name for display (mirrors src/lib/utils
 * prettifyToolLabel + a snake/namespaced fallback). Both apps show identical
 * tool-call chip labels.
 */
export function prettifyToolLabel(label: string): string {
  if (typeof label !== "string") return label;
  const match = /^(?:mcp|svc)__.+?__(.+)$/.exec(label);
  const raw = match && match[1] ? match[1] : label;
  const tool = raw.replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!tool) return label;
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}
