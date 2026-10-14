import { describe, it, expect } from "vitest";
import { noteExcerpt, NOTE_EXCERPT_CHARS } from "./excerpt";

const strip = (md: string) => md.replace(/[#*]/g, "").replace(/\s+/g, " ").trim();

describe("noteExcerpt", () => {
  it("is a bounded plain-text prefix of the body", () => {
    const md = `# Title\n\n**bold** ${"word ".repeat(5000)}`;
    const ex = noteExcerpt(md, strip);
    expect(ex.startsWith("Title bold word")).toBe(true);
    expect(ex.length).toBe(NOTE_EXCERPT_CHARS);
  });

  it("is empty for empty bodies", () => {
    expect(noteExcerpt("", strip)).toBe("");
    expect(noteExcerpt(null, strip)).toBe("");
  });
});
