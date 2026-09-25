import { describe, it, expect } from "vitest";
import { noteExcerpt, NOTE_EXCERPT_CHARS } from "./excerpt";

const strip = (md: string) => md.replace(/[#*]/g, "").replace(/\s+/g, " ").trim();

describe("noteExcerpt", () => {
  it("is a bounded plain-text prefix of the body", () => {
    const md = `# Title\n\n**bold** ${"word ".repeat(5000)}`;
    const ex = noteExcerpt(md, "note", strip);
    expect(ex.startsWith("Title bold word")).toBe(true);
    expect(ex.length).toBe(NOTE_EXCERPT_CHARS);
  });

  it("is empty for dashboards and empty bodies", () => {
    expect(noteExcerpt("<html>…</html>", "dashboard", strip)).toBe("");
    expect(noteExcerpt("", "note", strip)).toBe("");
    expect(noteExcerpt(null, "note", strip)).toBe("");
  });
});
