/**
 * Settings navigation and search index.
 *
 * `SETTINGS_NAV` is the rail: one page per task, grouped. `SETTINGS_INDEX`
 * lists the rows and groups on each page so the rail's search can jump
 * straight to one; each `label` must match a `SettingsRow` label or
 * `SettingsGroup` title on that page exactly (settings-index.test.ts checks
 * this against the page sources), because the jump finds the row by its
 * `data-settings-label` attribute.
 */

import type { SettingsSection } from "@/types";

export type SettingsPage = Exclude<SettingsSection, "extensions" | "system">;

export interface SettingsNavItem {
  id: SettingsPage;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_NAV: { group: string; items: SettingsNavItem[] }[] = [
  {
    group: "App",
    items: [
      { id: "general", label: "General", description: "Workspace, theme and text." },
      { id: "views", label: "Sidebar & views", description: "Choose which views appear in the sidebar." },
      { id: "tags", label: "Tags", description: "Rename, recolour or delete the tags used on notes and tasks." },
      { id: "shortcuts", label: "Shortcuts", description: "Keyboard shortcuts." },
    ],
  },
  {
    group: "AI",
    items: [
      { id: "models", label: "Models", description: "Add AI providers. Chat and the coding agent each pick which one they use." },
      { id: "ai", label: "Chat", description: "The model and behaviour behind Chat and the editor's AI actions." },
      { id: "agents", label: "Coding agent", description: "Cairn's coding agent, plus external coding CLIs." },
      { id: "writing-style", label: "Writing style", description: "Teach Cairn how you write." },
      { id: "embeddings", label: "Embeddings", description: "Search your notes and tasks by meaning, on this machine." },
    ],
  },
  {
    group: "Extensions",
    items: [
      { id: "tools", label: "Tools", description: "MCP servers and HTTP services the AI can use." },
      { id: "commands", label: "Commands", description: "Slash commands for chat and the coding agent." },
      { id: "mcp", label: "Connect other agents", description: "Let Claude Desktop, OpenCode and other agents read and write this workspace." },
    ],
  },
  {
    group: "Data",
    items: [
      { id: "sync", label: "Device sync", description: "Keep the Cairn mobile app in step with this workspace." },
      { id: "data", label: "Data", description: "Storage, export and reset." },
      { id: "about", label: "About", description: "Version, app tour and what's new." },
    ],
  },
];

export const SETTINGS_PAGES: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

/** Old ids (tabbed layout) → their page today. */
export function resolveSettingsPage(section: SettingsSection | null | undefined): SettingsPage {
  if (!section) return "general";
  if (section === "extensions") return "tools";
  if (section === "system") return "shortcuts";
  return section;
}

export interface SettingsIndexEntry {
  page: SettingsPage;
  label: string;
  /** Extra words that should find this row. */
  keywords?: string;
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  { page: "general", label: "Workspace name" },
  { page: "general", label: "Theme", keywords: "dark light mode appearance" },
  { page: "general", label: "Accent color", keywords: "colour" },
  { page: "general", label: "Chat theme", keywords: "bubbles" },
  { page: "general", label: "Font size", keywords: "text scale zoom" },
  { page: "general", label: "Note font", keywords: "serif mono typeface" },
  { page: "general", label: "Workspace folder", keywords: "move location" },
  { page: "views", label: "Visible views", keywords: "hide show sidebar board calendar flow graph insights agent" },
  { page: "tags", label: "Workspace tags", keywords: "labels colour" },
  { page: "shortcuts", label: "Keyboard shortcuts", keywords: "hotkeys keys" },
  { page: "models", label: "Community providers", keywords: "openai anthropic openrouter catalog install" },
  { page: "models", label: "Local servers", keywords: "ollama lm studio llama.cpp localhost" },
  { page: "ai", label: "Chat model", keywords: "provider endpoint api key" },
  { page: "ai", label: "Max steps", keywords: "tool calls rounds" },
  { page: "ai", label: "Temperature", keywords: "sampling" },
  { page: "ai", label: "Context window", keywords: "tokens limit" },
  { page: "ai", label: "Max output tokens", keywords: "length" },
  { page: "ai", label: "Subagents" },
  { page: "ai", label: "Inline AI", keywords: "editor rephrase summarize prd" },
  { page: "ai", label: "Chat personality", keywords: "tone style persona" },
  { page: "ai", label: "Chat prompt and tools", keywords: "system prompt preview" },
  { page: "agents", label: "Cairn coding agent", keywords: "provider model endpoint pi" },
  { page: "agents", label: "Max steps", keywords: "agent tool calls" },
  { page: "agents", label: "Temperature", keywords: "agent sampling" },
  { page: "agents", label: "Context window", keywords: "agent tokens limit" },
  { page: "agents", label: "Max output tokens", keywords: "agent length" },
  { page: "agents", label: "Sandbox shell commands", keywords: "security bash seatbelt bubblewrap" },
  { page: "agents", label: "Session reminders" },
  { page: "agents", label: "Coding prompt and tools", keywords: "system prompt preview" },
  { page: "writing-style", label: "Your writing style", keywords: "voice persona" },
  { page: "embeddings", label: "Enable embeddings", keywords: "semantic search vectors" },
  { page: "tools", label: "MCP servers", keywords: "integrations connectors jira linear github" },
  { page: "tools", label: "Custom HTTP services", keywords: "api webhook" },
  { page: "commands", label: "Your commands", keywords: "slash" },
  { page: "commands", label: "Built-in commands", keywords: "slash" },
  { page: "commands", label: "Community commands", keywords: "slash catalog" },
  { page: "mcp", label: "MCP server", keywords: "claude desktop opencode config json" },
  { page: "mcp", label: "MCP tools" },
  { page: "sync", label: "Shared sync folder", keywords: "mobile phone icloud dropbox syncthing" },
  { page: "data", label: "Export data", keywords: "backup json" },
  { page: "data", label: "Assets folder", keywords: "images attachments" },
  { page: "data", label: "Reset data", keywords: "delete wipe" },
  { page: "about", label: "About Cairn", keywords: "version tour changelog what's new" },
];

/** Case-insensitive match on label, keywords and page name; best matches first. */
export function searchSettings(query: string): (SettingsIndexEntry & { pageLabel: string })[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pageLabel = (id: SettingsPage) => SETTINGS_PAGES.find((p) => p.id === id)?.label ?? id;
  const terms = q.split(/\s+/);
  return SETTINGS_INDEX
    .map((e) => {
      const label = e.label.toLowerCase();
      const hay = `${label} ${e.keywords ?? ""} ${pageLabel(e.page).toLowerCase()}`;
      if (!terms.every((t) => hay.includes(t))) return null;
      const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
      return { ...e, pageLabel: pageLabel(e.page), score };
    })
    .filter((e): e is SettingsIndexEntry & { pageLabel: string; score: number } => e !== null)
    .sort((a, b) => a.score - b.score)
    .map(({ score: _score, ...e }) => e);
}
