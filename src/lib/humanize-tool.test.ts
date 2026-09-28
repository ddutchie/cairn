import { describe, expect, it } from "vitest";
import { humanizeTool, humanizedText } from "./humanize-tool";

describe("humanizeTool", () => {
  it("turns coding tools into concise English summaries", () => {
    expect(humanizedText("write", { path: "runbook.md" })).toBe("Wrote runbook.md");
    expect(humanizedText("grep", { pattern: "retry" })).toBe("Searched the code for “retry”");
  });

  it("prefers the model's description for shell commands", () => {
    expect(humanizedText("bash", { command: "rm -rf tmp", description: "Cleaned the generated files" }))
      .toBe("Cleaned the generated files");
  });

  it("handles unknown and external tools without exposing an argument dump", () => {
    expect(humanizeTool("svc__slack__post_message", { channel: "alerts", text: "hello" }))
      .toEqual({ pre: "Post message", obj: "alerts" });
    expect(humanizedText("mystery_tool")).toBe("Used mystery_tool");
  });

  it("names the connector action and its target, camelCase included", () => {
    expect(humanizeTool("mcp__atl1__createConfluencePage", { spaceId: "123", title: "Q3 plan", body: "…" }))
      .toEqual({ pre: "Create confluence page", obj: "Q3 plan" });
    expect(humanizeTool("mcp__atl1__getAccessibleAtlassianResources", {}))
      .toEqual({ pre: "Get accessible atlassian resources" });
    expect(humanizeTool("mcp__BZ__search-designs", { query: "logo" })).toEqual({ pre: "Search designs", obj: "logo" });
  });

  it("names the loaded skill", () => {
    expect(humanizedText("skill", { name: "pdf" })).toBe("Loaded skill pdf");
  });

  it("bounds long display objects", () => {
    const result = humanizeTool("read", { path: "a".repeat(300) });
    expect(result.obj).toHaveLength(160);
    expect(result.obj?.endsWith("…")).toBe(true);
  });
});
