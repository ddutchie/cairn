import { describe, it, expect } from "vitest";
import "./place-data";
import { applicableFields, buildAutofillPrompt, parseAutofill, AUTOFILL_MAX_NOTE_CHARS } from "./autofill";

const NOTE = "# Ana\nRole: Senior Software Engineer on the Sync team.\nBased in Berlin, Germany.";
const reply = (fields: unknown[]) => JSON.stringify({ fields });

describe("parseAutofill", () => {
  it("returns sourced fields in a fixed order", () => {
    const out = parseAutofill(reply([
      { field: "location", value: "Berlin, Germany", quote: "Based in Berlin, Germany." },
      { field: "title", value: "Senior Software Engineer", quote: "Role: Senior Software Engineer" },
    ]), NOTE);
    // A place that names a zone also proposes the zone, quoted from the same words.
    expect(out.map((p) => p.field)).toEqual(["title", "location", "timezone"]);
    expect(out[0].value).toBe("Senior Software Engineer");
    expect(out[2]).toEqual({ field: "timezone", value: "Europe/Berlin", quote: "Based in Berlin, Germany." });
  });

  it("still infers the zone from a location the person already has", () => {
    const loc = { field: "location", value: "Berlin, Germany", quote: "Based in Berlin, Germany." };
    const out = parseAutofill(reply([loc]), NOTE, { location: "berlin, germany" });
    expect(out).toEqual([{ field: "timezone", value: "Europe/Berlin", quote: "Based in Berlin, Germany." }]);
  });

  it("withholds the inferred zone when the stored location differs from the sourced one", () => {
    const loc = { field: "location", value: "Berlin, Germany", quote: "Based in Berlin, Germany." };
    const out = parseAutofill(reply([loc]), NOTE, { location: "Paris, France" });
    // The location change is offered (the user may reject it), but its zone is not: applying only the zone would pair Paris with Berlin's.
    expect(out.map((p) => p.field)).toEqual(["location"]);
  });

  it("does not propose a zone for a place when one is already set or already proposed", () => {
    const loc = { field: "location", value: "Berlin, Germany", quote: "Based in Berlin, Germany." };
    expect(parseAutofill(reply([loc]), NOTE, { timezone: "Europe/London" }).map((p) => p.field)).toEqual(["location"]);
    const tz = { field: "timezone", value: "Europe/Paris", quote: "Based in Berlin, Germany." };
    expect(parseAutofill(reply([loc, tz]), NOTE).find((p) => p.field === "timezone")?.value).toBe("Europe/Paris");
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

describe("applicableFields", () => {
  const props = [
    { field: "title" as const, value: "Engineer", quote: "q" },
    { field: "team" as const, value: "Sync", quote: "q", current: "Old" },
    { field: "location" as const, value: "Berlin", quote: "q" },
  ];
  const all = () => true;

  it("writes fields that still match what the review saw", () => {
    expect(applicableFields(props, all, { team: "Old" })).toEqual({ patch: { title: "Engineer", team: "Sync", location: "Berlin" }, changed: 0, done: 0 });
  });

  it("leaves fields that moved since the review, and counts those already saved as done", () => {
    const r = applicableFields(props, all, { title: "Staff", team: "Sync", location: " " });
    expect(r).toEqual({ patch: { location: "Berlin" }, changed: 1, done: 1 });
  });

  it("ignores unpicked fields", () => {
    expect(applicableFields(props, (f) => f === "title", {}).patch).toEqual({ title: "Engineer" });
  });
});
