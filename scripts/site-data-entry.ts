import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, CHAT_EXCLUDED_TOOLS, toolCategory } from "../electron/lib/tool-schemas";
import { NUMBERED_VIEWS, FIRST_RUN_HIDDEN, visibleNumberedViews, buildShortcutMap } from "../src/components/layout/sidebar-utils";

// View labels mirror src/components/settings/ShortcutsSettings.tsx.
const LABELS: Record<string, string> = {
  overview: "Overview",
  notes: "Notes",
  board: "Board",
  calendar: "Calendar",
  flow: "Idea Flow",
  agent: "Agent",
  graph: "Knowledge Graph",
  insights: "Insights",
  automations: "Automations",
  usage: "Usage",
  people: "People",
  today: "Today",
};

const chatOnly = new Set<string>(CHAT_ONLY_TOOLS as readonly string[]);
const chatExcluded = new Set<string>(CHAT_EXCLUDED_TOOLS as readonly string[]);
const tools = Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({
  name,
  description: (t as { description: string }).description,
  kind: toolCategory(name),
  chatOnly: chatOnly.has(name),
  codingOnly: chatExcluded.has(name),
}));

// Default sidebar = only the first-run hidden views hidden (calendar visible, so
// calendar-all drops out, exactly like the app boot state the screenshots use).
const firstRunHidden = new Set<string>(FIRST_RUN_HIDDEN);
const hidden = { has: (view: string) => firstRunHidden.has(view) };
const ids = ["overview", "notes", ...visibleNumberedViews(hidden), "today"];
const shortcuts = buildShortcutMap(
  visibleNumberedViews(hidden).map((view) => ({ view })),
  3,
  true, // docs show macOS ⌘ hints, matching the rest of the site
);
const views = ids.map((id, i) => ({
  id,
  label: LABELS[id] ?? id,
  shortcut: id === "overview" ? "⌘1" : id === "notes" ? "⌘2" : (shortcuts.get(id) || null),
}));

export const siteData = { tools, views };
