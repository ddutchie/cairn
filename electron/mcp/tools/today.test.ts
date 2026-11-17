import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { get_today } from "./today";
import { executeTool } from "./index";
import { makeDb, seedProject, seedWorkspace } from "../../test-support/db";
import { disableToday, enableToday, saveTodayBrief, updateTodayMarks } from "../../lib/today";
import { TODAY_BRIEF_VERSION, localDate, type TodayBrief } from "../../../shared/today/brief";
import { TODAY_DIGEST_NOTICE } from "../../../shared/today/digest";

type Out = Record<string, unknown> & {
  needYou: Array<Record<string, unknown>>; drafts: Array<Record<string, unknown>>; fyi: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>; freeTime: Record<string, unknown>;
};

function brief(date: string, over: Partial<TodayBrief> = {}): TodayBrief {
  return {
    version: TODAY_BRIEF_VERSION, status: "ready", generatedAt: `${date}T07:05:00.000Z`, date,
    headline: "Decide on the release first", lede: "The release branch is waiting on you.", focusId: "n-release",
    events: [{ id: "e1", title: "Standup", start: "09:00", end: "09:30" }, { id: "e2", title: "Design review", start: "14:00", end: "15:00" }],
    needYou: [
      { id: "n-low", kind: "todo", title: "Tidy the backlog", facts: [], choices: [], source: "Board", priority: "low" },
      {
        id: "n-release", kind: "decision", title: "Ship 3.2 today?", facts: ["Asked by Sam"], choices: [{ label: "Ship it", draftId: "d-reply" }, { label: "Wait" }],
        source: "Slack", projectId: "p1", priority: "high", since: "2026-11-09",
      },
    ],
    prepared: [{ id: "d-reply", title: "Reply to Sam", kind: "reply", target: "#release in Slack", draft: "Shipping today.", source: "Slack" }],
    fyi: [{ id: "f-ci", title: "Nightly build is green", tone: "good", source: "GitHub" }],
    sources: [{ name: "Slack", status: "ok" }],
    ...over,
  };
}

function setup() {
  const db = makeDb();
  seedWorkspace(db);
  seedProject(db, "ws1", "p1", "Alpha");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-get-today-"));
  return { db, dir };
}

describe("get_today", () => {
  it("says plainly when Today was never set up", () => {
    const { db, dir } = setup();
    expect(get_today(db, dir, {}, "ws1")).toMatchObject({ today: "off" });
  });

  it("says when Today is on or off but has no brief yet", () => {
    const { db, dir } = setup();
    enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    expect(get_today(db, dir, {}, "ws1")).toMatchObject({ today: "on", message: "Today is on but hasn't made a brief yet." });
    disableToday(db, "ws1");
    expect(get_today(db, dir, {}, "ws1")).toMatchObject({ today: "off", message: "Today is off and has never made a brief." });
  });

  it("returns the latest brief, high priority first, with project names, marks and free time", () => {
    const { db, dir } = setup();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, brief("2026-11-10", { headline: "Old" }));
    saveTodayBrief(dir, a, brief("2026-11-11"));
    const out = get_today(db, dir, {}, "ws1") as Out;
    expect(out).toMatchObject({ today: "on", date: "2026-11-11", status: "ready", headline: "Decide on the release first", focusId: "n-release", notice: TODAY_DIGEST_NOTICE });
    expect(out.needYou.map((n) => n.id)).toEqual(["n-release", "n-low"]);
    expect(out.needYou[0]).toMatchObject({ kind: "decision", question: "Ship 3.2 today?", project: "Alpha", priority: "high", since: "2026-11-09", facts: ["Asked by Sam"], choices: ["Ship it", "Wait"] });
    expect(out.drafts[0]).toEqual({ id: "d-reply", title: "Reply to Sam", kind: "reply", target: "#release in Slack" });
    expect(out.events.map((e) => e.title)).toEqual(["Standup", "Design review"]);
    // An earlier day has no "now", so the whole 08:00–18:00 day minus meetings reads as free.
    expect(out.freeTime).toMatchObject({ freeLeft: "8h 30m", meetingsLeft: 2, freeBlocks: ["08:00–09:00", "09:30–14:00", "15:00–18:00"] });
  });

  it("hides items marked done unless includeDone, and gives draft text (edited) only when asked", () => {
    const { db, dir } = setup();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, brief("2026-11-11"));
    updateTodayMarks(dir, a, "2026-11-11", { done: { "n-low": true, "f-ci": true }, edits: { "d-reply": "Shipping at 3pm." } });

    const hidden = get_today(db, dir, {}, "ws1") as Out;
    expect(hidden.needYou.map((n) => n.id)).toEqual(["n-release"]);
    expect(hidden.fyi).toEqual([]);
    expect(hidden.hiddenDone).toBe(2);
    expect(hidden.drafts[0].draft).toBeUndefined();

    const all = get_today(db, dir, { includeDone: true, includeDrafts: true }, "ws1") as Out;
    expect(all.needYou.find((n) => n.id === "n-low")).toMatchObject({ done: true });
    expect(all.fyi[0]).toMatchObject({ id: "f-ci", done: true });
    expect(all.hiddenDone).toBeUndefined();
    expect(all.drafts[0].draft).toBe("Shipping at 3pm.");
  });

  it("reads a past day by date, with that day's marks, and says when the day has no brief", () => {
    const { db, dir } = setup();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, brief("2026-11-10", { headline: "Monday's brief" }));
    saveTodayBrief(dir, a, brief("2026-11-11"));
    updateTodayMarks(dir, a, "2026-11-10", { done: { "n-release": true } });
    const past = get_today(db, dir, { date: "2026-11-10" }, "ws1") as Out;
    expect(past).toMatchObject({ date: "2026-11-10", headline: "Monday's brief" });
    expect(past.needYou.map((n) => n.id)).toEqual(["n-low"]);
    expect(get_today(db, dir, { date: "2026-10-01" }, "ws1")).toMatchObject({ message: expect.stringContaining("no saved brief for 2026-10-01") });
    expect(get_today(db, dir, { date: "yesterday" }, "ws1")).toEqual({ error: "date must be YYYY-MM-DD." });
  });

  it("treats a gathering brief with no run going as ready, and marks today's brief as today", () => {
    const { db, dir } = setup();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    const today = localDate(new Date());
    saveTodayBrief(dir, a, brief(today, { status: "gathering" }));
    expect(get_today(db, dir, {}, "ws1")).toMatchObject({ status: "ready", isToday: true });
  });

  it("runs through the MCP dispatcher, finding the workspace with Today set up", () => {
    const { db, dir } = setup();
    const a = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    saveTodayBrief(dir, a, brief("2026-11-11"));
    expect(executeTool(db, dir, "get_today", {})).toMatchObject({ today: "on", date: "2026-11-11" });
  });
});
