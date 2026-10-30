import { describe, expect, it } from "vitest";
import { decide, type PolicyState } from "./policy";

const state = (over: Partial<PolicyState> = {}): PolicyState => ({ mode: "yolo", deniedTools: [], rules: [], workspaceRoot: "/ws", recent: [], doomAcked: new Set(), ...over });

describe("externalAlwaysAsks", () => {
  it("yolo allows EXTERNAL by default, asks when the flag is set", () => {
    const call = { name: "mcp__x__y", risk: { class: "EXTERNAL" as const } };
    expect(decide(call, "s", state()).kind).toBe("allow");
    expect(decide(call, "s", state({ externalAlwaysAsks: true })).kind).toBe("ask");
  });
  it("does not affect other risk classes", () => {
    expect(decide({ name: "bash", risk: { class: "EXEC", command: "ls -la" } }, "s", state({ externalAlwaysAsks: true })).kind).toBe("allow");
  });
});
