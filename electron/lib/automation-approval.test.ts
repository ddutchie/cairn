/**
 * Cairn — automation-approval unit tests (post-engine).
 *
 * The legacy `automation-approval.test.ts` (deleted in 90f0b960) covered a
 * runtime approval-inbox gate (`makeApprovalGate`/`waitForApproval`) that no
 * longer exists — the gate is now the engine approval waterfall
 * (electron/agent/cairn-plugins.ts) and the automation-specific auto-allow
 * transport (electron/lib/heartbeat-runner.ts). What DOES still live in this
 * module is a small set of security-relevant classifiers + a standing-rule
 * sanitiser that the manifest sync path calls on ingest, and the gate reads
 * on match. This file guards those.
 *
 * Restores the specific invariants the deleted suite proved:
 *   - run_script / bash NEVER receive a target-less standing rule (wildcard
 *     grant of arbitrary execution) — even if the manifest tries;
 *   - read-only tools are classified so the gate can waive them without
 *     bothering the user;
 *   - external (mcp__ / svc__) tools ARE classified as gate-worthy;
 *   - the "always allow" target extracted for a call matches what the
 *     resolve handler will persist (so grant/match can't disagree).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject } from "../db/queries";
import { createAutomation, createAutomationRun, getAutomationById, type Automation, type AutomationRun } from "../db/automation-queries";
import {
  isExternalTool,
  isReadTool,
  standingRuleCoversTool,
  standingRuleTarget,
  recordStandingAllowance,
  sanitizeStandingRules,
  APPROVAL_TIMEOUT_MS,
} from "./automation-approval";

let db: Database.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

function seedRun(): { automation: Automation; run: AutomationRun } {
  createWorkspace(db, { id: "ws-1", name: "Test" });
  createProject(db, { id: "proj-1", workspaceId: "ws-1", name: "Proj" });
  const a = createAutomation(db, {
    workspaceId: "ws-1",
    projectId: "proj-1",
    name: "test",
    description: "",
    instructions: "test instructions",
    scheduleKind: "manual",
    scheduleExpr: "manual",
    nextRunAt: new Date().toISOString(),
    approvalMode: "ask",
    requires: [],
    standingRules: [],
  } as never);
  const r = createAutomationRun(db, a.id);
  return { automation: a, run: r };
}

describe("isReadTool", () => {
  it("classifies get_/list_/search_ tools as read-only", () => {
    for (const name of ["get_note", "list_folders", "search_notes", "search_tasks", "get_project_context_pack"]) {
      expect(isReadTool(name), name).toBe(true);
    }
  });
  it("classifies mutating tools as NOT read-only", () => {
    for (const name of ["ensure_note", "create_task", "delete_note", "bash", "write", "run_script", "update_task"]) {
      expect(isReadTool(name), name).toBe(false);
    }
  });
  it("treats codebase_query as read-only (READ in shared/agent/tool-risk.ts)", () => {
    expect(isReadTool("codebase_query")).toBe(true);
  });
});

describe("isExternalTool", () => {
  it("classifies mcp__ / svc__ tools as external (gate-worthy)", () => {
    expect(isExternalTool("mcp__foo__bar")).toBe(true);
    expect(isExternalTool("svc__github__create_issue")).toBe(true);
  });
  it("classifies built-in Cairn tools as internal", () => {
    for (const name of ["get_note", "bash", "write", "run_script", "todo_write"]) {
      expect(isExternalTool(name), name).toBe(false);
    }
  });
});

describe("standingRuleTarget", () => {
  it("run_script grants the script NAME, never blanket shell", () => {
    expect(standingRuleTarget("run_script", { name: "build.sh" })).toBe("build.sh");
    expect(standingRuleTarget("run_script", {})).toBeUndefined();
    // Explicit empty string collapses to undefined so it can't record ""
    // as a wildcard.
    expect(standingRuleTarget("run_script", { name: "" })).toBeUndefined();
  });
  it("bash grants the exact command string, never a shell wildcard", () => {
    expect(standingRuleTarget("bash", { command: "npm test" })).toBe("npm test");
    expect(standingRuleTarget("bash", {})).toBeUndefined();
    expect(standingRuleTarget("bash", { command: "" })).toBeUndefined();
  });
  it("other tools grant a natural identifier (path / noteId / cardId / title)", () => {
    expect(standingRuleTarget("write", { path: "src/foo.ts" })).toBe("src/foo.ts");
    expect(standingRuleTarget("ensure_note", { noteId: "n-1" })).toBe("n-1");
    expect(standingRuleTarget("update_task", { cardId: "c-1" })).toBe("c-1");
    expect(standingRuleTarget("ensure_note", { title: "Meeting notes" })).toBe("Meeting notes");
    expect(standingRuleTarget("write", {})).toBeUndefined();
  });
});

describe("recordStandingAllowance", () => {
  it("REFUSES to record a target-less rule for run_script (no wildcard grants)", () => {
    const { run } = seedRun();
    recordStandingAllowance(db, run.id, "run_script", {});
    const after = getAutomationById(db, run.automationId);
    expect(after?.standingRules).toEqual([]);
  });

  it("REFUSES to record a target-less rule for bash (no wildcard grants)", () => {
    const { run } = seedRun();
    recordStandingAllowance(db, run.id, "bash", {});
    const after = getAutomationById(db, run.automationId);
    expect(after?.standingRules).toEqual([]);
  });

  it("records a target-scoped run_script rule and dedupes on repeat", () => {
    const { run } = seedRun();
    recordStandingAllowance(db, run.id, "run_script", { name: "build.sh" });
    recordStandingAllowance(db, run.id, "run_script", { name: "build.sh" });
    const after = getAutomationById(db, run.automationId);
    expect(after?.standingRules).toEqual([{ tool: "run_script", target: "build.sh" }]);
  });

  it("records a target-scoped bash rule with the exact command", () => {
    const { run } = seedRun();
    recordStandingAllowance(db, run.id, "bash", { command: "npm test" });
    const after = getAutomationById(db, run.automationId);
    expect(after?.standingRules).toEqual([{ tool: "bash", target: "npm test" }]);
  });

  it("records a non-executing tool rule with or without a target", () => {
    const { run } = seedRun();
    recordStandingAllowance(db, run.id, "ensure_note", { noteId: "n-1" });
    recordStandingAllowance(db, run.id, "write", {}); // target-less non-exec is allowed
    const after = getAutomationById(db, run.automationId);
    expect(after?.standingRules).toEqual([
      { tool: "ensure_note", target: "n-1" },
      { tool: "write" },
    ]);
  });

  it("is a no-op for an unknown run id (safe when the run was deleted)", () => {
    // No throw, no persistence.
    recordStandingAllowance(db, "nonexistent-run", "bash", { command: "npm test" });
    expect(true).toBe(true);
  });
});

describe("sanitizeStandingRules", () => {
  it("returns empty on non-array input", () => {
    expect(sanitizeStandingRules(null)).toEqual({ rules: [], dropped: [] });
    expect(sanitizeStandingRules("not a rule")).toEqual({ rules: [], dropped: [] });
    expect(sanitizeStandingRules(undefined)).toEqual({ rules: [], dropped: [] });
  });

  it("drops rules missing a tool name (malformed manifest)", () => {
    const res = sanitizeStandingRules([
      { tool: "" },
      { target: "orphan" },
      null,
      "not an object",
      { tool: "  " },
    ]);
    expect(res.rules).toEqual([]);
    expect(res.dropped).toHaveLength(5);
  });

  it("DROPS a target-less run_script rule with a user-visible reason", () => {
    const res = sanitizeStandingRules([{ tool: "run_script" }]);
    expect(res.rules).toEqual([]);
    expect(res.dropped[0]).toMatch(/run_script/);
    expect(res.dropped[0]).toMatch(/blanket-approve/);
  });

  it("DROPS a target-less bash rule with a user-visible reason", () => {
    const res = sanitizeStandingRules([{ tool: "bash" }]);
    expect(res.rules).toEqual([]);
    expect(res.dropped[0]).toMatch(/bash/);
  });

  it("passes through target-scoped run_script / bash rules", () => {
    const res = sanitizeStandingRules([
      { tool: "run_script", target: "build.sh" },
      { tool: "bash", target: "npm test" },
    ]);
    expect(res.rules).toEqual([
      { tool: "run_script", target: "build.sh" },
      { tool: "bash", target: "npm test" },
    ]);
    expect(res.dropped).toEqual([]);
  });

  it("passes through non-exec rules with or without a target, trimming whitespace", () => {
    const res = sanitizeStandingRules([
      { tool: "ensure_note", target: "  n-1  " },
      { tool: "write" },
      { tool: "  update_task  ", target: "  " }, // empty target after trim → dropped target
    ]);
    expect(res.rules).toEqual([
      { tool: "ensure_note", target: "n-1" },
      { tool: "write" },
      { tool: "update_task" },
    ]);
    expect(res.dropped).toEqual([]);
  });
});

describe("APPROVAL_TIMEOUT_MS", () => {
  it("is 10 minutes (fail-closed budget for the interactive HITL seam)", () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(10 * 60_000);
  });
});

describe("standingRuleCoversTool (legacy sub-action matching)", () => {
  // Legacy (pre-consolidation) rules name the per-operation tool; they keep
  // applying to the consolidated tool that replaced them — but ONLY for the
  // matching sub-action. A rule saved for `delete_note` must never approve
  // `delete {type:"project"}`, a `tag_note` rule must never approve an
  // `update_notes` rename/move, and a `claim_task` rule must never approve a
  // `task_progress {action:"log", moveTo:"done"}`.
  it("exact tool-name matches are unaffected", () => {
    expect(standingRuleCoversTool("delete", "delete", { type: "project", id: "p1" })).toBe(true);
    expect(standingRuleCoversTool("update_notes", "update_notes", { noteIds: ["n1"] })).toBe(true);
    expect(standingRuleCoversTool("delete_note", "delete_note")).toBe(true);
  });

  it("delete_note rules only cover note deletes", () => {
    expect(standingRuleCoversTool("delete_note", "delete", { type: "note", id: "n1" })).toBe(true);
    expect(standingRuleCoversTool("delete_note", "delete", { type: "project", id: "p1" })).toBe(false);
    expect(standingRuleCoversTool("delete_note", "delete", { type: "task", id: "c1" })).toBe(false);
    expect(standingRuleCoversTool("delete_note", "delete", { type: "flow_node", id: "f1" })).toBe(false);
    expect(standingRuleCoversTool("delete_task", "delete", { type: "task", id: "c1" })).toBe(true);
    expect(standingRuleCoversTool("delete_task", "delete", { type: "note", id: "n1" })).toBe(false);
    expect(standingRuleCoversTool("delete_idea_flow_node", "delete", { type: "flow_node", id: "f1" })).toBe(true);
    expect(standingRuleCoversTool("delete_idea_flow_node", "delete", { type: "note", id: "n1" })).toBe(false);
  });

  it("update_notes rules only cover their sub-action", () => {
    expect(standingRuleCoversTool("tag_note", "update_notes", { noteIds: ["n1"], tagNames: ["x"] })).toBe(true);
    expect(standingRuleCoversTool("tag_note", "update_notes", { noteIds: ["n1"], title: "New" })).toBe(false);
    expect(standingRuleCoversTool("tag_note", "update_notes", { noteIds: ["n1"], folder: "f" })).toBe(false);
    expect(standingRuleCoversTool("rename_note", "update_notes", { noteIds: ["n1"], title: "New" })).toBe(true);
    expect(standingRuleCoversTool("rename_note", "update_notes", { noteIds: ["n1"], folder: "f" })).toBe(false);
    expect(standingRuleCoversTool("bulk_move_notes", "update_notes", { noteIds: ["n1"], folder: "f" })).toBe(true);
    expect(standingRuleCoversTool("link_note_to_task", "update_notes", { noteIds: ["n1"], linkCardIds: ["c1"] })).toBe(true);
    expect(standingRuleCoversTool("link_note_to_task", "update_notes", { noteIds: ["n1"], unlinkCardIds: ["c1"] })).toBe(false);
  });

  it("task_progress rules only cover their action", () => {
    expect(standingRuleCoversTool("claim_task", "task_progress", { cardId: "c1", action: "claim" })).toBe(true);
    expect(standingRuleCoversTool("claim_task", "task_progress", { cardId: "c1", action: "log", moveTo: "done" })).toBe(false);
    expect(standingRuleCoversTool("add_task_progress", "task_progress", { cardId: "c1", action: "log" })).toBe(true);
    expect(standingRuleCoversTool("add_task_progress", "task_progress", { cardId: "c1", action: "claim" })).toBe(false);
  });

  it("update_tasks rules only cover their sub-action", () => {
    expect(standingRuleCoversTool("tag_task", "update_tasks", { cardIds: ["c1"], tagNames: ["x"] })).toBe(true);
    expect(standingRuleCoversTool("tag_task", "update_tasks", { cardIds: ["c1"], priority: "high" })).toBe(false);
    expect(standingRuleCoversTool("bulk_update_task_status", "update_tasks", { cardIds: ["c1"], columnType: "done" })).toBe(true);
    expect(standingRuleCoversTool("bulk_update_task_status", "update_tasks", { cardIds: ["c1"], priority: "high" })).toBe(false);
    expect(standingRuleCoversTool("update_task", "update_tasks", { cardIds: ["c1"], priority: "high" })).toBe(true);
    expect(standingRuleCoversTool("update_task", "update_tasks", { cardIds: ["c1"], tagNames: ["x"] })).toBe(false);
  });

  it("edit_idea_flow rules only cover their op kind", () => {
    const addNode = { projectId: "p", ops: [{ op: "add_node" }] };
    const delEdge = { projectId: "p", ops: [{ op: "delete_edge" }] };
    expect(standingRuleCoversTool("create_idea_flow_node", "edit_idea_flow", addNode)).toBe(true);
    expect(standingRuleCoversTool("create_idea_flow_node", "edit_idea_flow", delEdge)).toBe(false);
    expect(standingRuleCoversTool("delete_idea_flow_edge", "edit_idea_flow", delEdge)).toBe(true);
    expect(standingRuleCoversTool("layout_idea_flow", "edit_idea_flow", { projectId: "p", ops: [], layout: "LR" })).toBe(true);
    expect(standingRuleCoversTool("layout_idea_flow", "edit_idea_flow", addNode)).toBe(false);
  });

  it("unrelated legacy tools never cover", () => {
    expect(standingRuleCoversTool("delete_note", "update_notes", { noteIds: ["n1"] })).toBe(false);
    expect(standingRuleCoversTool("claim_task", "delete", { type: "task", id: "c1" })).toBe(false);
  });
});
