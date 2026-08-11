import { describe, it, expect } from "vitest";
import { withPersonality } from "./tools";

describe("withPersonality", () => {
  const base = "You are the Cairn AI assistant — an intelligent helper.";

  it("returns the prompt unchanged when no personality is given", () => {
    expect(withPersonality(base, undefined)).toBe(base);
    expect(withPersonality(base, { name: "", prompt: "" })).toBe(base);
  });

  it("appends the personality as a delimited style layer", () => {
    const out = withPersonality(base, { name: "Caveman", prompt: "Speak short." });
    expect(out).toContain("## Personality: Caveman");
    expect(out).toContain("Speak short.");
    expect(out.indexOf(base)).toBe(0); // the base Cairn identity stays first
  });
});
