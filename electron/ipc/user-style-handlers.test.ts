import { describe, it, expect } from "vitest";
import { isUsableGuide, countHeadings } from "./user-style-handlers";
import { buildUserStyleFullGuidePrompt } from "../lib/user-style-prompt";

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

  it("caps oversized pasted samples so the prompt stays digestible", () => {
    const prompt = buildUserStyleFullGuidePrompt({
      persona: { name: "G" },
      samples: [{ context: "Pasted doc", text: "x".repeat(5000) }],
      answers: [],
    });
    expect(prompt.length).toBeLessThan(4000);
    expect(prompt).toContain("### Pasted doc");
  });
});
