import { describe, it, expect } from "vitest";
import {
  NUDGE_AFTER_DAYS, daysBetween, gapLabel, isActivityMetric, normalisePrepInput, stripActivity, nudgeDue, nudgeTitle, parsePrepBrief, parseSlackProfile, statusEmojiChar,
  profileIsFresh, PROFILE_TTL_MS,
} from "./oneonone";

const DAY = 86_400_000;
const base = { personId: "p1", personName: "Ana Ruiz", date: "2026-11-18" };

describe("cadence nudges", () => {
  it("fire once the gap passes the cadence by a third", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(nudgeDue("weekly", now - 9 * DAY, now)).toBe(false);
    expect(nudgeDue("weekly", now - NUDGE_AFTER_DAYS.weekly * DAY, now)).toBe(true);
    expect(nudgeDue("biweekly", now - 17 * DAY, now)).toBe(false);
    expect(nudgeDue("biweekly", now - 21 * DAY, now)).toBe(true);
    expect(nudgeDue("monthly", now - 41 * DAY, now)).toBe(true);
  });
  it("never fire without a cadence or a last meeting", () => {
    const now = Date.now();
    expect(nudgeDue(undefined, now - 90 * DAY, now)).toBe(false);
    expect(nudgeDue("weekly", null, now)).toBe(false);
    expect(nudgeDue("weekly", Number.NaN, now)).toBe(false);
  });
  it("say the gap the way a person would", () => {
    expect(gapLabel(12)).toBe("12 days");
    expect(gapLabel(21)).toBe("3 weeks");
    expect(nudgeTitle("Ana Ruiz", 22)).toBe("No 1:1 with Ana Ruiz in 3 weeks");
    expect(daysBetween(5 * DAY, 2 * DAY)).toBe(0);
  });
});

describe("prep brief", () => {
  it("drops lines that report activity instead of work", () => {
    expect(isActivityMetric("Posted 12 messages in #platform")).toBe(true);
    expect(isActivityMetric("Was online until midnight")).toBe(true);
    expect(isActivityMetric("Average response time is 4 minutes")).toBe(true);
    expect(isActivityMetric("Raised the rollback plan for the billing migration")).toBe(false);
    const brief = normalisePrepInput({
      summary: "Busy on the migration.",
      recent: [
        { text: "Posted 30 messages this week", source: "Slack" },
        { text: "Raised the rollback plan in #platform", source: "Slack", url: "https://x.test/1" },
      ],
      followUps: ["Last seen online late", "Agree the rollout date"],
      questions: ["What blocks the rollout?"],
      sources: [{ name: "Slack", status: "ok" }, { name: "Bad", status: "weird" }],
    }, base, new Date("2026-11-18T08:00:00Z"));
    expect(brief.recent).toEqual([{ text: "Raised the rollback plan in #platform", source: "Slack", url: "https://x.test/1" }]);
    expect(brief.followUps).toEqual(["Agree the rollout date"]);
    expect(brief.sources).toEqual([{ name: "Slack", status: "ok" }]);
    expect(brief.status).toBe("ready");
  });

  it("takes the person and date from Cairn, never the model", () => {
    const brief = normalisePrepInput({ summary: "x", personId: "evil", date: "1999-01-01", sources: [] }, base, new Date());
    expect(brief.personId).toBe("p1");
    expect(brief.date).toBe("2026-11-18");
  });

  it("round-trips through a saved file and rejects other JSON", () => {
    const brief = normalisePrepInput({ summary: "Fine.", questions: ["How are you?"], sources: [] }, { ...base, meetingId: "m1" }, new Date("2026-11-18T08:00:00Z"));
    const again = parsePrepBrief(JSON.stringify(brief));
    expect(again).toMatchObject({ personId: "p1", date: "2026-11-18", meetingId: "m1", summary: "Fine.", questions: ["How are you?"], status: "ready" });
    expect(parsePrepBrief("{}")).toBeNull();
    expect(parsePrepBrief("nope")).toBeNull();
    expect(parsePrepBrief(JSON.stringify({ personId: "p1", date: "tomorrow" }))).toBeNull();
  });

  it("keeps a placeholder as gathering", () => {
    const again = parsePrepBrief(JSON.stringify({ personId: "p1", date: "2026-11-18", status: "gathering" }));
    expect(again?.status).toBe("gathering");
  });
});

describe("Slack profile", () => {
  it("reads the raw Slack API shape", () => {
    expect(parseSlackProfile(JSON.stringify({
      ok: true, user: { tz: "Europe/London", profile: { display_name: "ana", title: "Staff Engineer", pronouns: "she/her", status_text: "In focus time", status_emoji: ":headphones:" } },
    }))).toEqual({ displayName: "ana", title: "Staff Engineer", timezone: "Europe/London", pronouns: "she/her", statusText: "In focus time", statusEmoji: ":headphones:" });
  });
  it("reads a flattened connector reply and a profile wrapper", () => {
    expect(parseSlackProfile(JSON.stringify({ title: "Designer", tz: "America/New_York" }))).toEqual({ title: "Designer", timezone: "America/New_York" });
    expect(parseSlackProfile(JSON.stringify({ profile: { title: "PM", real_name: "Pat" } }))).toEqual({ displayName: "Pat", title: "PM" });
  });
  it("turns a status shortcode into a character, or nothing", () => {
    expect(statusEmojiChar(":headphones:")).toBe("🎧");
    expect(statusEmojiChar(":palm_tree::skin-tone-3:")).toBe("🌴");
    expect(statusEmojiChar(":some_custom_one:")).toBe("");
    // The full standard list, plus names Slack spells its own way.
    expect(statusEmojiChar(":taco:")).toBe("🌮");
    expect(statusEmojiChar(":+1:")).toBe("👍");
    expect(statusEmojiChar(":thumbsup::skin-tone-4:")).toBe("👍");
    expect(statusEmojiChar(":spiral_calendar_pad:")).toBe("🗓️");
    expect(statusEmojiChar(":partyparrot:")).toBe("");
    expect(statusEmojiChar("🎧")).toBe("🎧");
    expect(statusEmojiChar(undefined)).toBe("");
  });
  it("reads the Slack MCP server's labelled-text reply", () => {
    const reply = JSON.stringify({ result: "User ID: UV49QTKPS\nUsername: reillyb\nDisplay Name: Ben Reilly\nReal Name: ben.reilly\nPronouns: he/him\nTitle: Manager, Software Development\nStatus:  \nTimezone: America/New_York\nAdmin: No\n" });
    expect(parseSlackProfile(reply)).toEqual({ displayName: "Ben Reilly", title: "Manager, Software Development", timezone: "America/New_York", pronouns: "he/him" });
    expect(parseSlackProfile("Title: Designer\nTimezone: Europe/Athens")).toEqual({ title: "Designer", timezone: "Europe/Athens" });
  });
  it("returns null for text, empty objects and non-JSON", () => {
    expect(parseSlackProfile("Ana is a Staff Engineer")).toBeNull();
    expect(parseSlackProfile("{}")).toBeNull();
    expect(parseSlackProfile("[1,2]")).toBeNull();
  });
  it("is fresh for 24 hours", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(profileIsFresh(new Date(now - PROFILE_TTL_MS + 1000).toISOString(), now)).toBe(true);
    expect(profileIsFresh(new Date(now - PROFILE_TTL_MS - 1000).toISOString(), now)).toBe(false);
    expect(profileIsFresh(undefined, now)).toBe(false);
    expect(profileIsFresh("garbage", now)).toBe(false);
  });
});

describe("activity filter on every saved field", () => {
  it("catches activity phrased several ways, and keeps work that mentions being active", () => {
    for (const t of ["Sent 12 new messages today", "twelve messages in #infra", "Was active until midnight", "Active for 6 hours", "Replies a day: lots, many messages a day", "messages per day: 40", "Often idle on Slack", "Very active in the channel"]) {
      expect(isActivityMetric(t), t).toBe(true);
    }
    for (const t of ["Has been active on the migration", "Is active in the platform working group", "Raised the rollback plan"]) {
      expect(isActivityMetric(t), t).toBe(false);
    }
  });
  it("drops activity sentences from free text and keeps the rest", () => {
    expect(stripActivity("Led the billing migration. Was online until midnight. Needs review help.")).toBe("Led the billing migration. Needs review help.");
    expect(stripActivity("Sent 40 messages today")).toBeUndefined();
    expect(stripActivity(undefined)).toBeUndefined();
  });
  it("applies to summary, questions, follow-ups, recent and source notes", () => {
    const base = { personId: "p", personName: "Ana", date: "2026-11-18" };
    const b = normalisePrepInput({
      summary: "Ana shipped the importer. She sent 80 messages this week.",
      questions: ["How is the migration going?", "Why only 3 hours online?"],
      followUps: ["Send the doc", "Reply time is 4 minutes"],
      recent: [{ text: "Posted 12 messages in #platform" }, { text: "Fixed the importer" }],
      sources: [{ name: "Slack", status: "ok", note: "Was online all day" }, { name: "Jira", status: "ok", note: "2 tickets about the importer" }],
    }, base, new Date("2026-11-18T10:00:00Z"));
    expect(b.summary).toBe("Ana shipped the importer.");
    expect(b.questions).toEqual(["How is the migration going?"]);
    expect(b.followUps).toEqual(["Send the doc"]);
    expect(b.recent.map((r) => r.text)).toEqual(["Fixed the importer"]);
    expect(b.sources.map((s) => s.note)).toEqual([undefined, undefined]);
  });
});
