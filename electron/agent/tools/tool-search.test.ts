import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { defineTool, type AgentTool } from "../tools";
import { toolSearchTool, toolTokens } from "./tool-search";

const mk = (name: string, description: string): AgentTool => defineTool({ name, description, parameters: Type.Object({}), risk: () => ({ class: "EXTERNAL" }), execute: async () => ({ content: "" }) });
const deferred = [mk("mcp__github__create_issue", "Create an issue in a repository"), mk("mcp__github__list_prs", "List pull requests"), mk("svc__weather", "Get the weather forecast")];
const run = async (live: AgentTool[], query: string) => {
  const search = toolSearchTool(deferred, () => live);
  return (await search.execute({ query } as never, {} as never)).content as string;
};

describe("tool_search", () => {
  it("lists deferred names in its description without their schemas", () => {
    const d = toolSearchTool(deferred, () => []).description;
    expect(d).toContain("mcp__github__create_issue");
    expect(d).not.toContain("pull requests");
  });
  it("activates the best keyword matches into the live toolset, once", async () => {
    const live: AgentTool[] = [];
    expect(await run(live, "github issue")).toContain("mcp__github__create_issue");
    expect(live.map((t) => t.name)).toContain("mcp__github__create_issue");
    await run(live, "github issue");
    expect(live.filter((t) => t.name === "mcp__github__create_issue")).toHaveLength(1);
  });
  it("supports select: and reports misses", async () => {
    const live: AgentTool[] = [];
    await run(live, "select:svc__weather");
    expect(live.map((t) => t.name)).toEqual(["svc__weather"]);
    expect(await run(live, "kubernetes")).toContain("No tools matched");
  });
  it("estimates schema size", () => expect(toolTokens(deferred)).toBeGreaterThan(20));
});
