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
  listRecentAutomationRuns,
  hasInFlightRun,
  countRunningAutomationRuns,
  recoverInterruptedRuns,
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

  it("persists env vars as JSON (secret values stay null in the row)", () => {
    const a = createAutomation(db, makeInput({
      env: [
        { name: "PLAIN", value: "abc", secret: false },
        { name: "SECRET_KEY", secret: true },
      ],
    }));
    expect(getAutomationById(db, a.id)!.env).toEqual([
      { name: "PLAIN", value: "abc", secret: false },
      { name: "SECRET_KEY", secret: true },
    ]);
    const updated = updateAutomation(db, a.id, { env: [{ name: "PLAIN", value: "xyz", secret: false }] });
    expect(updated!.env).toEqual([{ name: "PLAIN", value: "xyz", secret: false }]);
  });

  it("never persists a secret value to the row, even if a caller passes one", () => {
    // A stray caller passing { secret: true, value: "plaintext" } must not have
    // that plaintext survive in the database (secrets live in the keychain).
    const a = createAutomation(db, makeInput({
      env: [
        { name: "API_KEY", secret: true, value: "super-secret" },
        { name: "PLAIN", secret: false, value: "ok" },
      ],
    }));
    // Read path: no value returned for the secret.
    expect(getAutomationById(db, a.id)!.env).toEqual([
      { name: "API_KEY", secret: true },
      { name: "PLAIN", value: "ok", secret: false },
    ]);
    // Raw row: the serialized env contains no secret value.
    const row = db.prepare("SELECT env FROM automations WHERE id = ?").get(a.id) as { env: string };
    expect(row.env).toContain('"name":"API_KEY","secret":true');
    expect(row.env).not.toContain("super-secret");

    // Same defence on update.
    updateAutomation(db, a.id, { env: [{ name: "TOKEN", secret: true, value: "leak-me" }] });
    const updated = getAutomationById(db, a.id)!;
    expect(updated.env).toEqual([{ name: "TOKEN", secret: true }]);
    const row2 = db.prepare("SELECT env FROM automations WHERE id = ?").get(a.id) as { env: string };
    expect(row2.env).not.toContain("leak-me");
  });

  it("reads a corrupt env column defensively (non-array JSON or null entries)", () => {
    // A valid-JSON but non-array value must not crash toAutomation — it reads
    // as no env vars.
    const a = createAutomation(db, makeInput());
    db.prepare("UPDATE automations SET env = ? WHERE id = ?").run('{"name":"oops","secret":true}', a.id);
    expect(getAutomationById(db, a.id)!.env).toEqual([]);

    // An array containing null/invalid entries: the valid entries survive and
    // secrets stay redacted; junk is dropped.
    db.prepare("UPDATE automations SET env = ? WHERE id = ?").run(
      JSON.stringify([
        null,
        "junk",
        { name: "SECRET", secret: true, value: "plaintext-in-row" },
        { name: "PLAIN", secret: false, value: "ok" },
        { name: 42 },
        {},
      ]),
      a.id,
    );
    expect(getAutomationById(db, a.id)!.env).toEqual([
      { name: "SECRET", secret: true },
      { name: "PLAIN", secret: false, value: "ok" },
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

  it("countRunningAutomationRuns counts in-flight runs", () => {
    const a = createAutomation(db, makeInput());
    const b = createAutomation(db, makeInput({ name: "Second" }));
    createAutomationRun(db, a.id, "running");
    createAutomationRun(db, b.id, "pending");
    createAutomationRun(db, a.id, "done");
    expect(countRunningAutomationRuns(db)).toBe(2);
  });

  it("recoverInterruptedRuns marks in-flight runs as interrupted so they unblock the automation", () => {
    const a = createAutomation(db, makeInput());
    const running = createAutomationRun(db, a.id, "running");
    const pending = createAutomationRun(db, a.id, "pending");
    const done = createAutomationRun(db, a.id, "done");

    expect(hasInFlightRun(db, a.id)).toBe(true); // would block future runs
    const recovered = recoverInterruptedRuns(db);

    expect(recovered).toBe(2); // running + pending, NOT done
    expect(getAutomationRunById(db, running.id)!.status).toBe("error");
    expect(getAutomationRunById(db, running.id)!.error).toContain("Interrupted");
    expect(getAutomationRunById(db, running.id)!.finishedAt).not.toBeNull();
    expect(getAutomationRunById(db, pending.id)!.status).toBe("error");
    expect(getAutomationRunById(db, done.id)!.status).toBe("done");
    expect(hasInFlightRun(db, a.id)).toBe(false); // automation can run again
  });

  it("recoverInterruptedRuns is idempotent and returns 0 when nothing is stuck", () => {
    const a = createAutomation(db, makeInput());
    createAutomationRun(db, a.id, "running");
    expect(recoverInterruptedRuns(db)).toBe(1);
    expect(recoverInterruptedRuns(db)).toBe(0);
  });

  it("bumps the automation run_count", () => {
    const a = createAutomation(db, makeInput());
    bumpAutomationRunCount(db, a.id);
    bumpAutomationRunCount(db, a.id);
    expect(getAutomationById(db, a.id)!.runCount).toBe(2);
  });
});

describe("listRecentAutomationRuns (Overview feed)", () => {
  it("returns project-scoped runs joined with the automation name, newest-first", () => {
    const a = createAutomation(db, makeInput({ name: "Weekly review" }));
    const r1 = createAutomationRun(db, a.id, "running");
    const r2 = createAutomationRun(db, a.id, "done");
    const rows = listRecentAutomationRuns(db, wsId, projectId);
    expect(rows.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(rows[0].automationName).toBe("Weekly review");
    expect(rows[0].automationProjectId).toBe(projectId);
  });

  it("excludes runs from workspace-scoped automations when projectId is supplied", () => {
    const projectAuto = createAutomation(db, makeInput({ name: "Project auto" }));
    const wsAuto = createAutomation(db, makeInput({ name: "Workspace auto", projectId: null }));
    createAutomationRun(db, projectAuto.id, "done");
    createAutomationRun(db, wsAuto.id, "done");
    const rows = listRecentAutomationRuns(db, wsId, projectId);
    expect(rows.every((r) => r.automationProjectId === projectId)).toBe(true);
    expect(rows.map((r) => r.automationName)).toEqual(["Project auto"]);
  });

  it("returns runs from all automations when projectId is omitted (workspace-wide)", () => {
    const projectAuto = createAutomation(db, makeInput({ name: "Project auto" }));
    const wsAuto = createAutomation(db, makeInput({ name: "Workspace auto", projectId: null }));
    createAutomationRun(db, projectAuto.id, "done");
    createAutomationRun(db, wsAuto.id, "done");
    const rows = listRecentAutomationRuns(db, wsId);
    expect(rows.map((r) => r.automationName).sort()).toEqual(["Project auto", "Workspace auto"]);
  });

  it("respects the limit", () => {
    const a = createAutomation(db, makeInput());
    for (let i = 0; i < 5; i++) createAutomationRun(db, a.id, "done");
    expect(listRecentAutomationRuns(db, wsId, projectId, 2)).toHaveLength(2);
  });

  it("scopes by workspace (other workspaces excluded)", () => {
    createWorkspace(db, { id: "ws-2", name: "Other" });
    createProject(db, { id: "proj-2", workspaceId: "ws-2", name: "Other Project" });
    const a1 = createAutomation(db, makeInput());
    const a2 = createAutomation(db, { ...makeInput(), workspaceId: "ws-2", projectId: "proj-2" });
    createAutomationRun(db, a1.id, "done");
    createAutomationRun(db, a2.id, "done");
    const rows = listRecentAutomationRuns(db, wsId, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].automationId).toBe(a1.id);
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
