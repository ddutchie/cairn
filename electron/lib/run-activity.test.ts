import { describe, expect, it } from "vitest";
import { currentRunActivity, noteRunActivity } from "./run-activity";

describe("run activity", () => {
  it("follows a run from start to its last tool call and clears when it finishes", () => {
    expect(currentRunActivity("a1")).toBeNull();
    noteRunActivity("a1", "started", {});
    expect(currentRunActivity("a1")).toEqual({ tool: null });
    noteRunActivity("a1", "tool", { tool: "mcp__s1__search", label: "Slack · Search", args: { query: "release" }, status: "start" });
    noteRunActivity("a1", "tool", { tool: "mcp__s1__search", status: "end" });
    expect(currentRunActivity("a1")).toEqual({ tool: "mcp__s1__search", label: "Slack · Search", args: { query: "release" } });
    noteRunActivity("a1", "finished", {});
    expect(currentRunActivity("a1")).toBeNull();
  });
});
