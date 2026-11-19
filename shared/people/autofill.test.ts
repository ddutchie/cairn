import { describe, it, expect } from "vitest";
import { buildAutofillPrompt, parseAutofill, AUTOFILL_MAX_NOTE_CHARS } from "./autofill";

const NOTE = "# Ana\nRole: Senior Software Engineer on the Sync team.\nBased in Berlin, Germany.";
const reply = (fields: unknown[]) => JSON.stringify({ fields });

describe("parseAutofill", () => {
  it("returns sourced fields in a fixed order", () => {
    const out = parseAutofill(reply([
      { field: "location", value: "Berlin, Germany", quote: "Based in Berlin, Germany." },
      { field: "title", value: "Senior Software Engineer", quote: "Role: Senior Software Engineer" },
    ]), NOTE);
    expect(out.map((p) => p.field)).toEqual(["title", "location"]);
    expect(out[0].value).toBe("Senior Software Engineer");
  });

  it("tolerates a fence and prose around the JSON", () => {
    const out = parseAutofill("Here you go:\n```json\n" + reply([{ field: "team", value: "Sync", quote: "on the Sync team" }]) + "\n```", NOTE);
    expect(out).toHaveLength(1);
  });

  it("drops a value whose quote isn't in the note", () => {
    expect(parseAutofill(reply([{ field: "title", value: "CTO", quote: "Role: CTO" }]), NOTE)).toEqual([]);
  });

  it("drops a value its quote doesn't support", () => {
    expect(parseAutofill(reply([{ field: "title", value: "CTO", quote: "Role: Senior Software Engineer" }]), NOTE)).toEqual([]);
  });

  it("accepts a time zone inferred from a quoted city", () => {
    expect(parseAutofill(reply([{ field: "timezone", value: "Europe/Berlin", quote: "Based in Berlin, Germany." }]), NOTE)).toHaveLength(1);
  });

  it("drops unknown fields, empty values and a bad time zone", () => {
    expect(parseAutofill(reply([
      { field: "salary", value: "1", quote: "Role" },
      { field: "team", value: " ", quote: "Sync team" },
      { field: "timezone", value: "Berlin time", quote: "Berlin" },
    ]), NOTE)).toEqual([]);
  });

  it("skips what the person already has and reports a different current value", () => {
    const out = parseAutofill(reply([
      { field: "title", value: "Senior Software Engineer", quote: "Senior Software Engineer" },
      { field: "team", value: "Sync", quote: "Sync team" },
    ]), NOTE, { title: "senior software engineer", team: "Platform" });
    expect(out).toEqual([{ field: "team", value: "Sync", quote: "Sync team", current: "Platform" }]);
  });

  it("returns nothing for a reply that isn't JSON", () => {
    expect(parseAutofill("I could not find anything.", NOTE)).toEqual([]);
  });
});

describe("buildAutofillPrompt", () => {
  it("cuts a very long note", () => {
    const p = buildAutofillPrompt("Ana", "x".repeat(AUTOFILL_MAX_NOTE_CHARS + 50));
    expect(p).toContain("[cut]");
  });
});
