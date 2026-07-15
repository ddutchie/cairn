import { describe, it, expect } from "vitest";
import {
  instantiateTemplate,
  buildTemplateVars,
  defaultTitleFromTemplate,
} from "./templates";

const NOW = new Date(2026, 6, 15, 9, 5); // Wed 2026-07-15 09:05 (month is 0-based)

describe("buildTemplateVars", () => {
  it("resolves date/time derivatives from an injected now", () => {
    const v = buildTemplateVars({ now: NOW, title: "Standup" });
    expect(v.date).toBe("2026-07-15");
    expect(v.time).toBe("09:05");
    expect(v.datetime).toBe("2026-07-15 09:05");
    expect(v.year).toBe("2026");
    expect(v.month).toBe("July");
    expect(v.title).toBe("Standup");
  });

  it("computes Monday-based weekOf", () => {
    // 2026-07-15 is a Wednesday → week starts Monday 2026-07-13
    expect(buildTemplateVars({ now: NOW }).weekOf).toBe("2026-07-13");
  });
});

describe("instantiateTemplate", () => {
  it("substitutes known variables, tolerating inner whitespace", () => {
    const out = instantiateTemplate("# {{title}} — {{ date }}\n\nWeek of {{weekOf}}", { now: NOW, title: "Review" });
    expect(out).toBe("# Review — 2026-07-15\n\nWeek of 2026-07-13");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(instantiateTemplate("Hello {{unknown}}", { now: NOW })).toBe("Hello {{unknown}}");
  });

  it("replaces all occurrences", () => {
    expect(instantiateTemplate("{{date}} {{date}}", { now: NOW })).toBe("2026-07-15 2026-07-15");
  });

  it("empty title resolves to an empty string, not the placeholder", () => {
    expect(instantiateTemplate("[{{title}}]", { now: NOW })).toBe("[]");
  });
});

describe("defaultTitleFromTemplate", () => {
  it("fills date vars in the template name", () => {
    expect(defaultTitleFromTemplate("Weekly Review — {{weekOf}}", { now: NOW })).toBe("Weekly Review — 2026-07-13");
  });

  it("falls back to the raw title when substitution yields empty", () => {
    expect(defaultTitleFromTemplate("Meeting Notes", { now: NOW })).toBe("Meeting Notes");
  });
});
