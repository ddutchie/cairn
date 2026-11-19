import { describe, it, expect } from "vitest";
import { emptyBrief, finishBrief, removeItems, startRefresh, upsertItems } from "./brief-edit";
import { parseTodayBrief } from "./brief";

const now = new Date(2026, 10, 16, 8, 0);

describe("upsertItems", () => {
  it("adds items to their lanes and updates them by id", () => {
    const b = emptyBrief(now);
    const r = upsertItems(b, [
      { lane: "decision", id: "slack-1", question: "Approve the P4 offer?", choices: [{ label: "Yes", draftId: "d1" }, { label: "Hold" }], projectId: "p1" },
      { lane: "draft", id: "d1", title: "Reply to Edan", draft: "Yes, go ahead." },
      { lane: "fyi", id: "gh-9", title: "CI green on main", tone: "good" },
      { lane: "event", title: "Standup", start: "09:30", end: "09:45" },
    ], now);
    expect(r).toEqual(["slack-1: added.", "d1: added.", "gh-9: added.", "item 4: added."]);
    expect(b.needYou[0]).toMatchObject({ id: "slack-1", kind: "decision", projectId: "p1" });
    expect(b.events[0].id).toBe("09:30-standup");

    upsertItems(b, [{ lane: "todo", id: "slack-1", question: "Reply to Edan" }], now);
    expect(b.needYou).toHaveLength(1);
    expect(b.needYou[0]).toMatchObject({ kind: "todo", title: "Reply to Edan" });
  });

  it("moves an id to its new lane instead of keeping two copies", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "fyi", id: "jira-7", title: "Moved to review" }], now);
    upsertItems(b, [{ lane: "todo", id: "jira-7", question: "Review CAIRN-7" }], now);
    expect(b.fyi).toHaveLength(0);
    expect(b.needYou.map((n) => n.id)).toEqual(["jira-7"]);
  });

  it("says why an item was skipped", () => {
    const b = emptyBrief(now);
    const r = upsertItems(b, [
      { lane: "decision", id: "a", question: "Ship it?" },
      { lane: "todo", question: "No id" },
      { lane: "nope", id: "b" },
      { lane: "event", title: "Bad time", start: "9am" },
    ], now);
    expect(r[0]).toMatch(/needs 2 or 3 "choices"/);
    expect(r[1]).toMatch(/give it an id/);
    expect(r[2]).toMatch(/lane must be one of/);
    expect(r[3]).toMatch(/HH:MM/);
    expect(b.needYou).toHaveLength(0);
  });

  it("caps a lane, and never tells the run to remove an open item to make room", () => {
    const b = emptyBrief(now);
    const items = Array.from({ length: 16 }, (_, i) => ({ lane: "todo", id: `t${i}`, question: `Do ${i}` }));
    const r = upsertItems(b, items.slice(0, 12), now);
    upsertItems(b, items.slice(12), now);
    expect(b.needYou).toHaveLength(15);
    const last = upsertItems(b, [{ lane: "todo", id: "t99", question: "One more" }], now)[0];
    expect(last).toMatch(/holds its most/);
    expect(last).toMatch(/don't remove an open item/);
    expect(r).toHaveLength(12);
  });

  it("lists high priority first and keeps the run's order within a priority", () => {
    const b = emptyBrief(now);
    upsertItems(b, [
      { lane: "todo", id: "a", question: "A" },
      { lane: "todo", id: "b", question: "B", priority: "low" },
      { lane: "todo", id: "c", question: "C", priority: "high" },
      { lane: "todo", id: "d", question: "D" },
    ], now);
    expect(b.needYou.map((n) => n.id)).toEqual(["c", "a", "d", "b"]);
    // An update without priority keeps the one it had.
    upsertItems(b, [{ lane: "todo", id: "c", question: "C again" }], now);
    expect(b.needYou[0]).toMatchObject({ id: "c", priority: "high", title: "C again" });
  });

  it("keeps a carried item unless the removal says how it was handled", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "todo", id: "old", question: "Old" }, { lane: "todo", id: "new", question: "New" }], now);
    b.needYou[0].since = "2026-11-16";
    expect(removeItems(b, ["old", "new"], now)).toEqual([expect.stringMatching(/old: kept/), "new: removed."]);
    expect(b.needYou.map((n) => n.id)).toEqual(["old"]);
    expect(removeItems(b, ["old"], now, "Jira says it's Closed")).toEqual(["old: removed."]);
  });

  it("drops an event that isn't on the brief's day", () => {
    const b = emptyBrief(now);
    const r = upsertItems(b, [
      { lane: "event", title: "Today", start: "09:00", date: b.date },
      { lane: "event", title: "Tomorrow", start: "10:00", date: "2099-01-01" },
      { lane: "event", title: "No date", start: "11:00" },
    ], now);
    expect(r[1]).toMatch(/not today/);
    expect(b.events.map((e) => e.title)).toEqual(["Today", "No date"]);
  });
});

describe("upsertItems checks", () => {
  it("rejects a decision with one choice", () => {
    const b = emptyBrief(now);
    expect(upsertItems(b, [{ lane: "decision", id: "q1", question: "Ship it?", choices: [{ label: "Yes" }] }], now)[0]).toMatch(/needs 2 or 3/);
    expect(b.needYou).toEqual([]);
  });

  it("keeps an item where it was when the lane it moves to is full", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "draft", id: "d1", title: "Reply", draft: "Hi" }], now);
    upsertItems(b, Array.from({ length: 12 }, (_, i) => ({ lane: "todo", id: `t${i}`, question: `Do ${i}` })), now);
    upsertItems(b, Array.from({ length: 3 }, (_, i) => ({ lane: "todo", id: `u${i}`, question: `Do ${i}` })), now);
    expect(upsertItems(b, [{ lane: "todo", id: "d1", question: "Send the reply" }], now)[0]).toMatch(/holds its most/);
    expect(b.prepared.map((p) => p.id)).toEqual(["d1"]);
  });

  it("keeps events with non-Latin titles at the same time apart, and rejects impossible times", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "event", title: "会議", start: "09:00" }, { lane: "event", title: "面接", start: "09:00" }], now);
    expect(b.events.map((e) => e.title)).toEqual(["会議", "面接"]);
    expect(upsertItems(b, [{ lane: "event", title: "Late", start: "29:75" }], now)[0]).toMatch(/skipped/);
  });
});

describe("removeItems and finishBrief", () => {
  it("removes by id and reports misses", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "fyi", id: "f1", title: "x" }], now);
    expect(removeItems(b, ["f1", "zz"], now)).toEqual(["f1: removed.", "zz: not found."]);
    expect(b.fyi).toHaveLength(0);
  });

  it("finishes with the header, drops dangling draft links and survives a save and reload", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "decision", id: "n1", question: "Merge PR 12?", choices: [{ label: "Merge", draftId: "gone" }, { label: "Wait" }] }], now);
    finishBrief(b, { headline: "Decide on PR 12 first.", lede: "It blocks the release.", sources: [{ name: "GitHub", status: "ok", items: 3 }] }, now);
    expect(b.status).toBe("ready");
    expect(b.focusId).toBe("n1");
    expect(b.needYou[0].choices[0].draftId).toBeUndefined();
    const again = parseTodayBrief(JSON.stringify(b), now)!;
    expect(again).toMatchObject({ status: "ready", headline: "Decide on PR 12 first.", date: b.date });
    expect(again.sources).toEqual([{ name: "GitHub", status: "ok", items: 3, note: undefined }]);
  });

  it("falls back to a headline from the first item when the run gave none", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "todo", id: "card-1", question: "Ship the beta" }], now);
    finishBrief(b, {}, now);
    expect(b.headline).toBe("Start with: Ship the beta");
  });
});

describe("startRefresh", () => {
  it("keeps today's items (and so their ids) but clears the sources", () => {
    const b = emptyBrief(now);
    upsertItems(b, [{ lane: "todo", id: "card-1", question: "Ship the beta" }], now);
    finishBrief(b, { headline: "h", lede: "l", sources: [{ name: "Slack", status: "ok" }] }, now);
    const next = startRefresh(b, null, new Date(2026, 10, 16, 12, 0));
    expect(next.status).toBe("gathering");
    expect(next.needYou.map((n) => n.id)).toEqual(["card-1"]);
    expect(next.sources).toEqual([]);
    expect(b.status).toBe("ready");
  });

  it("carries open items into a new day, with when they first showed up and the user's edits", () => {
    const b = emptyBrief(now);
    upsertItems(b, [
      { lane: "todo", id: "card-1", question: "Ship the beta" },
      { lane: "todo", id: "card-2", question: "Done already" },
      { lane: "draft", id: "d1", title: "Reply", draft: "Cairn's text" },
      { lane: "fyi", id: "f1", title: "CI green" },
      { lane: "event", title: "Standup", start: "09:30" },
    ], now);
    finishBrief(b, { headline: "h", lede: "l" }, now);
    const next = startRefresh(b, { done: ["card-2"], edits: { d1: "My text" } }, new Date(2026, 10, 17, 7, 0));
    expect(next.date).not.toBe(b.date);
    expect(next.needYou.map((n) => [n.id, n.since])).toEqual([["card-1", b.date]]);
    expect(next.prepared.map((p) => [p.id, p.draft, p.since])).toEqual([["d1", "My text", b.date]]);
    expect(next.fyi).toEqual([]);
    expect(next.events).toEqual([]);

    // A day later it keeps the first date, and an update by the run keeps it too.
    const third = startRefresh(finishBrief(next, {}, new Date(2026, 10, 17, 8, 0)), null, new Date(2026, 10, 18, 7, 0));
    expect(third.needYou[0].since).toBe(b.date);
    upsertItems(third, [{ lane: "todo", id: "card-1", question: "Ship the beta today" }], new Date(2026, 10, 18, 7, 5));
    expect(third.needYou[0]).toMatchObject({ title: "Ship the beta today", since: b.date });
  });
});

describe("upsertItems and the invite", () => {
  const ev = { lane: "event", id: "cal-1", title: "1:1", start: "10:00", seriesId: "s1", attendees: [{ name: "Ana" }] };
  it("keeps attendees and series only when People is on", () => {
    const on = emptyBrief(new Date(2026, 10, 18, 8)); upsertItems(on, [ev], new Date(2026, 10, 18, 8), true);
    expect(on.events[0]).toMatchObject({ seriesId: "s1", attendees: [{ name: "Ana" }] });
    const off = emptyBrief(new Date(2026, 10, 18, 8)); upsertItems(off, [ev], new Date(2026, 10, 18, 8), false);
    expect(off.events[0]).not.toHaveProperty("attendees");
    expect(off.events[0]).not.toHaveProperty("seriesId");
  });
});
