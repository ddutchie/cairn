/**
 * The People layer's two runner paths (W6): a `prep` run (one person's brief, read-only, written
 * through `prep_save`) and Today's calendar events becoming meetings when a brief finishes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createPerson, getMeeting, setPeopleEnabled } from "../db/people-queries";
import { createAutomationRun, getAutomationRunById } from "../db/automation-queries";
import { calendarMeetingId } from "../../shared/people/ids";
import { localDate } from "../../shared/today/brief";
import { enableToday, findTodayAutomation } from "./today";
import { ensurePrepAutomation, loadLatestPrepBrief, PREP_TOOL_NAME } from "./people/prep";
import { eventExternalId } from "../db/people-oneonone";
import { runAutomation, runPrepNow } from "./heartbeat-runner";

const { engineMock, insertNotificationMock } = vi.hoisted(() => ({
  engineMock: { runEngineAutomation: vi.fn(), respondEngineAsk: vi.fn(() => true) },
  insertNotificationMock: vi.fn(),
}));
vi.mock("../mcp/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("../mcp/db")>()), insertNotification: insertNotificationMock }));
vi.mock("./config-cache", () => ({
  getCachedConfig: () => ({ aiConfig: { baseUrl: "https://api.test.invalid", model: "gpt-test" } }),
  cachedMaxOutputTokens: () => 32_000,
}));
vi.mock("../ipc/engine-bridge", () => engineMock);
vi.mock("./external-tools", async (importOriginal) => ({ ...(await importOriginal<typeof import("./external-tools")>()), getExternalToolDefs: vi.fn(async () => []) }));

type EngineOpts = {
  prompt: string; systemPrompt: string; extraTools: Array<{ name: string; execute: (a: unknown) => Promise<unknown> }>;
  toolFilter?: (name: string) => boolean; externalGetOnly?: boolean;
};

let db: Database.Database;
let root: string;
beforeEach(() => { db = makeDb(); seedWorkspace(db); seedProject(db); setPeopleEnabled(db, true); root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-people-")); });
afterEach(() => { vi.clearAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const notificationCount = () => insertNotificationMock.mock.calls.length;
const ctx = (send?: (c: string, p: unknown) => void) => ({ db, workspacePath: root, send });

async function waitForRun(runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = getAutomationRunById(db, runId);
    if (r && r.status !== "running" && r.status !== "pending") return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("run did not finish");
}

describe("prep run", () => {
  function setupAna() {
    createPerson(db, { workspaceId: "ws1", name: "Me", isMe: true });
    return createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz", slackId: "U1", cadence: "weekly" });
  }

  it("runs read-only with the person's facts, saves the brief through prep_save and sends no notification", async () => {
    const ana = setupAna();
    let opts: EngineOpts | undefined;
    engineMock.runEngineAutomation.mockImplementation(async (o: EngineOpts) => {
      opts = o;
      const save = o.extraTools.find((t) => t.name === PREP_TOOL_NAME)!;
      await save.execute({ summary: "Working on billing.", recent: [{ text: "Raised a rollback plan", source: "Slack" }, { text: "Posted 20 messages" }], sources: [{ name: "Slack", status: "ok" }] });
    });
    const events: Array<{ c: string; p: unknown }> = [];
    const r = runPrepNow(ctx((c, p) => events.push({ c, p })), "ws1", { personId: ana.id });
    expect("runId" in r).toBe(true);
    const run = await waitForRun((r as { runId: string }).runId);
    expect(run.status).toBe("done");

    expect(opts!.prompt).toContain("Ana Ruiz");
    expect(opts!.prompt).toContain("Their Slack user id is U1");
    expect(opts!.systemPrompt).toContain("1:1 prep builder");
    expect(opts!.externalGetOnly).toBe(true);
    // Read-only: the one writing tool passes, connector writes and the shell don't.
    expect(opts!.toolFilter!(PREP_TOOL_NAME)).toBe(true);
    expect(opts!.toolFilter!("mcp__slack__post_message")).toBe(false);
    expect(opts!.toolFilter!("bash")).toBe(false);
    expect(opts!.toolFilter!("mcp__slack__search_messages")).toBe(true);

    const automation = ensurePrepAutomation(db, "ws1");
    const brief = loadLatestPrepBrief(root, automation, ana.id)!;
    expect(brief).toMatchObject({ status: "ready", summary: "Working on billing.", personName: "Ana Ruiz" });
    expect(brief.recent.map((x) => x.text)).toEqual(["Raised a rollback plan"]);
    expect(events.some((e) => e.c === "people:prep:updated")).toBe(true);
    expect(notificationCount()).toBe(0);
  });

  it("answers an unattended ask for the prep tool and denies a write", async () => {
    const ana = setupAna();
    engineMock.runEngineAutomation.mockImplementation(async (o: EngineOpts & { tap: (c: string, p: unknown) => void; sessionId: string }) => {
      const ask = (callId: string, name: string) => o.tap("session:projection", { kind: "approval", data: { status: "required", callId, name, nonce: "n" } });
      ask("c1", PREP_TOOL_NAME); ask("c2", "mcp__slack__post_message");
      await o.extraTools.find((t) => t.name === PREP_TOOL_NAME)!.execute({ summary: "ok", sources: [] });
    });
    const r = runPrepNow(ctx(), "ws1", { personId: ana.id });
    await waitForRun((r as { runId: string }).runId);
    const answers = engineMock.respondEngineAsk.mock.calls as unknown as Array<[unknown, string, string, string, { approved: boolean }]>;
    expect(answers.find((a) => a[2] === "c1")?.[4]).toEqual({ approved: true });
    expect(answers.find((a) => a[2] === "c2")?.[4]).toEqual({ approved: false });
  });

  it("records an error brief, not an endless 'preparing', when the run never saves", async () => {
    const ana = setupAna();
    engineMock.runEngineAutomation.mockImplementation(async () => {});
    const r = runPrepNow(ctx(), "ws1", { personId: ana.id });
    const run = await waitForRun((r as { runId: string }).runId);
    expect(run.status).toBe("error");
    const brief = loadLatestPrepBrief(root, ensurePrepAutomation(db, "ws1"), ana.id)!;
    expect(brief.status).toBe("ready");
    expect(brief.error).toContain("without saving a brief");
    expect(notificationCount()).toBe(0);
  });

  it("records the engine's failure on the brief", async () => {
    const ana = setupAna();
    engineMock.runEngineAutomation.mockImplementation(async (o: { tap: (c: string, p: unknown) => void; sessionId: string }) => {
      o.tap("session:projection", { sessionId: o.sessionId, kind: "error", data: { message: "provider down" } });
    });
    const r = runPrepNow(ctx(), "ws1", { personId: ana.id });
    const run = await waitForRun((r as { runId: string }).runId);
    expect(run.status).toBe("error");
    expect(loadLatestPrepBrief(root, ensurePrepAutomation(db, "ws1"), ana.id)?.error).toBe("provider down");
  });

  it("refuses to start while off, for a person of another workspace, or while another prep runs", async () => {
    const ana = setupAna();
    setPeopleEnabled(db, false);
    expect(runPrepNow(ctx(), "ws1", { personId: ana.id })).toEqual({ skipped: "off" });
    setPeopleEnabled(db, true);
    expect(runPrepNow(ctx(), "ws1", { personId: "nobody" })).toEqual({ skipped: "unknown-person" });
    seedWorkspace(db, "ws2", "Other");
    expect(runPrepNow(ctx(), "ws2", { personId: ana.id })).toEqual({ skipped: "unknown-person" });
    let release!: () => void;
    engineMock.runEngineAutomation.mockImplementation(() => new Promise<void>((res) => { release = res; }));
    const first = runPrepNow(ctx(), "ws1", { personId: ana.id });
    expect("runId" in first).toBe(true);
    expect(runPrepNow(ctx(), "ws1", { personId: ana.id })).toEqual({ skipped: "busy" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await waitForRun((first as { runId: string }).runId);
  });

  it("ends quietly when the preview is switched off after the request", async () => {
    const ana = setupAna();
    const automation = ensurePrepAutomation(db, "ws1");
    const run = createAutomationRun(db, automation.id, "running");
    setPeopleEnabled(db, false);
    await runAutomation(ctx(), run, automation);
    expect(getAutomationRunById(db, run.id)?.status).toBe("skipped");
    expect(engineMock.runEngineAutomation).not.toHaveBeenCalled();
    expect(notificationCount()).toBe(0);
    expect(ana.id).toBeTruthy();
  });
});

describe("Today calendar events → meetings", () => {
  const date = localDate(new Date());
  async function runToday(events: unknown[]) {
    const today = enableToday(db, { workspaceId: "ws1", time: "07:00", weekdaysOnly: true });
    engineMock.runEngineAutomation.mockImplementation(async (o: EngineOpts) => {
      const upsert = o.extraTools.find((t) => t.name === "today_upsert")!;
      await upsert.execute({ items: events.map((e) => ({ lane: "event", ...(e as object) })) });
      await o.extraTools.find((t) => t.name === "today_finish")!.execute({ headline: "Go.", lede: "Fine.", sources: [] });
    });
    const run = createAutomationRun(db, today.id, "running");
    await runAutomation(ctx(), run, today);
    return today;
  }
  const event = { id: "evt-1", title: "1:1 Ana", start: "10:00", end: "10:30", date, attendees: [{ name: "Ana Ruiz" }, { name: "Me", self: true }], seriesId: "Weekly" };

  it("links each event's attendees to people when the brief finishes, with the flag on", async () => {
    const ana = createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz" });
    await runToday([event]);
    const m = getMeeting(db, calendarMeetingId("ws1", eventExternalId(date, event)))!;
    expect(m).toMatchObject({ title: "1:1 Ana", source: "calendar", seriesKey: "ser:weekly" });
    expect(db.prepare("SELECT person_id FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NULL").all(m.id)).toEqual([{ person_id: ana.id }]);
  });

  it("asks the model for attendees only while the preview is on", async () => {
    await runToday([]);
    expect((engineMock.runEngineAutomation.mock.calls[0][0] as EngineOpts).prompt).toContain("People on the calendar");
    setPeopleEnabled(db, false);
    const today = findTodayAutomation(db, "ws1")!;
    await runAutomation(ctx(), createAutomationRun(db, today.id, "running"), today);
    expect((engineMock.runEngineAutomation.mock.calls[1][0] as EngineOpts).prompt).not.toContain("People on the calendar");
  });

  it("writes no meetings and no people while the preview is off", async () => {
    setPeopleEnabled(db, false);
    createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz" });
    await runToday([event]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_attendees").get()).toEqual({ n: 0 });
  });

  it("repeat runs leave existing meeting rows untouched", async () => {
    createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz" });
    const today = await runToday([event]);
    db.prepare("UPDATE meetings SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE meeting_attendees SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    await runAutomation(ctx(), createAutomationRun(db, today.id, "running"), today);
    expect(db.prepare("SELECT updated_at FROM meetings").all()).toEqual([{ updated_at: "2020-01-01T00:00:00.000Z" }]);
    expect(db.prepare("SELECT updated_at FROM meeting_attendees").all()).toEqual([{ updated_at: "2020-01-01T00:00:00.000Z" }]);
  });

  it("keeps the brief and finishes the run when meeting capture fails", async () => {
    createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz" });
    db.exec("DROP TABLE meeting_attendees");
    const today = await runToday([event]);
    const last = db.prepare("SELECT status FROM automation_runs WHERE automation_id = ?").get(today.id) as { status: string };
    expect(last.status).toBe("done");
    expect(fs.readdirSync(path.join(root, ".automations", today.id, "out", "today")).some((f) => f.endsWith(`${date}.json`))).toBe(true);
  });
});
