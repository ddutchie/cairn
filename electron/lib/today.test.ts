import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  enableToday, findTodayAutomation, getTodayState, includedProjects, listTodayHistory, loadTodaySnapshot, migrateLegacyToday, pruneTodayFiles,
  readTodayMarks, readTodaySettings, saveTodayBrief, snapshotTodayBrief, requestTodayRebuild, takeTodayRebuild, todayAllowsTool, todayLookBackFrom, todayPrompt, todayReasoningEffort, todayToolFilter, updateTodayMarks, writeTodaySettings,
} from "./today";
import { factsForPrompt, projectFacts } from "./today-facts";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createAutomation, createAutomationRun, listAutomations, updateAutomationRun } from "../db/automation-queries";
import { createCard, createColumn } from "../db/board-queries";
import { TODAY_COMMUNITY_ID } from "../../shared/today/brief";
import { emptyBrief, finishBrief, upsertItems } from "../../shared/today/brief-edit";

describe("todayAllowsTool", () => {
  it("allows Cairn reads and MCP resources", () => {
    for (const t of ["list_tasks", "get_item", "search_notes", "read_mcp_resource"]) expect(todayAllowsTool(t)).toBe(true);
  });
  it("denies local writes, shell, local file reads and web fetches", () => {
    for (const t of ["create_task", "edit_note", "bash", "write", "edit", "delete", "read", "grep", "glob", "web_fetch"]) expect(todayAllowsTool(t)).toBe(false);
  });
  it("allows read-like connector tools", () => {
    for (const t of ["mcp__slack__search_messages", "mcp__workiq__ask_work_iq", "mcp__github__list_pull_requests", "mcp__atlassian__searchJiraIssuesUsingJql", "mcp__atlassian__getJiraIssue"]) {
      expect(todayAllowsTool(t)).toBe(true);
    }
  });
  it("denies connector tools that change things, even with a read verb", () => {
    for (const t of ["mcp__slack__send_message", "mcp__slack__post_message", "mcp__github__create_pull_request_review", "mcp__outlook__get_and_delete_mail", "mcp__helpdesk__get_and_resolve", "mcp__jira__get_and_complete_task", "mcp__x__do_thing", "mcp__atlassian__editJiraIssue", "mcp__atlassian__createConfluenceContent"]) {
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

  const legacyRow = (db: ReturnType<typeof seed>, projectId: string, enabled: boolean, expr = "cron 15 6 * * 1-5") =>
    createAutomation(db, {
      workspaceId: "ws1", projectId, name: "Today", instructions: "old", scheduleKind: "cron", scheduleExpr: expr,
      enabled, nextRunAt: new Date().toISOString(), approvalMode: "ask", source: "custom", communityId: TODAY_COMMUNITY_ID,
    });
  const todayRows = (db: ReturnType<typeof seed>) => listAutomations(db, "ws1").filter((x) => x.communityId === TODAY_COMMUNITY_ID);

  it("keeps one row per workspace and drops the preview's per-project rows", () => {
    const db = seed();
    const dir = tmp();
    legacyRow(db, "p1", true);
    const a = enableToday(db, dir, { workspaceId: "ws1", time: "08:30", weekdaysOnly: false });
    expect(a.projectId).toBeNull();
    expect(todayRows(db).map((x) => x.id)).toEqual([a.id]);
    expect(enableToday(db, dir, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true }).id).toBe(a.id);
    expect(findTodayAutomation(db, "ws1")?.scheduleExpr).toBe("cron 0 7 * * 1-5");
  });

  it("moves an old per-project schedule to the workspace row on first read", () => {
    const db = seed();
    const dir = tmp();
    legacyRow(db, "p1", false, "cron 0 9 * * *");
    legacyRow(db, "p2", true);
    const st = getTodayState(db, dir, "ws1");
    expect(todayRows(db)).toHaveLength(1);
    expect(st).toMatchObject({ enabled: true, time: "06:15", weekdaysOnly: true });
    migrateLegacyToday(db, dir, "ws1");
    expect(todayRows(db)).toHaveLength(1);
  });

  it("keeps a moved schedule off when every old row was off", () => {
    const db = seed();
    legacyRow(db, "p1", false);
    expect(getTodayState(db, tmp(), "ws1").enabled).toBe(false);
    expect(todayRows(db).map((x) => x.projectId)).toEqual([null]);
  });

  it("stores settings as exclusions and reads only the included projects", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, dir, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    expect(includedProjects(db, "ws1", readTodaySettings(dir, a)).map((p) => p.id)).toEqual(["p1", "p2"]);
    writeTodaySettings(dir, a, { excludedProjects: ["p2"], excludedApps: ["K7q"], webApps: [] });
    const st = getTodayState(db, dir, "ws1");
    expect(st.settings).toEqual({ excludedProjects: ["p2"], excludedApps: ["K7q"], webApps: [] });
    expect(st.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(st.facts.map((f) => f.projectId)).toEqual(["p1"]);
  });

  it("leaves out the tools of apps the user turned off", () => {
    const allow = todayToolFilter({ excludedProjects: [], excludedApps: ["K7q"], webApps: [] });
    expect(allow("mcp__K7q__search_messages")).toBe(false);
    expect(allow("mcp__Z2p__search_messages")).toBe(true);
    expect(allow("today_upsert")).toBe(true);
    expect(allow("search_notes")).toBe(true);
  });

  it("shows a brief left gathering by a stopped run as ready", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, dir, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, emptyBrief(new Date()));
    expect(getTodayState(db, dir, "ws1").brief?.status).toBe("ready");
  });

  it("keeps marks per day with the brief", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, dir, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    updateTodayMarks(dir, a, "2026-11-16", { done: { n1: true, n2: true }, edits: { d1: "Mine" } });
    expect(updateTodayMarks(dir, a, "2026-11-16", { done: { n2: false }, edits: { d1: null } })).toEqual({ done: ["n1"], edits: {} });
    expect(readTodayMarks(dir, a, "2026-11-17")).toEqual({ done: [], edits: {} });
    expect(() => updateTodayMarks(dir, a, "../x", {})).toThrow();
  });

  it("lists days and the versions refreshes replaced, and prunes old files", () => {
    const db = seed();
    const dir = tmp();
    const a = enableToday(db, dir, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    const day = (d: number, h: number) => {
      const b = emptyBrief(new Date(2026, 10, d, h, 0));
      upsertItems(b, [{ lane: "todo", id: `t${d}`, question: "Do it" }], new Date(2026, 10, d, h, 0));
      return finishBrief(b, { headline: `Day ${d}` }, new Date(2026, 10, d, h, 0));
    };
    saveTodayBrief(dir, a, day(1, 7));
    const morning = day(16, 7);
    saveTodayBrief(dir, a, morning);
    snapshotTodayBrief(dir, a, morning);
    // A second version from the same second gets its own file instead of overwriting the first.
    snapshotTodayBrief(dir, a, { ...morning, headline: "Day 16 again" });
    saveTodayBrief(dir, a, day(16, 12));
    updateTodayMarks(dir, a, "2026-11-01", { done: { t1: true } });
    const keys = listTodayHistory(dir, a).map((h) => h.key);
    expect(keys.sort()).toEqual(["2026-11-01", "2026-11-16", "2026-11-16@070000", "2026-11-16@070000-2"]);
    expect(loadTodaySnapshot(dir, a, "2026-11-16@070000")?.brief.headline).toBe("Day 16");
    expect(loadTodaySnapshot(dir, a, "2026-11-16@070000-2")?.brief.headline).toBe("Day 16 again");
    expect(loadTodaySnapshot(dir, a, "../../etc")).toBeNull();
    expect(pruneTodayFiles(dir, a, new Date(2026, 10, 16), 7)).toBe(2);
    expect(listTodayHistory(dir, a).map((h) => h.key).sort()).toEqual(["2026-11-16", "2026-11-16@070000", "2026-11-16@070000-2"]);
  });
});

describe("todayLookBackFrom", () => {
  it("starts from the last run that finished, skipping failed runs and the one starting now", () => {
    const db = makeDb();
    seedWorkspace(db);
    const auto = createAutomation(db, {
      workspaceId: "ws1", projectId: null, name: "Today", instructions: "x", scheduleKind: "cron", scheduleExpr: "cron 0 7 * * 1-5",
      enabled: true, nextRunAt: new Date().toISOString(), approvalMode: "auto", source: "custom",
    });
    expect(todayLookBackFrom(db, auto.id)).toBeNull();
    const done = createAutomationRun(db, auto.id);
    updateAutomationRun(db, done.id, { status: "done" });
    const failed = createAutomationRun(db, auto.id);
    updateAutomationRun(db, failed.id, { status: "error", error: "output limit" });
    const current = createAutomationRun(db, auto.id, "running");
    expect(todayLookBackFrom(db, auto.id, current.id)).toBe(done.startedAt);
  });

  it("makes only the next run a rebuild, which ignores the last brief's time", () => {
    expect(takeTodayRebuild("a1")).toBe(false);
    requestTodayRebuild("a1");
    expect(takeTodayRebuild("a1")).toBe(true);
    expect(takeTodayRebuild("a1")).toBe(false);
    const now = new Date(2026, 10, 16, 20, 0);
    expect(todayPrompt([], "2026-11-16T19:00:00Z", now)).toContain("look for what changed since then");
    const rebuilt = todayPrompt([], "2026-11-16T19:00:00Z", now, true);
    expect(rebuilt).toContain("The user asked for a rebuild");
    expect(rebuilt).not.toContain("That's when the last brief ran");
  });

  it("gives the exact look-back time, so the model never works out Unix time itself", () => {
    const last = "2026-11-16T19:00:00Z";
    const now = new Date(2026, 10, 17, 7, 0); // a Tuesday
    const p = todayPrompt([], last, now);
    expect(p).toContain(`Unix ${Date.parse(last) / 1000}`);
    expect(p).toContain("Today's date is 2026-11-17");
    expect(p).toContain(`Still open since (7 days back): Tuesday, 10 November 2026, 07:00 local time`);
    expect(p).toContain(`Unix ${Math.floor(now.getTime() / 1000) - 7 * 24 * 3600}.`);
    // No earlier brief: 24 hours back, 72 on a Monday.
    expect(todayPrompt([], null, now)).toContain(`Unix ${Math.floor(now.getTime() / 1000) - 24 * 3600}`);
    const monday = new Date(2026, 10, 16, 7, 0);
    expect(todayPrompt([], null, monday)).toContain(`Unix ${Math.floor(monday.getTime() / 1000) - 72 * 3600}`);
  });

  it("asks for the calendar without naming one app", () => {
    const p = todayPrompt([], null, new Date(2026, 10, 17, 7, 0));
    expect(p).toContain("## Calendar");
    expect(p).toContain("## Communication");
    expect(p).not.toContain("Work IQ");
  });

  it("needs the user's say-so for every tool of a web search app, and leaves out non-GET service operations", () => {
    const facts = { webServers: new Set(["W1"]), writeTools: new Set(["svc__S1__search_orders"]) };
    const off = todayToolFilter({ excludedProjects: [], excludedApps: [], webApps: [] }, facts);
    // A web app's tool named like a plain lookup still needs webApps.
    expect(off("mcp__W1__search")).toBe(false);
    const on = todayToolFilter({ excludedProjects: [], excludedApps: [], webApps: ["W1"] }, facts);
    expect(on("mcp__W1__search")).toBe(true);
    expect(on("mcp__W1__send_feedback")).toBe(false);
    // A POST operation named like a search is left out; the service's GET ones stay.
    expect(on("svc__S1__search_orders")).toBe(false);
    expect(on("svc__S1__list_orders")).toBe(true);
  });

  it("offers a web search app only once the user turns it on", () => {
    const off = todayToolFilter({ excludedProjects: [], excludedApps: [], webApps: [] });
    expect(off("svc__B1__brave_web_search")).toBe(false);
    const on = todayToolFilter({ excludedProjects: [], excludedApps: [], webApps: ["B1"] });
    expect(on("svc__B1__brave_web_search")).toBe(true);
    expect(on("svc__B2__brave_web_search")).toBe(false);
    const excluded = todayToolFilter({ excludedProjects: [], excludedApps: ["B1"], webApps: ["B1"] });
    expect(excluded("svc__B1__brave_web_search")).toBe(false);
  });

  it("leaves out connector tools that reach the open web", () => {
    expect(todayAllowsTool("svc__abc__brave_web_search")).toBe(false);
    expect(todayAllowsTool("mcp__s__search_web")).toBe(false);
    expect(todayAllowsTool("mcp__s__fetch_url")).toBe(false);
    expect(todayAllowsTool("mcp__slack__slack_search_public")).toBe(true);
    expect(todayAllowsTool("mcp__atl__searchJiraIssuesUsingJql")).toBe(true);
  });

  it("runs Today on low effort unless reasoning is off", () => {
    expect(todayReasoningEffort("high")).toBe("low");
    expect(todayReasoningEffort(undefined)).toBe("low");
    expect(todayReasoningEffort("off")).toBe("off");
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
