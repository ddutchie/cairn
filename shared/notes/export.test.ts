import { describe, it, expect } from "vitest";
import { buildNoteMarkdown, buildProjectMarkdown } from "./export";

describe("buildNoteMarkdown", () => {
  it("emits one H1, tags, and body (stripping a duplicate title H1)", () => {
    const md = buildNoteMarkdown({
      title: "Design",
      content: "# Design\n\nBody text.",
      tagNames: ["urgent"],
    });
    expect((md.match(/^# /gm) || []).length).toBe(1);
    expect(md).toContain("# Design");
    expect(md).toContain("**Tags:** #urgent");
    expect(md).toContain("Body text.");
  });

  it("keeps a leading H1 that is NOT the title", () => {
    const md = buildNoteMarkdown({ title: "Notes", content: "# Intro\n\nx", tagNames: [] });
    expect(md).toContain("# Intro");
  });

  it("omits the tags line when there are none", () => {
    const md = buildNoteMarkdown({ title: "T", content: "body", tagNames: [] });
    expect(md).not.toContain("**Tags:**");
  });
});

describe("buildProjectMarkdown", () => {
  const base = {
    name: "Alpha",
    description: "Alpha desc.",
    status: "active",
    priority: "high",
    dueDate: null,
    columns: [
      { name: "Todo", cards: [{ title: "Do X", description: "details", priority: "high", dueDate: null, assignee: "sam", tagNames: ["urgent"] }] },
      { name: "Done", cards: [] },
    ],
    notes: [{ title: "Spec", content: "# Spec\n\nspec body", tagNames: [], folder: "docs" }],
  };

  it("includes metadata, board, and notes", () => {
    const md = buildProjectMarkdown(base);
    expect(md).toContain("# Alpha");
    expect(md).toContain("Alpha desc.");
    expect(md).toContain("Status: active");
    expect(md).toContain("## Board");
    expect(md).toContain("### Todo");
    expect(md).toContain("**Do X** _(high, @sam, #urgent)_");
    expect(md).toContain("  details");
    expect(md).toContain("## Notes");
    expect(md).toContain("### docs/Spec");
  });

  it("skips empty columns", () => {
    expect(buildProjectMarkdown(base)).not.toContain("### Done");
  });

  it("omits the board section entirely when no cards", () => {
    const md = buildProjectMarkdown({ ...base, columns: [{ name: "Todo", cards: [] }] });
    expect(md).not.toContain("## Board");
  });
});
