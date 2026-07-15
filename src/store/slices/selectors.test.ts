/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the pure selector slice: searchAll plus the sort/filter
 * behavior of getProjectNotes and getWorkspaceProjects.
 */

import { describe, it, expect } from "vitest";
import { createSelectorsSlice } from "./selectors";
import type { Note, TaskCard, Project } from "@/types";

const note = (id: string, projectId: string, extra: Partial<Note> = {}): Note =>
  ({
    id,
    projectId,
    workspaceId: "ws-1",
    title: id,
    content: "",
    contentText: "",
    tagIds: [],
    linkedNoteIds: [],
    linkedCardIds: [],
    isPinned: false,
    type: "note",
    folder: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as unknown as Note);

const cardItem = (id: string, projectId: string, extra: Partial<TaskCard> = {}): TaskCard =>
  ({
    id,
    columnId: "c1",
    projectId,
    workspaceId: "ws-1",
    title: id,
    tagIds: [],
    priority: "medium",
    linkedNoteIds: [],
    blockedByIds: [],
    order: 0,
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as unknown as TaskCard);

const project = (id: string, workspaceId: string, extra: Partial<Project> = {}): Project =>
  ({ id, workspaceId, name: id, status: "active", priority: "medium", tagIds: [], codeDirectory: null, createdAt: "", updatedAt: "", ...extra } as unknown as Project);

function setup(initial: any = {}) {
  let state: any = { notes: [], cards: [], projects: [], columns: [], ...initial };
  const mockGet = () => state;
  const slice = createSelectorsSlice(() => {}, mockGet, {} as any);
  state = { ...state, ...slice, ...initial };
  return { get: () => state };
}

describe("searchAll", () => {
  it("returns [] for an empty or whitespace query", () => {
    const { get } = setup({ notes: [note("n1", "p1", { title: "hello" })] });
    expect(get().searchAll("")).toEqual([]);
    expect(get().searchAll("   ")).toEqual([]);
  });

  it("matches notes by title (case-insensitive) and includes project name", () => {
    const { get } = setup({
      projects: [project("p1", "ws-1", { name: "Alpha" })],
      notes: [note("n1", "p1", { title: "Meeting Notes" })],
    });
    const results = get().searchAll("meeting");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "note", id: "n1", title: "Meeting Notes", projectName: "Alpha" });
  });

  it("multi-word query matches terms out of order / across title+body (AND-of-terms)", () => {
    const { get } = setup({
      notes: [
        note("n1", "p1", { title: "Authentication flow" }),
        note("n2", "p1", { title: "Login pipeline", contentText: "covers auth and refresh" }),
        note("n3", "p1", { title: "Unrelated", contentText: "nothing here" }),
      ],
    });
    // "auth flow" is NOT a contiguous phrase in either note, but both terms are
    // present in n1 (title) and n2 (title has "flow"? no) — verify per-note:
    expect(get().searchAll("auth flow").map((r: any) => r.id)).toEqual(["n1"]);
    // Terms spread across title + body still match (n2: "auth" in body).
    expect(get().searchAll("login auth").map((r: any) => r.id)).toEqual(["n2"]);
    // A term absent everywhere excludes the note.
    expect(get().searchAll("auth missing")).toEqual([]);
  });

  it("matches notes by contentText and builds a 120-char snippet", () => {
    const longText = "x".repeat(200);
    const { get } = setup({
      notes: [note("n1", "p1", { title: "T", contentText: `needle ${longText}` })],
    });
    const results = get().searchAll("needle");
    expect(results).toHaveLength(1);
    expect(results[0].snippet.length).toBe(120);
  });

  it("matches cards by title and description", () => {
    const { get } = setup({
      cards: [
        cardItem("c1", "p1", { title: "Fix bug" }),
        cardItem("c2", "p1", { title: "Other", description: "contains keyword here" }),
      ],
    });
    expect(get().searchAll("fix").map((r: any) => r.id)).toEqual(["c1"]);
    expect(get().searchAll("keyword").map((r: any) => r.id)).toEqual(["c2"]);
  });

  it("skips archived notes and cards", () => {
    const { get } = setup({
      notes: [note("n1", "p1", { title: "archived match", archivedAt: "2026-01-01" } as any)],
      cards: [cardItem("c1", "p1", { title: "archived match", archivedAt: "2026-01-01" } as any)],
    });
    expect(get().searchAll("match")).toEqual([]);
  });

  it("falls back to empty strings for missing project name / description", () => {
    const { get } = setup({
      // No project registered for p1 → projectName "".
      cards: [cardItem("c1", "p1", { title: "match" })], // no description → snippet ""
    });
    const results = get().searchAll("match");
    expect(results[0].projectName).toBe("");
    expect(results[0].snippet).toBe("");
  });

  it("caps results at 50", () => {
    const notes = Array.from({ length: 80 }, (_, i) => note(`n${i}`, "p1", { title: `match ${i}` }));
    const { get } = setup({ notes });
    expect(get().searchAll("match")).toHaveLength(50);
  });

  it("returns both note and card matches together", () => {
    const { get } = setup({
      notes: [note("n1", "p1", { title: "shared" })],
      cards: [cardItem("c1", "p1", { title: "shared" })],
    });
    const types = get().searchAll("shared").map((r: any) => r.type).sort();
    expect(types).toEqual(["card", "note"]);
  });
});

describe("getProjectNotes", () => {
  it("sorts pinned notes first, then by updatedAt desc", () => {
    const { get } = setup({
      notes: [
        note("old", "p1", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        note("new", "p1", { updatedAt: "2026-06-01T00:00:00.000Z" }),
        note("pinned", "p1", { isPinned: true, updatedAt: "2025-01-01T00:00:00.000Z" }),
      ],
    });
    expect(get().getProjectNotes("p1").map((n: Note) => n.id)).toEqual(["pinned", "new", "old"]);
  });

  it("excludes archived notes and notes from other projects", () => {
    const { get } = setup({
      notes: [
        note("keep", "p1"),
        note("archived", "p1", { archivedAt: "2026-01-01" } as any),
        note("other", "p2"),
      ],
    });
    expect(get().getProjectNotes("p1").map((n: Note) => n.id)).toEqual(["keep"]);
  });

  it("excludes templates from the notes list", () => {
    const { get } = setup({
      notes: [
        note("real", "p1"),
        note("tpl", "p1", { type: "template" } as any),
      ],
    });
    expect(get().getProjectNotes("p1").map((n: Note) => n.id)).toEqual(["real"]);
  });
});

describe("getProjectTemplates", () => {
  it("returns only templates for the project, sorted by title", () => {
    const { get } = setup({
      notes: [
        note("real", "p1"),
        note("Zeta", "p1", { title: "Zeta", type: "template" } as any),
        note("Alpha", "p1", { title: "Alpha", type: "template" } as any),
        note("otherProjTpl", "p2", { type: "template" } as any),
      ],
    });
    expect(get().getProjectTemplates("p1").map((n: Note) => n.title)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("getWorkspaceProjects", () => {
  it("returns non-archived projects for the workspace", () => {
    const { get } = setup({
      projects: [
        project("p1", "ws-1"),
        project("p2", "ws-1", { archivedAt: "2026-01-01" } as any),
        project("p3", "ws-2"),
      ],
    });
    expect(get().getWorkspaceProjects("ws-1").map((p: Project) => p.id)).toEqual(["p1"]);
  });
});
