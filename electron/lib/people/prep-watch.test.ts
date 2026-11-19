import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { makeDb, seedWorkspace } from "../../test-support/db";
import { addAttendee, createMeeting, createPerson, setPeopleEnabled } from "../../db/people-queries";
import { localDate } from "../../../shared/today/brief";
import { ensurePrepAutomation, markPrepDone, markPrepRunning, savePrepBrief, startingBrief } from "./prep";
import { AUTO_PREPS_PER_DAY, resetPrepWatch, tickMeetingPreps } from "./prep-watch";

vi.mock("../heartbeat-runner", () => ({ runPrepNow: vi.fn() }));

let db: Database.Database;
let root: string;
beforeEach(() => { db = makeDb(); seedWorkspace(db); setPeopleEnabled(db, true); resetPrepWatch(); root = fs.mkdtempSync(path.join(os.tmpdir(), "prepwatch-")); });
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const now = Date.parse("2026-11-18T12:00:00Z");
function meetingSoon(minutes = 45, cadence: "weekly" | null = "weekly") {
  const ana = createPerson(db, { workspaceId: "ws1", name: "Ana", cadence: cadence ?? undefined });
  const m = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(now + minutes * 60_000).toISOString(), source: "calendar" });
  addAttendee(db, { meetingId: m.id, personId: ana.id });
  return { ana, m };
}
const ctx = () => ({ db, workspacePath: root });

describe("tickMeetingPreps", () => {
  it("starts a brief for a person with a cadence ahead of their calendar meeting, once", () => {
    const { ana, m } = meetingSoon();
    const run = vi.fn(() => ({ runId: "r1" }));
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), "ws1", { personId: ana.id, meetingId: m.id });
    expect(tickMeetingPreps(ctx(), now + 30_000, { run })).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the preview is off, for no cadence, or far-off meetings", () => {
    meetingSoon(45, null);
    meetingSoon(600);
    const run = vi.fn(() => ({ runId: "r1" }));
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(0);
    setPeopleEnabled(db, false);
    meetingSoon();
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips someone who already has today's brief, even a failed one", () => {
    const { ana } = meetingSoon();
    const automation = ensurePrepAutomation(db, "ws1");
    savePrepBrief(root, automation, { ...startingBrief({ personId: ana.id, name: "Ana" } as never, new Date(now)), status: "ready", error: "boom", date: localDate(new Date(now)) });
    const run = vi.fn(() => ({ runId: "r1" }));
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("tries again next tick while another brief is running or there is no AI, but never after the person is unknown", () => {
    meetingSoon();
    const busy = vi.fn(() => ({ skipped: "busy" as const }));
    tickMeetingPreps(ctx(), now, { run: busy });
    tickMeetingPreps(ctx(), now + 30_000, { run: busy });
    expect(busy).toHaveBeenCalledTimes(2);
    const gone = vi.fn(() => ({ skipped: "unknown-person" as const }));
    tickMeetingPreps(ctx(), now + 60_000, { run: gone });
    tickMeetingPreps(ctx(), now + 90_000, { run: gone });
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("starts at most one brief per tick", () => {
    meetingSoon();
    meetingSoon(50);
    const run = vi.fn(() => ({ runId: "r1" }));
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("handles a stub person end to end: a saved brief is found, so the watcher doesn't run again", () => {
    const stub = createPerson(db, { workspaceId: "ws1", name: "Alice", id: "stub:ws1:alice@example.com", cadence: "weekly" } as never);
    const m = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(now + 45 * 60_000).toISOString(), source: "calendar" });
    addAttendee(db, { meetingId: m.id, personId: stub.id });
    const automation = ensurePrepAutomation(db, "ws1");
    const run = vi.fn(() => ({ runId: "r1" }));
    savePrepBrief(root, automation, { ...startingBrief({ personId: stub.id, name: "Alice" } as never, new Date(now)), status: "ready", date: localDate(new Date(now)) });
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts again when the only brief is a placeholder from a crashed run, but not while that run is alive", () => {
    const { ana } = meetingSoon();
    const automation = ensurePrepAutomation(db, "ws1");
    savePrepBrief(root, automation, { ...startingBrief({ personId: ana.id, name: "Ana" } as never, new Date(now)), date: localDate(new Date(now)) });
    markPrepRunning("live", ana.id);
    const run = vi.fn(() => ({ runId: "r2" }));
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(0);
    markPrepDone("live"); resetPrepWatch();
    expect(tickMeetingPreps(ctx(), now, { run })).toBe(1);
  });

  it("caps automatic briefs per day", () => {
    const run = vi.fn(() => ({ runId: "r" }));
    for (let i = 0; i < AUTO_PREPS_PER_DAY + 2; i++) {
      meetingSoon(30 + i);
      tickMeetingPreps(ctx(), now, { run });
    }
    expect(run).toHaveBeenCalledTimes(AUTO_PREPS_PER_DAY);
  });
});
