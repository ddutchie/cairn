import { describe, it, expect } from "vitest";
import { firstName, guessMeeting, guessPersona, looksLikeName, nameFromTitle, type InventoryNote } from "./inventory";

const note = (over: Partial<InventoryNote> = {}): InventoryNote => ({ id: "n", title: "Ana Ruiz", folder: "", content: "", tagNames: [], ...over });

describe("looksLikeName", () => {
  it.each(["Ana Ruiz", "Ana de la Cruz", "Marie-Claire O'Neil", "Sébastien Morel", "Ana María Ruiz Soto"])("accepts %s", (t) => {
    expect(looksLikeName(t)).toBe(true);
  });
  it.each(["Weekly Sync", "Q4 Planning", "ana ruiz", "Ana", "Notes On Hiring", "One Two Three Four Five", "Retro 2026"])("rejects %s", (t) => {
    expect(looksLikeName(t)).toBe(false);
  });
});

describe("nameFromTitle", () => {
  it("drops the prefix, and turns nicknames into aliases but a role into nothing", () => {
    expect(nameFromTitle("Persona - Elena Fischer")).toEqual({ name: "Elena Fischer", aliases: [] });
    expect(nameFromTitle("Dmitri Volkov (Dima)")).toEqual({ name: "Dmitri Volkov", aliases: ["Dima"] });
    expect(nameFromTitle('Sebastien "Seb" Morel')).toEqual({ name: "Sebastien Morel", aliases: ["Seb"] });
    expect(nameFromTitle("Ana Ruiz (Engineering Manager)")).toEqual({ name: "Ana Ruiz", aliases: [] });
  });
});

describe("guessPersona", () => {
  it("needs a signal: a name-like title alone is nothing", () => {
    expect(guessPersona(note())).toBeNull();
    expect(guessPersona(note({ title: "Weekly Sync", folder: "Notes" }))).toBeNull();
  });
  it("scores tag, frontmatter type, folder and prefix, and says why", () => {
    expect(guessPersona(note({ tagNames: ["Person"] }))).toMatchObject({ confidence: "high" });
    expect(guessPersona(note({ frontmatter: { type: "person", tags: [], aliases: [], emails: [], hasAttendees: false, attendees: undefined, date: undefined } }))).toMatchObject({ confidence: "high" });
    expect(guessPersona(note({ folder: "Work/People" }))).toMatchObject({ confidence: "medium", reasons: expect.arrayContaining([expect.stringContaining("People")]) });
    expect(guessPersona(note({ folder: "Discussions/Ana Ruiz" }))).toMatchObject({ confidence: "medium" });
    expect(guessPersona(note({ title: "Hiring Notes", folder: "People" }))).toMatchObject({ confidence: "low" });
  });
  it("reads emails from the frontmatter and from an Email line, and aliases from the frontmatter", () => {
    const g = guessPersona(note({
      folder: "People",
      content: "- **Email:** Ana@Example.com, other@example.org\n",
      frontmatter: { tags: [], aliases: ["Anita", "Ana Ruiz"], emails: ["a.ruiz@example.com"], hasAttendees: false, attendees: undefined, date: undefined },
    }))!;
    expect(g.emails.sort()).toEqual(["a.ruiz@example.com", "ana@example.com", "other@example.org"]);
    expect(g.aliases).toEqual(["Anita"]); // the name itself is not an alias
  });
});

describe("guessMeeting", () => {
  it("reads body lines and frontmatter, preferring the frontmatter list and date", () => {
    const m = guessMeeting({
      content: "**Attendees:** Ana, Ben\n**When:** 2026-11-03\n",
      frontmatter: { tags: [], aliases: [], emails: [], hasAttendees: true, attendees: ["[[Ana Ruiz]]"], date: "2026-11-09" },
    })!;
    expect(m.via).toEqual(["frontmatter", "body_line"]);
    expect(m.attendees).toEqual([{ name: "Ana Ruiz" }]);
    expect(m.date).toBe("2026-11-09T00:00:00.000Z");
  });
  it("ignores prose, placeholders, code blocks and a date without attendees", () => {
    expect(guessMeeting({ content: "When we met, Attendees were late.\nParticipants: users, admins\n**Attendees:** TBD\n" })).toBeNull();
    expect(guessMeeting({ content: "```\n**Attendees:** Ana\n```\n" })).toBeNull();
    expect(guessMeeting({ content: "x", frontmatter: { tags: [], aliases: [], emails: [], hasAttendees: false, attendees: undefined, date: "2026-11-01" } })).toBeNull();
  });
});

describe("firstName", () => {
  it("is the first word of a multi-word name only", () => {
    expect(firstName("Chris Moreau")).toBe("Chris");
    expect(firstName("Chris")).toBeNull();
    expect(firstName("de la Cruz Ana")).toBeNull();
  });
});
