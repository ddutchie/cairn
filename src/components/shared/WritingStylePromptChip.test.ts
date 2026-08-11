import { describe, expect, it } from "vitest";
import { writingStyleNeedsSetup } from "./WritingStylePromptChip";

describe("writingStyleNeedsSetup", () => {
  it("is true when the tool output reports configured: false", () => {
    const output = JSON.stringify({ configured: false, message: "No writing style set up yet" });
    expect(writingStyleNeedsSetup(output)).toBe(true);
  });

  it("is false when a style is configured", () => {
    const output = JSON.stringify({ configured: true, markdown: "## 1. Voice in one line" });
    expect(writingStyleNeedsSetup(output)).toBe(false);
  });

  it("is false for empty / non-JSON / unrelated output", () => {
    expect(writingStyleNeedsSetup(undefined)).toBe(false);
    expect(writingStyleNeedsSetup("")).toBe(false);
    expect(writingStyleNeedsSetup("not json")).toBe(false);
    expect(writingStyleNeedsSetup(JSON.stringify({ mode: "full", markdown: null }))).toBe(false);
  });
});
