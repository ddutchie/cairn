import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject } from "../db/queries";
import { createAutomation, createAutomationRun, type Automation, type AutomationRun } from "../db/automation-queries";
import { listPendingApprovals, parkApproval, resolveApproval } from "../db/approval-queries";
import { makeApprovalGate, waitForApproval, isReadTool, isExternalTool } from "./automation-approval";

let db: Database.Database;
let automation: Automation;
let run: AutomationRun;

function makeAutomation(
  approvalMode: "auto" | "ask",
  requires: Array<{ kind: "mcp" | "service"; name: string }> = [],
  standingRules: Array<{ tool: string; target?: string }> = [],
): Automation {
  const a = createAutomation(db, {
    workspaceId: "ws-1",
    projectId: "proj-1",
    name: "Test",
    instructions: "Do something",
    scheduleKind: "every",
    scheduleExpr: "every 1 hour",
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    approvalMode,
    requires,
    standingRules,
  });
  return a;
}

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws-1", name: "W" });
  createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "P" });
  automation = makeAutomation("ask");
  run = createAutomationRun(db, automation.id, "running");
});

afterEach(() => {
  db.close();
});

/** Poll until the gate has parked an approval (or a short deadline is hit). */
async function waitForPending(): Promise<ReturnType<typeof listPendingApprovals>> {
  for (let i = 0; i < 100; i++) {
    const items = listPendingApprovals(db);
    if (items.length > 0) return items;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("approval was never parked");
}

describe("automation approval gate", () => {
  it("auto mode still yields a gate (run_script must never be auto-approved)", async () => {
    const a = makeAutomation("auto");
    const gate = makeApprovalGate(db, run, a);
    expect(gate).toBeDefined();
    // Data tools run freely in auto mode.
    const res = await gate("create_task", { title: "Ship it" });
    expect(res.allow).toBe(true);
  });

  it("classifies read vs write tools", () => {
    expect(isReadTool("get_note")).toBe(true);
    expect(isReadTool("list_overdue_tasks")).toBe(true);
    expect(isReadTool("search_notes")).toBe(true);
    expect(isReadTool("create_task")).toBe(false);
    expect(isReadTool("ensure_note")).toBe(false);
  });

  it("classifies external (namespaced mcp/svc) tools", () => {
    expect(isExternalTool("mcp__srv1__linear_search_issues")).toBe(true);
    expect(isExternalTool("svc__s1__brave_web_search")).toBe(true);
    expect(isExternalTool("create_task")).toBe(false);
    expect(isExternalTool("get_note")).toBe(false);
  });

  it("allows read tools immediately in ask mode", async () => {
    const gate = makeApprovalGate(db, run, automation)!;
    const res = await gate("get_note", {});
    expect(res.allow).toBe(true);
  });

  it("parks a write tool and allows it once approved", async () => {
    const gate = makeApprovalGate(db, run, automation)!;
    const promise = gate("create_task", { title: "Ship it" });

    const pending = await waitForPending();
    expect(pending.length).toBe(1);
    expect(pending[0].tool).toBe("create_task");
    expect(pending[0].runId).toBe(run.id);

    resolveApproval(db, pending[0].id, "approved_once");
    const res = await promise;
    expect(res.allow).toBe(true);
  });

  it("denies a write tool when the user denies", async () => {
    const gate = makeApprovalGate(db, run, automation)!;
    const promise = gate("create_task", { title: "Nope" });

    const pending = await waitForPending();
    resolveApproval(db, pending[0].id, "denied");
    const res = await promise;
    expect(res.allow).toBe(false);
    expect(res.reason).toContain("denied");
  });

  it("fails closed on timeout", async () => {
    // APPROVAL_POLL_MS is 1s; use waitForApproval directly with a tiny timeout.
    const item = parkApproval(db, {
      runId: run.id,
      tool: "create_task",
      args: {},
    });
    const res = await waitForApproval(db, item.id, 50);
    expect(res).toBeNull();
    const after = listPendingApprovals(db);
    expect(after.length).toBe(0); // timed out → resolved as denied
  });

  it("connector-aware auto automation still gates EXTERNAL tools", async () => {
    const a = makeAutomation("auto", [{ kind: "mcp", name: "Linear" }]);
    const gate = makeApprovalGate(db, run, a)!;
    expect(gate).toBeDefined();

    // External tool call → parked for approval.
    const promise = gate("mcp__srv1__linear_create_issue", { title: "X" });
    const pending = await waitForPending();
    expect(pending[0].tool).toBe("mcp__srv1__linear_create_issue");

    resolveApproval(db, pending[0].id, "approved_once");
    expect((await promise).allow).toBe(true);
  });

  it("connector-aware auto automation lets built-in data tools run freely", async () => {
    const a = makeAutomation("auto", [{ kind: "mcp", name: "Linear" }]);
    const gate = makeApprovalGate(db, run, a)!;
    // Built-in write tools are NOT parked — only external calls are gated.
    const res = await gate("create_task", { title: "Ship it" });
    expect(res.allow).toBe(true);
    expect(listPendingApprovals(db).length).toBe(0);
  });

  it("data-only auto automation yields a gate but never parks data tools", async () => {
    const a = makeAutomation("auto");
    const gate = makeApprovalGate(db, run, a)!;
    const res = await gate("create_task", { title: "Ship it" });
    expect(res.allow).toBe(true);
    expect(listPendingApprovals(db).length).toBe(0);
  });

  describe("run_script gating", () => {
    it("parks run_script in AUTO mode (EXEC is never silently auto-approved)", async () => {
      const a = makeAutomation("auto");
      const gate = makeApprovalGate(db, run, a)!;
      const promise = gate("run_script", { name: "generate_images", args: ["-prompt", "news"] });

      const pending = await waitForPending();
      expect(pending[0].tool).toBe("run_script");

      resolveApproval(db, pending[0].id, "approved_once");
      expect((await promise).allow).toBe(true);
    });

    it("parks run_script in ASK mode too", async () => {
      const gate = makeApprovalGate(db, run, automation)!;
      const promise = gate("run_script", { name: "generate_images" });

      const pending = await waitForPending();
      expect(pending[0].tool).toBe("run_script");

      resolveApproval(db, pending[0].id, "approved_once");
      expect((await promise).allow).toBe(true);
    });

    it("allows run_script without parking when a script-scoped standing rule matches", async () => {
      const a = makeAutomation("auto", [], [{ tool: "run_script", target: "generate_images" }]);
      const gate = makeApprovalGate(db, run, a)!;
      const res = await gate("run_script", { name: "generate_images" });
      expect(res.allow).toBe(true);
      expect(listPendingApprovals(db).length).toBe(0);
    });

    it("does not let a standing rule for one script auto-allow a different script", async () => {
      const a = makeAutomation("auto", [], [{ tool: "run_script", target: "generate_images" }]);
      const gate = makeApprovalGate(db, run, a)!;
      const promise = gate("run_script", { name: "fetch_data" });
      const pending = await waitForPending();
      expect(pending[0].args.name).toBe("fetch_data");
      resolveApproval(db, pending[0].id, "approved_once");
      await promise;
    });
  });
});
