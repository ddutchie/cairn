import { describe, it, expect } from "vitest";
import { isUsableGuide, countHeadings, buildUserStylePromptPair } from "./user-style-handlers";
import { buildUserStyleFullGuidePrompt, buildUserStyleOptimizePrompt } from "../lib/user-style-prompt";

describe("writing-style generation guards", () => {
  it("accepts a well-structured full guide (12 sections)", () => {
    const guide = Array.from({ length: 12 }, (_, i) => `## ${i + 1}. Section ${i}`).join("\n\n");
    expect(isUsableGuide(guide, "full")).toBe(true);
  });

  it("rejects token-soup output with almost no headings", () => {
    const soup = "Voice, direct name specifically and clear genuine, the * Will.\"* \" but is switching after Its the so in Frag fine long and outreach sentences channel org\u2013 get one block, multi Tone ****";
    expect(countHeadings(soup)).toBe(0);
    expect(isUsableGuide(soup, "full")).toBe(false);
    expect(isUsableGuide(soup, "cheatsheet")).toBe(false);
  });

  it("rejects a full guide with too few headings, accepts a small cheat sheet", () => {
    expect(isUsableGuide("## 1. Voice\n## 2. Tone", "full")).toBe(false);
    expect(isUsableGuide("## 1. Voice\n## 2. Tone\n## 3. Rhythm\n## 4. Format", "cheatsheet")).toBe(true);
  });

  it("treats the optimize step with the full-guide threshold", () => {
    const optimized = Array.from({ length: 8 }, (_, i) => `## ${i + 1}. Section ${i}`).join("\n\n");
    expect(isUsableGuide(optimized, "optimize")).toBe(true);
    expect(isUsableGuide("## 1. Voice\n## 2. Tone", "optimize")).toBe(false);
  });

  it("builds an optimize prompt from an existing full guide", () => {
    const { userPrompt } = buildUserStylePromptPair("optimize", {
      persona: { name: "G" },
      samples: [],
      answers: [],
      fullGuide: "## 1. Voice in one line\nWarm.",
    });
    expect(userPrompt).toContain("## Canonical structure");
    expect(userPrompt).toContain("## 1. Voice in one line");
    expect(userPrompt).toContain("Warm.");
  });

  it("caps oversized pasted samples so the prompt stays digestible", () => {
    const prompt = buildUserStyleFullGuidePrompt({
      persona: { name: "G" },
      samples: [{ context: "Pasted doc", text: "x".repeat(5000) }],
      answers: [],
    });
    expect(prompt.length).toBeLessThan(4000);
    expect(prompt).toContain("### Pasted doc");
  });

  it("optimize prompt builder includes the canonical headings", () => {
    const p = buildUserStyleOptimizePrompt("source text");
    expect(p).toContain("## 12. Preserve These Voice Tells");
    expect(p).toContain("source text");
  });
});
