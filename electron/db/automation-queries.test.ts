import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace, createProject } from "./queries";
import {
  createAutomation,
  getAutomationById,
  listAutomations,
  updateAutomation,
  deleteAutomation,
  listDueAutomations,
  createAutomationRun,
  getAutomationRunById,
  updateAutomationRun,
  listAutomationRuns,
  hasInFlightRun,
  bumpAutomationRunCount,
  type AutomationInput,
} from "./automation-queries";

let db: Database.Database;
let wsId: string;
let projectId: string;

function makeInput(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    workspaceId: wsId,
    projectId,
    name: "Weekly review",
    description: "Summarise the week",
    instructions: "List this week's Done cards and draft a review note.",
    scheduleKind: "every",
    scheduleExpr: "every 24 hours",
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  wsId = "ws-1";
  projectId = "proj-1";
  createWorkspace(db, { id: wsId, name: "Workspace" });
  createProject(db, { id: projectId, workspaceId: wsId, name: "Project" });
});

describe("automation CRUD", () => {
  it("creates and reads an automation", () => {
    const a = createAutomation(db, makeInput());
    const got = getAutomationById(db, a.id);
    expect(got!.name).toBe("Weekly review");
    expect(got!.scheduleKind).toBe("every");
    expect(got!.workspaceId).toBe(wsId);
    expect(got!.projectId).toBe(projectId);
    expect(got!.runCount).toBe(0);
    expect(got!.enabled).toBe(true);
    expect(listAutomations(db, wsId).length).toBe(1);
  });

  it("persists standing rules as JSON", () => {
    const a = createAutomation(db, makeInput({ standingRules: [{ tool: "create_task" }, { tool: "tag_note", target: "review" }] }));
    expect(getAutomationById(db, a.id)!.standingRules).toEqual([
      { tool: "create_task" },
      { tool: "tag_note", target: "review" },
    ]);
  });

  it("updates partial fields", () => {
    const a = createAutomation(db, makeInput());
    const updated = updateAutomation(db, a.id, { name: "Renamed", enabled: false });
    expect(updated!.name).toBe("Renamed");
    expect(updated!.enabled).toBe(false);
    expect(updated!.instructions).toBe("List this week's Done cards and draft a review note.");
  });

  it("deletes an automation (and cascades its runs)", () => {
    const a = createAutomation(db, makeInput());
    createAutomationRun(db, a.id, "done");
    expect(deleteAutomation(db, a.id)).toBe(true);
    expect(getAutomationById(db, a.id)).toBeNull();
    const row = db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("updateAutomation on a missing id returns null", () => {
    expect(updateAutomation(db, "nope", { name: "x" })).toBeNull();
  });
});

describe("due lookup + run history", () => {
  it("returns only enabled automations due at-or-before now", () => {
    const due = createAutomation(db, makeInput());
    createAutomation(db, makeInput({ nextRunAt: new Date(Date.now() + 60_000).toISOString() }));
    createAutomation(db, makeInput({ enabled: false }));
    const found = listDueAutomations(db, new Date().toISOString());
    expect(found.map((a) => a.id)).toEqual([due.id]);
  });

  it("creates runs with pending status and lists newest-first", () => {
    const a = createAutomation(db, makeInput());
    const r1 = createAutomationRun(db, a.id, "running");
    const r2 = createAutomationRun(db, a.id, "done");
    expect(getAutomationRunById(db, r1.id)!.status).toBe("running");
    const runs = listAutomationRuns(db, a.id);
    expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("updates a run's status + finished_at", () => {
    const a = createAutomation(db, makeInput());
    const r = createAutomationRun(db, a.id, "running");
    const updated = updateAutomationRun(db, r.id, { status: "done", resultNoteId: "note-1", error: null });
    expect(updated!.status).toBe("done");
    expect(updated!.resultNoteId).toBe("note-1");
    expect(updated!.finishedAt).not.toBeNull();
  });

  it("hasInFlightRun detects pending/running but not finished", () => {
    const a = createAutomation(db, makeInput());
    const r = createAutomationRun(db, a.id, "running");
    expect(hasInFlightRun(db, a.id)).toBe(true);
    updateAutomationRun(db, r.id, { status: "done" });
    expect(hasInFlightRun(db, a.id)).toBe(false);
  });

  it("bumps the automation run_count", () => {
    const a = createAutomation(db, makeInput());
    bumpAutomationRunCount(db, a.id);
    bumpAutomationRunCount(db, a.id);
    expect(getAutomationById(db, a.id)!.runCount).toBe(2);
  });
});

describe("schema v32", () => {
  it("creates both tables with the expected shape", () => {
    const cols = db.prepare("PRAGMA table_info(automations)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([
      "id", "workspace_id", "project_id", "name", "instructions",
      "schedule_kind", "schedule_expr", "timezone", "next_run_at",
      "enabled", "max_runs", "run_count", "standing_rules", "source",
      "community_id", "created_at", "updated_at",
    ]));
    const runCols = db.prepare("PRAGMA table_info(automation_runs)").all() as { name: string }[];
    expect(runCols.map((c) => c.name)).toEqual(expect.arrayContaining([
      "id", "automation_id", "status", "result_note_id", "started_at", "finished_at", "error", "scratch", "created_at",
    ]));
  });
});
