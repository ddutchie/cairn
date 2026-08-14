import { describe, it, expect } from "vitest";
import { buildAutomationDevPrompt } from "./automation-dev-prompt";
import type { Automation } from "@/store/slices/automations";

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "aut-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    name: "Image brief",
    description: "",
    instructions: "Check the latest architectural news, then generate images.",
    scheduleKind: "every",
    scheduleExpr: "1 hour",
    timezone: null,
    nextRunAt: new Date().toISOString(),
    enabled: true,
    maxRuns: null,
    runCount: 0,
    approvalMode: "auto",
    activeHoursStart: null,
    activeHoursEnd: null,
    standingRules: [],
    requires: [],
    env: [],
    source: "custom",
    communityId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildAutomationDevPrompt", () => {
  it("grounds the agent in the recipe and the folder layout", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation());
    expect(prompt).toContain('automation "Image brief"');
    expect(prompt).toContain("Check the latest architectural news, then generate images.");
    expect(prompt).toContain("scripts/");
    expect(prompt).toContain("manifest.json");
    expect(prompt).toContain(".env");
    expect(prompt).toContain("Sync from manifest");
  });

  it("tells the agent to author the final recipe into manifest.json instructions", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation());
    expect(prompt).toContain("Edit `manifest.json` and set its `instructions` field");
    expect(prompt).toContain("run generate_images");
    expect(prompt).toContain("run_script");
  });

  it("forbids replicating connectors in scripts", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation({
      requires: [{ kind: "mcp", name: "Tavily" }],
    }));
    expect(prompt).toContain("mcp:Tavily");
    expect(prompt).toContain("must NOT write scripts that wrap, call, or re-implement them");
  });

  it("lists env names and instructs env-schema authoring via manifest", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation({
      env: [{ name: "IMG_API_KEY", secret: true }],
    }));
    expect(prompt).toContain("IMG_API_KEY");
    expect(prompt).toContain("add it to `manifest.json` under `env`");
    expect(prompt).toContain("injected from the OS keychain at run time");
  });
});
