import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace, createProject } from "./queries";
import { getOrCreateFlow, createFlowNode, createFlowEdge, collectFlowSummaryInputs, getFlowIdForNode } from "./flow-queries";

describe("collectFlowSummaryInputs", () => {
  let db: Database.Database;
  let flowId: string;
  const node = (id: string, type: string, data: Record<string, unknown> = {}) =>
    createFlowNode(db, { id, flowId, type, x: 0, y: 0, data });
  const edge = (id: string, a: string, b: string) => createFlowEdge(db, { id, flowId, sourceNodeId: a, targetNodeId: b });

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    createWorkspace(db, { id: "ws1", name: "W" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "P" });
    flowId = getOrCreateFlow(db, "p1").id;
  });

  it("walks both edge directions but not through other summary nodes", () => {
    node("s", "ai_summary");
    node("a", "idea", { title: "A", body: "alpha" });
    node("b", "url", { url: "https://x" });
    node("peer", "ai_summary");
    node("hidden", "idea", { title: "Hidden" });
    edge("e1", "s", "a");
    edge("e2", "b", "a"); // reached via a, reverse direction
    edge("e3", "s", "peer");
    edge("e4", "peer", "hidden"); // behind another summary node → excluded

    const out = collectFlowSummaryInputs(db, "s");
    expect(out.parts).toEqual(["[Idea] A: alpha", "[URL] https://x"]);
    expect(out.projectId).toBe("p1");
    expect(out.workspaceId).toBe("ws1");
  });

  it("throws user-facing errors for bad input", () => {
    node("i", "idea");
    node("s", "ai_summary");
    expect(() => collectFlowSummaryInputs(db, "nope")).toThrow("Node not found");
    expect(() => collectFlowSummaryInputs(db, "i")).toThrow("only available on ai_summary");
    expect(() => collectFlowSummaryInputs(db, "s")).toThrow("Connect this node");
  });

  it("getFlowIdForNode resolves the owning flow", () => {
    node("i", "idea");
    expect(getFlowIdForNode(db, "i")).toBe(flowId);
    expect(getFlowIdForNode(db, "missing")).toBeNull();
  });
});
