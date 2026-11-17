import { describe, it, expect } from "vitest";
import {
  dayBlocks, extractJsonObject, firstSentences, formatMinutes, linkedDraftIds, parseTodayBrief, parseTodayCron, todayCron,
} from "./brief";

const NOW = new Date(2026, 10, 16, 7, 2);

describe("parseTodayBrief", () => {
  it("reads the last json fence and normalises it", () => {
    const text = [
      "I looked at Slack and GitHub.",
      "```json",
      JSON.stringify({
        lede: "Two things need you.",
        focusId: "n2",
        events: [{ title: "Dry run", start: "11:00", end: "12:00" }, { title: "Standup", start: "09:00" }, { title: "Bad", start: "noon" }],
        needYou: [{ id: "n1", title: "Reply to Sam", source: "Slack", draftId: "d1" }, { id: "n2", title: "Review PR #305" }, { body: "no title" }],
        prepared: [{ id: "d1", title: "Reply", kind: "reply", draft: "Yes, Tuesday works." }, { id: "d2", title: "Empty" }],
        fyi: [{ title: "Merged", tone: "good" }, { title: "Odd tone", tone: "loud" }],
        sources: [{ name: "Slack", status: "ok", items: 4 }, { name: "Work IQ", status: "nope" }],
      }),
      "```",
    ].join("\n");
    const b = parseTodayBrief(text, NOW)!;
    expect(b.date).toBe("2026-11-16");
    expect(b.focusId).toBe("n2");
    expect(b.events.map((e) => e.title)).toEqual(["Standup", "Dry run"]);
    expect(b.needYou).toHaveLength(2);
    expect(b.needYou[1].source).toBe("Cairn");
    expect(b.prepared).toHaveLength(1);
    expect(b.fyi[1].tone).toBe("neutral");
    expect(b.sources[1].status).toBe("ok");
  });

  it("drops a draftId that points at no draft and falls back for focus", () => {
    const b = parseTodayBrief('{"needYou":[{"id":"a","title":"x","draftId":"missing"}],"focusId":"zzz"}', NOW)!;
    expect(b.needYou[0].draftId).toBeUndefined();
    expect(b.focusId).toBe("a");
    expect(b.lede).toMatch(/1 thing needs you/);
  });

  it("returns null without a JSON object", () => {
    expect(parseTodayBrief("Sorry, I could not reach Slack.", NOW)).toBeNull();
    expect(parseTodayBrief("```json\n[1,2]\n```", NOW)).toBeNull();
  });

  it("extracts a bare object", () => {
    expect(extractJsonObject('Here: {"a":1} done')).toBe('{"a":1}');
  });
});

describe("decisions", () => {
  it("reads kind, question, facts and choices, and drops choice drafts that don't exist", () => {
    const b = parseTodayBrief(JSON.stringify({
      headline: "Decide on the P4 interview first.",
      needYou: [
        { id: "n1", kind: "decision", question: "Advance Edan to P4?", facts: ["Asked 12:56", "", "b", "c", "d"],
          choices: [{ label: "Yes", draftId: "d1" }, { label: "Hold", draftId: "gone" }, { label: "Ask" }, { label: "Fourth" }] },
        { id: "n2", kind: "decision", title: "No choices given" },
        { id: "n3", kind: "todo", title: "Acknowledge the mention", draftId: "d2" },
      ],
      prepared: [{ id: "d1", title: "Yes", draft: "Go ahead." }, { id: "d2", title: "Ack", draft: "Thanks!" }, { id: "d3", title: "Cards", draft: "1. x" }],
    }), NOW)!;
    expect(b.headline).toBe("Decide on the P4 interview first.");
    const [n1, n2, n3] = b.needYou;
    expect(n1.title).toBe("Advance Edan to P4?");
    expect(n1.kind).toBe("decision");
    expect(n1.facts).toEqual(["Asked 12:56", "b", "c"]);
    expect(n1.choices.map((c) => c.label)).toEqual(["Yes", "Hold", "Ask"]);
    expect(n1.choices[1].draftId).toBeUndefined();
    expect(n2.kind).toBe("todo");
    expect(n3.choices).toEqual([]);
    expect([...linkedDraftIds(b)].sort()).toEqual(["d1", "d2"]);
  });

  it("falls back to a headline and trims a long lede", () => {
    const long = "One. Two is here. Three should go.";
    const b = parseTodayBrief(JSON.stringify({ lede: long, needYou: [{ id: "a", title: "Reply to Sam" }] }), NOW)!;
    expect(b.headline).toBe("Start with: Reply to Sam");
    expect(b.lede).toBe("One. Two is here.");
    expect(firstSentences("a b c d e f", 2, 3)).toBe("a b c…");
    expect(firstSentences("Review the firefly.js PRs today. Saidul needs an answer. Third.", 2, 40))
      .toBe("Review the firefly.js PRs today. Saidul needs an answer.");
  });
});

describe("dayBlocks", () => {
  const events = [
    { id: "a", title: "a", start: "09:00", end: "09:15" },
    { id: "b", title: "b", start: "11:00", end: "12:00" },
    { id: "c", title: "c", start: "12:30", end: "17:30" },
  ];

  it("lays out free and meeting blocks and marks the best free block", () => {
    const d = dayBlocks(events, 0);
    expect(d.blocks.map((b) => [b.kind, b.start, b.end])).toEqual([
      ["free", 480, 540], ["meeting", 540, 555], ["free", 555, 660], ["meeting", 660, 720],
      ["free", 720, 750], ["meeting", 750, 1050], ["free", 1050, 1080],
    ]);
    expect(d.blocks.find((b) => b.best)?.start).toBe(555);
    expect(d.freeLeft).toBe(60 + 105 + 30 + 30);
    expect(d.meetingsLeft).toBe(3);
  });

  it("splits the free block at now, so spent time is not counted", () => {
    const d = dayBlocks(events, 10 * 60);
    const free = d.blocks.filter((b) => b.kind === "free");
    expect(free.slice(0, 3).map((b) => [b.start, b.end, b.past])).toEqual([[480, 540, true], [555, 600, true], [600, 660, false]]);
    expect(d.freeLeft).toBe(60 + 30 + 30);
    expect(d.largestFree).toBe(60);
    expect(d.freeBlocksLeft).toBe(3);
    expect(d.meetingsLeft).toBe(2);
    expect(d.nextMeeting?.title).toBe("b");
  });

  it("merges overlapping meetings for the free-time maths", () => {
    const d = dayBlocks([{ id: "x", title: "x", start: "09:00", end: "10:00" }, { id: "y", title: "y", start: "09:30", end: "10:30" }], 0, { dayStart: 540, dayEnd: 660 });
    expect(d.blocks.filter((b) => b.kind === "free").map((b) => [b.start, b.end])).toEqual([[630, 660]]);
  });

  it("formats minutes", () => {
    expect(formatMinutes(184)).toBe("3h 4m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
  });
});

describe("today cron", () => {
  it("round-trips", () => {
    expect(todayCron("07:05", true)).toBe("cron 5 7 * * 1-5");
    expect(parseTodayCron("cron 5 7 * * 1-5")).toEqual({ time: "07:05", weekdaysOnly: true });
    expect(parseTodayCron("cron 0 9 * * *")).toEqual({ time: "09:00", weekdaysOnly: false });
    expect(parseTodayCron("every 1h")).toEqual({ time: "07:00", weekdaysOnly: true });
  });
});
