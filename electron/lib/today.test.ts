import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  enableToday, findTodayAutomation, getTodayState, includedProjects, readTodaySettings, saveTodayBrief, todayAllowsTool, todayToolFilter, writeTodaySettings,
} from "./today";
import { factsForPrompt, projectFacts } from "./today-facts";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createAutomation, createAutomationRun, listAutomations, updateAutomationRun } from "../db/automation-queries";
import { createCard, createColumn } from "../db/board-queries";
import { TODAY_COMMUNITY_ID } from "../../shared/today/brief";
import { emptyBrief } from "../../shared/today/brief-edit";

describe("todayAllowsTool", () => {
  it("allows Cairn and engine reads", () => {
    for (const t of ["list_tasks", "get_item", "search_notes", "read", "grep", "web_fetch"]) expect(todayAllowsTool(t)).toBe(true);
  });
  it("denies local writes and shell", () => {
    for (const t of ["create_task", "edit_note", "bash", "write", "edit", "delete"]) expect(todayAllowsTool(t)).toBe(false);
  });
  it("allows read-like connector tools", () => {
    for (const t of ["mcp__slack__search_messages", "mcp__workiq__ask_work_iq", "mcp__github__list_pull_requests", "mcp__atlassian__searchJiraIssuesUsingJql", "mcp__atlassian__getJiraIssue"]) {
      expect(todayAllowsTool(t)).toBe(true);
    }
  });
  it("denies connector tools that change things, even with a read verb", () => {
    for (const t of ["mcp__slack__send_message", "mcp__slack__post_message", "mcp__github__create_pull_request_review", "mcp__outlook__get_and_delete_mail", "mcp__x__do_thing", "mcp__atlassian__editJiraIssue", "mcp__atlassian__createConfluenceContent"]) {
      expect(todayAllowsTool(t)).toBe(false);
    }
  });
  it("keeps every tool a real Today run used (server ids, not names, in connector tools)", () => {
    for (const t of [
      "get_context", "get_user_writing_style", "search_tasks", "search_notes", "get_item",
      "mcp__WF1vubI3qu52__slack_list_user_channels", "mcp__WF1vubI3qu52__slack_search_public_and_private",
      "mcp__WF1vubI3qu52__slack_read_channel", "mcp__WF1vubI3qu52__slack_search_channels",
      "mcp__Q9x__ask_work_iq", "mcp__A1__getAccessibleAtlassianResources", "mcp__A1__searchConfluenceUsingCql", "mcp__A1__getConfluencePage",
    ]) expect(todayAllowsTool(t)).toBe(true);
  });
});

describe("workspace Today", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cairn-today-"));
  const seed = () => {
    const db = makeDb();
    seedWorkspace(db);
    seedProject(db, "ws1", "p1", "Alpha");
    seedProject(db, "ws1", "p2", "Beta");
    return db;
  };

  it("keeps one row per workspace and drops the preview's per-project rows", () => {
    const db = seed();
    createAutomation(db, {
      workspaceId: "ws1", projectId: "p1", name: "Today", instructions: "old", scheduleKind: "cron", scheduleExpr: "cron 0 7 * * 1-5",
      enabled: true, nextRunAt: new Date().toISOString(), approvalMode: "ask", source: "custom", communityId: TODAY_COMMUNITY_ID,
    });
    const a = enableToday(db, { workspaceId: "ws1", time: "08:30", weekdaysOnly: false });
    expect(a.projectId).toBeNull();
    expect(listAutomations(db, "ws1").filter((x) => x.communityId === TODAY_COMMUNITY_ID).map((x) => x.id)).toEqual([a.id]);
    expect(enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true }).id).toBe(a.id);
    expect(findTodayAutomation(db, "ws1")?.scheduleExpr).toBe("cron 0 7 * * 1-5");
  });

  it("stores settings as exclusions and reads only the included projects", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    expect(includedProjects(db, "ws1", readTodaySettings(dir, a)).map((p) => p.id)).toEqual(["p1", "p2"]);
    writeTodaySettings(dir, a, { excludedProjects: ["p2"], excludedApps: ["K7q"] });
    const st = getTodayState(db, dir, "ws1");
    expect(st.settings).toEqual({ excludedProjects: ["p2"], excludedApps: ["K7q"] });
    expect(st.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(st.facts.map((f) => f.projectId)).toEqual(["p1"]);
  });

  it("leaves out the tools of apps the user turned off", () => {
    const allow = todayToolFilter({ excludedProjects: [], excludedApps: ["K7q"] });
    expect(allow("mcp__K7q__search_messages")).toBe(false);
    expect(allow("mcp__Z2p__search_messages")).toBe(true);
    expect(allow("today_upsert")).toBe(true);
    expect(allow("search_notes")).toBe(true);
  });

  it("shows a brief left gathering by a stopped run as ready", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, emptyBrief(new Date()));
    expect(getTodayState(db, dir, "ws1").brief?.status).toBe("ready");
  });
});

describe("projectFacts", () => {
  it("counts due, overdue, in-review, stale cards and failing automations", () => {
    const db = makeDb();
    seedWorkspace(db);
    seedProject(db, "ws1", "p1", "Alpha");
    createColumn(db, { id: "c-prog", projectId: "p1", workspaceId: "ws1", name: "Doing", type: "in_progress" });
    createColumn(db, { id: "c-rev", projectId: "p1", workspaceId: "ws1", name: "Review", type: "review" });
    createColumn(db, { id: "c-done", projectId: "p1", workspaceId: "ws1", name: "Done", type: "done" });
    const now = new Date(2026, 10, 16, 9, 0);
    createCard(db, { id: "k1", columnId: "c-prog", projectId: "p1", workspaceId: "ws1", title: "Due today", dueDate: "2026-11-16" });
    createCard(db, { id: "k2", columnId: "c-prog", projectId: "p1", workspaceId: "ws1", title: "Late", dueDate: "2026-11-10" });
    createCard(db, { id: "k3", columnId: "c-rev", projectId: "p1", workspaceId: "ws1", title: "Waiting review" });
    createCard(db, { id: "k4", columnId: "c-done", projectId: "p1", workspaceId: "ws1", title: "Shipped", dueDate: "2026-11-01" });
    db.prepare("UPDATE task_cards SET updated_at = ? WHERE id = ?").run(new Date(2026, 10, 5).toISOString(), "k3");
    const auto = createAutomation(db, {
      workspaceId: "ws1", projectId: "p1", name: "Nightly", instructions: "x", scheduleKind: "cron", scheduleExpr: "cron 0 2 * * *",
      enabled: true, nextRunAt: new Date().toISOString(), approvalMode: "ask", source: "custom",
    });
    const run = createAutomationRun(db, auto.id);
    updateAutomationRun(db, run.id, { status: "error", error: "boom" });

    const [f] = projectFacts(db, "ws1", [{ id: "p1", name: "Alpha" }], now);
    expect(f.dueToday.map((c) => c.id)).toEqual(["k1"]);
    expect(f.overdue.map((c) => c.id)).toEqual(["k2"]);
    expect(f.inReview.map((c) => c.id)).toEqual(["k3"]);
    expect(f.stale.map((c) => [c.id, c.days])).toEqual([["k3", 11]]);
    expect(f.failingAutomations).toEqual([{ id: auto.id, name: "Nightly", failures: 1 }]);
    expect(factsForPrompt([f])).toContain(`"Late" (card k2, due 2026-11-10)`);
  });
});
