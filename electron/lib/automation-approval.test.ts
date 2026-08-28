/**
 * Cairn — automation-approval unit tests (post-Cordis).
 *
 * The pre-Cordis `automation-approval.test.ts` (deleted in 90f0b960) covered a
 * runtime approval-inbox gate (`makeApprovalGate`/`waitForApproval`) that no
 * longer exists — the gate is now the Cordis approval waterfall
 * (electron/cordis/cairn-plugins.ts) and the automation-specific auto-allow
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
