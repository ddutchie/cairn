import { describe, expect, it } from "vitest";
import { columnIdFor, deriveTitle, fallbackProposal, normalizeProposal } from "./proposal";
import type { CaptureContext } from "./types";

const ctx: CaptureContext = {
  projects: [
    { id: "p1", name: "Kitchen", columns: [{ id: "c1", name: "Backlog", type: "backlog" }, { id: "c2", name: "To do", type: "todo" }] },
    { id: "p2", name: "Work", columns: [] },
  ],
  tags: ["home"],
  candidates: [
    { noteId: "n1", title: "Tile options", projectId: "p1", rank: 0.9 },
    { noteId: "n2", title: "Budget", projectId: "p1", rank: 0.6 },
  ],
  projectScores: [{ projectId: "p1", score: 1.2 }],
  recentProjectId: "p2",
  today: "2026-10-17",
};

describe("deriveTitle", () => {
  it("uses the first meaningful line with markdown stripped", () => {
    expect(deriveTitle("\n\n## Call the plumber\nabout the sink")).toBe("Call the plumber");
    expect(deriveTitle("- [ ] buy milk")).toBe("buy milk");
  });
  it("cuts long lines on a word boundary", () => {
    const t = deriveTitle("word ".repeat(40));
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith("…")).toBe(true);
  });
  it("has a default for empty text", () => {
    expect(deriveTitle("   \n ")).toBe("Quick capture");
  });
});

describe("columnIdFor", () => {
  it("finds the column by type, else the first, else null", () => {
    expect(columnIdFor(ctx.projects[0], "todo")).toBe("c2");
    expect(columnIdFor(ctx.projects[0], "done")).toBe("c1");
    expect(columnIdFor(ctx.projects[1], "todo")).toBeNull();
  });
});

describe("fallbackProposal", () => {
  it("files a plain note in the best-ranked project", () => {
    const p = fallbackProposal("Grout colour idea", ctx)!;
    expect(p).toMatchObject({ projectId: "p1", source: "fallback", tasks: [] });
    expect(p.note).toEqual({ title: "Grout colour idea", body: "Grout colour idea" });
  });
  it("is null with no projects", () => {
    expect(fallbackProposal("x", { ...ctx, projects: [], projectScores: [], recentProjectId: null })).toBeNull();
  });
});

describe("normalizeProposal", () => {
  it("accepts a well-formed proposal", () => {
    const p = normalizeProposal(
      {
        projectId: "p1",
        note: { title: "Tile shortlist", body: "Three tiles" },
        tasks: [{ title: "Order samples", priority: "high", dueDate: "2026-10-20", columnType: "todo" }],
        tagNames: ["home", "#shopping"],
        linkNoteIds: ["n1"],
        reason: "About the kitchen",
      },
      ctx,
      "raw",
    )!;
    expect(p.source).toBe("ai");
    expect(p.projectId).toBe("p1");
    expect(p.tasks[0]).toEqual({ title: "Order samples", priority: "high", dueDate: "2026-10-20", columnType: "todo" });
    expect(p.tagNames).toEqual(["home", "shopping"]);
    expect(p.linkNoteIds).toEqual(["n1"]);
    expect(p.note!.body).toBe("Three tiles\n\nRelated: [[Tile options]]");
  });

  it("replaces a hallucinated project and drops unknown note ids", () => {
    const p = normalizeProposal({ projectId: "nope", note: { title: "t", body: "b" }, linkNoteIds: ["ghost", "n2"] }, ctx, "raw")!;
    expect(p.projectId).toBe("p1");
    expect(p.linkNoteIds).toEqual(["n2"]);
  });

  it("does not duplicate a wikilink the body already has", () => {
    const p = normalizeProposal({ projectId: "p1", note: { title: "t", body: "see [[Budget]]" }, linkNoteIds: ["n2"] }, ctx, "raw")!;
    expect(p.note!.body).toBe("see [[Budget]]");
  });

  it("drops past, malformed and impossible due dates", () => {
    const p = normalizeProposal(
      {
        projectId: "p1",
        tasks: [
          { title: "past", dueDate: "2026-10-16" },
          { title: "bad", dueDate: "tomorrow" },
          { title: "feb30", dueDate: "2027-02-30" },
          { title: "today", dueDate: "2026-10-17" },
        ],
      },
      ctx,
      "raw",
    )!;
    expect(p.tasks.map((t) => t.dueDate)).toEqual([undefined, undefined, undefined, "2026-10-17"]);
  });

  it("drops empty tasks, bad enums, and caps tags and tasks", () => {
    const p = normalizeProposal(
      {
        projectId: "p1",
        tasks: [{ title: "  " }, { title: "ok", priority: "asap", columnType: "later" }, ...Array.from({ length: 12 }, (_, i) => ({ title: `t${i}` }))],
        tagNames: ["A", "a", "b", "c", "d", "e", "f", "x".repeat(40)],
      },
      ctx,
      "raw",
    )!;
    expect(p.tasks[0]).toEqual({ title: "ok" });
    expect(p.tasks).toHaveLength(8);
    expect(p.tagNames).toEqual(["A", "b", "c", "d", "e"]);
  });

  it("falls back to a note of the raw text when the model gives neither note nor tasks", () => {
    const p = normalizeProposal({ projectId: "p1" }, ctx, "Remember to stretch")!;
    expect(p.note).toEqual({ title: "Remember to stretch", body: "Remember to stretch" });
  });

  it("uses the raw text as the body when the note body is empty", () => {
    const p = normalizeProposal({ projectId: "p1", note: { title: "Idea", body: "" } }, ctx, "the full text")!;
    expect(p.note).toEqual({ title: "Idea", body: "the full text" });
  });

  it("falls back for non-object output and is null with no projects", () => {
    expect(normalizeProposal("garbage", ctx, "x")!.source).toBe("fallback");
    expect(normalizeProposal({}, { ...ctx, projects: [], projectScores: [], recentProjectId: null }, "x")).toBeNull();
  });
});
