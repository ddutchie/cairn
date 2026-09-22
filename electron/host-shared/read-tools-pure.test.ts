import { describe, it, expect } from "vitest";
import {
  serializeNoteMarkdown,
  serializeProjectMarkdown,
  type CairnSnapshot,
} from "./read-tools-pure";

function snap(): CairnSnapshot {
  return {
    workspaces: [{ id: "ws1", name: "WS" }],
    projects: [{
      id: "p1", workspaceId: "ws1", name: "Alpha", description: "The alpha project.",
      status: "active", priority: "high", tagIds: [], projectSettings: {},
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }],
    notes: [
      {
        id: "n1", projectId: "p1", workspaceId: "ws1", title: "Design",
        content: "# Design\n\nBody of design.", contentText: "Body of design.",
        tagIds: ["t1"], linkedNoteIds: [], linkedCardIds: [], isPinned: false,
        type: "note", folder: "specs", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "dash", projectId: "p1", workspaceId: "ws1", title: "A Dashboard",
        content: "<html></html>", contentText: "", tagIds: [], linkedNoteIds: [], linkedCardIds: [],
        isPinned: false, type: "dashboard", folder: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    columns: [
      { id: "c1", projectId: "p1", workspaceId: "ws1", name: "Todo", type: "todo", order: 0, createdAt: "", updatedAt: "" },
      { id: "c2", projectId: "p1", workspaceId: "ws1", name: "Done", type: "done", order: 1, createdAt: "", updatedAt: "" },
    ],
    cards: [
      { id: "card1", columnId: "c1", projectId: "p1", workspaceId: "ws1", title: "Do the thing",
        description: "with details", priority: "high", linkedNoteIds: [], blockedByIds: [], tagIds: ["t1"],
        order: 0, createdAt: "", updatedAt: "" },
    ],
    tags: [{ id: "t1", workspaceId: "ws1", name: "urgent", color: "#fff" }],
  };
}

describe("serializeNoteMarkdown", () => {
  it("produces a single-H1 doc with tags and no duplicated title", () => {
    const r = serializeNoteMarkdown(snap(), "n1");
    expect("markdown" in r).toBe(true);
    if (!("markdown" in r)) return;
    // Exactly one H1 (the leading duplicate '# Design' in content is stripped)
    expect((r.markdown.match(/^# /gm) || []).length).toBe(1);
    expect(r.markdown).toContain("# Design");
    expect(r.markdown).toContain("**Tags:** #urgent");
    expect(r.markdown).toContain("Body of design.");
  });

  it("returns an error for a missing note", () => {
    expect(serializeNoteMarkdown(snap(), "nope")).toEqual({ error: "Note not found" });
  });
});

describe("serializeProjectMarkdown", () => {
  it("includes metadata, board grouped by column, and notes", () => {
    const r = serializeProjectMarkdown(snap(), "p1");
    expect("markdown" in r).toBe(true);
    if (!("markdown" in r)) return;
    const md = r.markdown;
    expect(md).toContain("# Alpha");
    expect(md).toContain("The alpha project.");
    expect(md).toContain("Status: active");
    expect(md).toContain("## Board");
    expect(md).toContain("### Todo");
    expect(md).toContain("**Do the thing**");
    expect(md).toContain("with details");
    expect(md).toContain("## Notes");
    expect(md).toContain("### specs/Design");
  });

  it("excludes dashboards from the notes section", () => {
    const r = serializeProjectMarkdown(snap(), "p1");
    if (!("markdown" in r)) throw new Error("expected markdown");
    expect(r.markdown).not.toContain("A Dashboard");
  });

  it("omits empty columns (Done has no cards)", () => {
    const r = serializeProjectMarkdown(snap(), "p1");
    if (!("markdown" in r)) throw new Error("expected markdown");
    expect(r.markdown).not.toContain("### Done");
  });

  it("returns an error for a missing project", () => {
    expect(serializeProjectMarkdown(snap(), "nope")).toEqual({ error: "Project not found" });
  });
});
