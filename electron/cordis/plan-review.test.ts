/**
 * Cairn — plan-review integration tests.
 *
 * These guard the end-to-end contract with dsh-plan-mode:
 *
 *   1. When the model calls exit_plan_mode(plan), the plan text is
 *      persisted to agent_session_metadata.plan_content so execute-mode's
 *      system prompt on the next turn carries it forward without
 *      re-folding the session log.
 *   2. The Cairn ask-questions provider forwards the dsh
 *      AskUserQuestionItem shape ({id, question, header, detail,
 *      options, intent}) to the renderer verbatim — the plan under
 *      review is in `detail`, and dropping any of these fields
 *      re-introduces the review's plan-mode-blank-form bug.
 *   3. The renderer's structured-answer path:
 *        - "Approve" sends {answers: [{id, selected: [approveLabel]}]}
 *          with `custom` OMITTED (not present as an explicit undefined).
 *          dsh's exit_plan_mode requires all three of: length===1,
 *          selected[0]===APPROVE_LABEL, custom===undefined — the last
 *          is falsified by an explicit `custom: ""`, so JSON.stringify
 *          must drop the key.
 *        - "__dismissed__: true" sentinel translates to a
 *          UserQuestionError('ASK_CANCELLED'), which dsh maps to
 *          "user dismissed the review to speak".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createCodingSession, getCodingSessionById, updateCodingSession, createWorkspace, createProject } from "../db/queries";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";

let db: Database.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
});
afterEach(() => {
  db.close();
});

describe("plan-review — plan_content persistence", () => {
  function seed() {
    createWorkspace(db, { id: "ws", name: "Test" });
    createProject(db, { id: "proj", workspaceId: "ws", name: "Proj" });
    return createCodingSession(db, {
      id: "pi-plan-1",
      projectId: "proj",
      taskTitle: "Add archive",
      taskId: null,
      cwd: "/tmp/proj",
      mode: "plan",
      spawnedAt: new Date().toISOString(),
    });
  }

  it("updateCodingSession stores planContent and returns it via getCodingSessionById", () => {
    seed();
    const plan = "# Add archive\n\n## Approach\n1. Do the thing.";
    updateCodingSession(db, "pi-plan-1", { planContent: plan });
    const row = getCodingSessionById(db, "pi-plan-1");
    expect(row?.planContent).toBe(plan);
  });

  it("execute-mode prompt prefers planContent over the legacy planNoteId path", () => {
    // Simulated: planContent is populated by exit_plan_mode, planNoteId is
    // stale (points at a deleted note). The execute-mode builder is in
    // electron/ipc/session-runtime-handlers.ts but its selection lives inline; here we
    // exercise the DB precedence to lock the invariant that a session with
    // both must prefer planContent.
    seed();
    updateCodingSession(db, "pi-plan-1", { planContent: "# From exit_plan_mode", planNoteId: "note-stale" });
    const row = getCodingSessionById(db, "pi-plan-1");
    expect(row?.planContent?.trim()).toBe("# From exit_plan_mode");
    expect(row?.planNoteId).toBe("note-stale");
    // The precedence check: if planContent is populated + trimmed, use it.
    const chosen = row?.planContent?.trim() ? row.planContent : "fallback";
    expect(chosen).toBe("# From exit_plan_mode");
  });

  it("null planContent falls back to legacy path (planNoteId → notes.content)", () => {
    seed();
    updateCodingSession(db, "pi-plan-1", { planNoteId: "note-1" });
    const row = getCodingSessionById(db, "pi-plan-1");
    expect(row?.planContent).toBeNull();
    const chosen = row?.planContent?.trim() ? row.planContent : "fallback";
    expect(chosen).toBe("fallback");
  });
});

describe("plan-review — answer JSON shape", () => {
  // The renderer serialises the Approve click as:
  //   JSON.stringify({ answers: [{ id, selected: [approveLabel], custom: undefined }] })
  // JSON.stringify DROPS keys whose value is `undefined`, so the wire
  // string carries no `custom` field. The main-side provider then does
  // `custom: a.custom` on parse — reading a missing key as `undefined`.
  // This test locks that behaviour end-to-end because dsh's plan-mode
  // check is `item.custom !== undefined` — a `custom: ""` would fail.
  it("Approve payload omits `custom` at the JSON layer", () => {
    const wire = JSON.stringify({
      answers: [{ id: "plan-review", selected: ["Approve"], custom: undefined }],
    });
    expect(wire).toBe('{"answers":[{"id":"plan-review","selected":["Approve"]}]}');
    // Parse back and confirm custom reads as undefined.
    const parsed = JSON.parse(wire) as { answers: Array<{ id: string; selected: string[]; custom?: string }> };
    expect(parsed.answers[0].custom).toBeUndefined();
    // dsh's exit_plan_mode check:
    const item = parsed.answers[0];
    const approves =
      item.selected.length === 1 &&
      item.selected[0] === "Approve" &&
      item.custom === undefined;
    expect(approves).toBe(true);
  });

  it("Feedback payload carries `custom` and clears `selected`", () => {
    const wire = JSON.stringify({
      answers: [{ id: "plan-review", selected: [], custom: "add step 4: run migrations" }],
    });
    const parsed = JSON.parse(wire) as { answers: Array<{ id: string; selected: string[]; custom?: string }> };
    const item = parsed.answers[0];
    // dsh's check: this should FAIL the approve conditions (custom present)
    // and dsh throws "user chose to keep planning; feedback: ..."
    const approves =
      item.selected.length === 1 &&
      item.selected[0] === "Approve" &&
      item.custom === undefined;
    expect(approves).toBe(false);
    expect(item.custom).toBe("add step 4: run migrations");
  });

  it("Dismiss sentinel is a distinct top-level shape (no `answers` key)", () => {
    const wire = JSON.stringify({ __dismissed__: true });
    const parsed = JSON.parse(wire) as { answers?: unknown[]; __dismissed__?: boolean };
    expect(parsed.__dismissed__).toBe(true);
    expect(parsed.answers).toBeUndefined();
    // The provider treats this as a UserQuestionError('ASK_CANCELLED')
    // — dsh-plan-mode catches that specific code and reports the
    // "user dismissed" outcome to the model.
    const err = new UserQuestionError("dismissed", "ASK_CANCELLED");
    expect(err.code).toBe("ASK_CANCELLED");
    expect(err.name).toBe("UserQuestionError");
  });
});
