import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { defineTool, type AgentTool } from "../tools";
import { toolSearchTool, toolTokens } from "./tool-search";

const mk = (name: string, description: string): AgentTool => defineTool({ name, description, parameters: Type.Object({}), risk: () => ({ class: "EXTERNAL" }), execute: async () => ({ content: "" }) });
const deferred = [mk("mcp__github__create_issue", "Create an issue in a repository"), mk("mcp__github__list_prs", "List pull requests"), mk("svc__weather", "Get the weather forecast")];
const run = async (live: AgentTool[], query: string, search = toolSearchTool(deferred)) =>
  (await search.execute({ query } as never, { tools: live } as never)).content as string;

describe("tool_search", () => {
  it("lists deferred names in its description without their schemas", () => {
    const d = toolSearchTool(deferred).description;
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
  it("loads into the calling agent's own toolset, so a subagent never feeds its parent", async () => {
    const search = toolSearchTool(deferred); // one instance, copied into the child's toolset
    const parent: AgentTool[] = [search];
    const child: AgentTool[] = [search];
    await run(child, "weather", search);
    expect(child.map((t) => t.name)).toContain("svc__weather");
    expect(parent.map((t) => t.name)).not.toContain("svc__weather");
  });
  it("says so when the agent has no toolset to load into", async () => {
    const r = await toolSearchTool(deferred).execute({ query: "weather" } as never, {} as never);
    expect(r.isError).toBe(true);
  });
  it("pages through names beyond the first block", async () => {
    const many = Array.from({ length: 250 }, (_, i) => mk(`mcp__big__t${i}`, ""));
    const search = toolSearchTool(many);
    expect(search.description).toContain("page 1 of 3");
    expect(search.description).not.toContain("mcp__big__t200");
    const page3 = await run([], "", search).then(() => search.execute({ query: "", page: 3 } as never, {} as never));
    expect(page3.content as string).toContain("page 3 of 3");
    expect(page3.content as string).toContain("mcp__big__t249");
    expect(page3.content as string).not.toContain("mcp__big__t0,");
    const live: AgentTool[] = [];
    await run(live, "select:mcp__big__t249", search);
    expect(live.map((t) => t.name)).toEqual(["mcp__big__t249"]);
  });
  it("offers no page argument when everything fits in the list", () => {
    expect(JSON.stringify(toolSearchTool(deferred).parameters)).not.toContain("page");
  });
  it("estimates schema size", () => expect(toolTokens(deferred)).toBeGreaterThan(20));
});
