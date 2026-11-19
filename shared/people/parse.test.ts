import { describe, it, expect } from "vitest";
import {
  foldName, formatMeetingDate, parseAttendeeList, parseAttendeeValue, parseBodyMeetingLines, parseChecklist, parseMeetingDate, splitAttendeeValues,
} from "./parse";

describe("foldName", () => {
  it("ignores case, accents and spacing but keeps different names apart", () => {
    expect(foldName("Sébastien  Morel")).toBe(foldName("sebastien morel"));
    expect(foldName("Sebastian Morel")).not.toBe(foldName("Sebastien Morel"));
  });
});

describe("parseAttendeeValue", () => {
  it.each([
    ["[[Chris Sponagle]]", { name: "Chris Sponagle" }],
    ["[[Chris Sponagle|Chris]]", { name: "Chris Sponagle" }],
    ["[[Discussions/Chris Sponagle]]", { name: "Chris Sponagle" }],
    ["[[Chris Sponagle#Notes]]", { name: "Chris Sponagle" }],
    ["Chris@Example.com", { email: "chris@example.com" }],
    ["Chris Sponagle <chris@example.com>", { name: "Chris Sponagle", email: "chris@example.com" }],
    ["@Chris", { name: "Chris" }],
    ["**Chris**", { name: "Chris" }],
    ["  Elisa Tagliacozzo ", { name: "Elisa Tagliacozzo" }],
  ])("%s", (raw, expected) => {
    expect(parseAttendeeValue(raw)).toEqual(expected);
  });

  it("rejects empty and non-string values", () => {
    expect(parseAttendeeValue("  ")).toBeNull();
    expect(parseAttendeeValue(42)).toBeNull();
    expect(parseAttendeeValue("[[]]")).toBeNull();
  });
});

describe("parseAttendeeList", () => {
  it("splits a line, keeps wikilinks whole and drops duplicates", () => {
    expect(parseAttendeeList("[[Morel, Sebastien]], Chris and Gerard; chris")).toEqual([
      { name: "Morel, Sebastien" }, { name: "Chris" }, { name: "Gerard" },
    ]);
  });

  it("takes a YAML array", () => {
    expect(parseAttendeeList(["[[A]]", "b@x.io", 3, ""])).toEqual([{ name: "A" }, { email: "b@x.io" }]);
  });
});

describe("parseMeetingDate", () => {
  it("normalises the forms people write", () => {
    expect(parseMeetingDate("2026-11-11")).toBe("2026-11-11T00:00:00.000Z");
    expect(parseMeetingDate(new Date("2026-11-11T00:00:00Z"))).toBe("2026-11-11T00:00:00.000Z");
    expect(parseMeetingDate("2026-11-11T15:00:00Z")).toBe("2026-11-11T15:00:00.000Z");
    expect(parseMeetingDate("2026-11-11 15:00")).toMatch(/^2026-11-11T/);
    expect(parseMeetingDate("next Tuesday")).toBeNull();
    expect(parseMeetingDate(undefined)).toBeNull();
  });

  it("writes a date-only value back as a day", () => {
    expect(formatMeetingDate("2026-11-11T00:00:00.000Z")).toBe("2026-11-11");
    expect(formatMeetingDate("2026-11-11T15:00:00.000Z")).toBe("2026-11-11T15:00:00.000Z");
  });
});

describe("parseBodyMeetingLines", () => {
  it("reads bold and plain metadata lines", () => {
    const body = "# Weekly sync\n\n**Attendees:** [[Chris Sponagle]], [[Sebastien Morel]], Gerard\n**When:** 2026-11-11, 15:00 CET\n\nNotes…";
    expect(parseBodyMeetingLines(body)).toEqual({
      attendees: [{ name: "Chris Sponagle" }, { name: "Sebastien Morel" }, { name: "Gerard" }],
      date: "2026-11-11T00:00:00.000Z",
    });
    expect(parseBodyMeetingLines("- Participants: A, B\n- Date: 2026-01-02")).toEqual({
      attendees: [{ name: "A" }, { name: "B" }], date: "2026-01-02T00:00:00.000Z",
    });
    expect(parseBodyMeetingLines("**Attendees**: A")?.attendees).toEqual([{ name: "A" }]);
  });

  it("ignores prose and notes without an attendee line", () => {
    expect(parseBodyMeetingLines("When we met, Attendees were few.\nDate night")).toBeNull();
    expect(parseBodyMeetingLines("**When:** 2026-11-11")).toBeNull();
  });
});

describe("parseChecklist", () => {
  it("reads owners in the three forms and leaves ownerless lines alone", () => {
    const body = [
      "- [ ] **Chris** - validate the hospital PR",
      "- [x] [[Sebastien Morel]]: review the eval harness",
      "* [ ] @Gerard to send the deck",
      "- [ ] **Team** – write the runbook",
      "- [ ] Plain item",
      "```",
      "- [ ] **Code** - not a task",
      "```",
    ].join("\n");
    const items = parseChecklist(body);
    expect(items.map((i) => [i.owner?.name ?? null, i.text, i.done])).toEqual([
      ["Chris", "validate the hospital PR", false],
      ["Sebastien Morel", "review the eval harness", true],
      ["Gerard", "send the deck", false],
      ["Team", "write the runbook", false],
      [null, "Plain item", false],
    ]);
    expect(items[0].line).toBe(0);
  });
});

describe("review fixes", () => {
  it("splits and/& outside wikilinks but not inside", () => {
    expect(splitAttendeeValues("[[Ana]] and Ben & Cal")).toEqual(["[[Ana]]", "Ben", "Cal"]);
    expect(splitAttendeeValues("[[Smith and Wesson]], Dana")).toEqual(["[[Smith and Wesson]]", "Dana"]);
    expect(parseAttendeeList("[[Ana]] and Ben").map((r) => r.name)).toEqual(["Ana", "Ben"]);
    expect(splitAttendeeValues("Brandon")).toEqual(["Brandon"]);
  });

  it("rejects impossible dates", () => {
    expect(parseMeetingDate("2026-99-99")).toBeNull();
    expect(parseMeetingDate("2026-02-30")).toBeNull();
    expect(parseMeetingDate("2026-02-30 10:00")).toBeNull();
    expect(parseMeetingDate("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
  });

  it("accepts real dates in years 0000-0099", () => {
    expect(parseMeetingDate("0001-01-01")).toBe("0001-01-01T00:00:00.000Z");
    expect(parseMeetingDate("0099-12-31")).toBe("0099-12-31T00:00:00.000Z");
    expect(parseMeetingDate("0001-02-29")).toBeNull();
  });
});
