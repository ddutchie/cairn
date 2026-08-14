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
    expect(prompt).toContain('press "Run now"');
  });

  it("lists env var names and the secret handling contract", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation({
      env: [
        { name: "IMG_API_KEY", secret: true },
        { name: "PLAIN", value: "abc", secret: false },
      ],
    }));
    expect(prompt).toContain("IMG_API_KEY, PLAIN");
    expect(prompt).toContain("Secret values are stored in the OS keychain");
    expect(prompt).toContain("never written to files");
  });

  it("mentions required connectors", () => {
    const prompt = buildAutomationDevPrompt(makeAutomation({
      requires: [{ kind: "mcp", name: "browser" }],
    }));
    expect(prompt).toContain("mcp:browser");
  });
});
