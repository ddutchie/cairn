/**
 * The settings search jumps to a row by its exact `data-settings-label`, so
 * every index entry must still match a SettingsRow label / SettingsGroup title
 * on its page. Renaming a row without updating the index fails here instead
 * of silently breaking search.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SETTINGS_INDEX, SETTINGS_PAGES, resolveSettingsPage, searchSettings, type SettingsPage } from "./settings-index";

const DIR = __dirname;
const PAGE_FILES: Record<SettingsPage, string[]> = {
  general: ["GeneralSettings.tsx"],
  views: ["ViewVisibilitySettings.tsx"],
  tags: ["TagsSettings.tsx"],
  shortcuts: ["ShortcutsSettings.tsx"],
  models: ["ModelsSettings.tsx", "AISettings.tsx"], // LocalServersCard lives in AISettings
  ai: ["AISettings.tsx"],
  agents: ["AgentSettings.tsx"],
  "writing-style": ["UserStyleSettings.tsx"],
  embeddings: ["EmbeddingsSettings.tsx"],
  tools: ["ToolsSettings.tsx"],
  commands: ["CommandsSettings.tsx"],
  mcp: ["MCPSettings.tsx"],
  sync: ["SyncSettings.tsx"],
  data: ["DataSettings.tsx"],
  about: ["AboutSection.tsx"],
};

const source = (page: SettingsPage) =>
  PAGE_FILES[page].map((f) => fs.readFileSync(path.join(DIR, f), "utf8")).join("\n");

describe("settings search index", () => {
  it.each(SETTINGS_INDEX.map((e) => [e.page, e.label] as const))("%s: %s is a real row or group", (page, label) => {
    const src = source(page);
    expect(src.includes(`label="${label}"`) || src.includes(`title="${label}"`)).toBe(true);
  });

  it("covers every page in the rail", () => {
    for (const p of SETTINGS_PAGES) expect(PAGE_FILES[p.id]).toBeDefined();
  });

  it("maps legacy tab ids onto today's pages", () => {
    expect(resolveSettingsPage("extensions")).toBe("tools");
    expect(resolveSettingsPage("system")).toBe("shortcuts");
    expect(resolveSettingsPage(null)).toBe("general");
    expect(resolveSettingsPage("agents")).toBe("agents");
  });

  it("ranks label prefix matches first and matches keywords", () => {
    expect(searchSettings("temp")[0].label).toBe("Temperature");
    expect(searchSettings("ollama").map((r) => r.label)).toContain("Local servers");
    expect(searchSettings("dark mode")[0].label).toBe("Theme");
    expect(searchSettings("  ")).toEqual([]);
  });
});
