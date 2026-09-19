/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for the memoized selectors in selectors.ts.
 *
 * Supplements selectors.test.ts (which covers search/sort/filter behavior)
 * with the memoization contract:
 *   - memoized selectors return STABLE references across unrelated state changes;
 *   - getScopedCards is order-insensitive;
 *   - getActiveProject/getActiveWorkspace resolve correctly + undefined when unset;
 *   - Phase-6 bugfix pin: getProjectColumns sorts a COPY — the source `columns`
 *     array in state must never be mutated by calling the selector, and sorting
 *     a copy of the returned array must not corrupt the cache.
 */

import { describe, it, expect } from "vitest";
import { createSelectorsSlice } from "./selectors";
import type { Note, TaskCard, Project, BoardColumn } from "@/types";

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

const column = (id: string, projectId: string, order: number): BoardColumn =>
  ({ id, projectId, workspaceId: "ws-1", title: id, order } as unknown as BoardColumn);

function setup(initial: any = {}) {
  let state: any = {
    notes: [],
    cards: [],
    projects: [],
    columns: [],
    workspaces: [],
    activeProjectId: null,
    activeWorkspaceId: null,
    ...initial,
  };
  const mockGet = () => state;
  const slice = createSelectorsSlice(() => {}, mockGet, {} as any);
  state = { ...state, ...slice, ...initial };
  const replace = (patch: any) => {
    state = { ...state, ...patch };
  };
  return { get: () => state, replace };
}

describe("memoized selector stability", () => {
  it("returns stable references across repeated calls with unchanged state", () => {
    const { get } = setup({
      notes: [note("n1", "p1")],
      columns: [column("c1", "p1", 0)],
      cards: [cardItem("card1", "p1")],
      projects: [project("p1", "ws-1")],
    });
    expect(get().getProjectNotes("p1")).toBe(get().getProjectNotes("p1"));
    expect(get().getProjectColumns("p1")).toBe(get().getProjectColumns("p1"));
    expect(get().getColumnCards("c1")).toBe(get().getColumnCards("c1"));
    expect(get().getProjectCards("p1")).toBe(get().getProjectCards("p1"));
    expect(get().getWorkspaceProjects("ws-1")).toBe(get().getWorkspaceProjects("ws-1"));
    expect(get().getScopedCards(["p1"])).toBe(get().getScopedCards(["p1"]));
  });

  it("keeps cached results when unrelated state changes", () => {
    const notes = [note("n1", "p1")];
    const cards = [cardItem("card1", "p1")];
    const columns = [column("c1", "p1", 0)];
    const { get, replace } = setup({ notes, cards, columns });
    const notesBefore = get().getProjectNotes("p1");
    const colsBefore = get().getProjectColumns("p1");

    // Unrelated writes replace their own arrays; the notes/columns/cards
    // references stay identical (Zustand replaces arrays on every write).
    replace({ cards: [...cards, cardItem("card2", "p1")] });
    expect(get().getProjectNotes("p1")).toBe(notesBefore);
    expect(get().getProjectColumns("p1")).toBe(colsBefore);

    // The cards write above invalidated the scoped-cards entry (its dep
    // changed) — re-baseline, then change notes: cards ref is now stable so
    // the scoped cache for the same key must survive.
    const scopedRebased = get().getScopedCards(["p1"]);
    expect(scopedRebased.map((c: TaskCard) => c.id).sort()).toEqual(["card1", "card2"]);
    replace({ notes: [...notes, note("n2", "p1")] });
    expect(get().getScopedCards(["p1"])).toBe(scopedRebased);
  });

  it("recomputes when the source array reference changes", () => {
    const { get, replace } = setup({ notes: [note("n1", "p1")] });
    const before = get().getProjectNotes("p1");
    replace({ notes: [note("n1", "p1")] }); // new array, same content
    const after = get().getProjectNotes("p1");
    expect(after).not.toBe(before);
    expect(after.map((n: Note) => n.id)).toEqual(["n1"]);
  });
});

describe("getScopedCards", () => {
  it("is order-insensitive (same set, any order → same result)", () => {
    const { get } = setup({
      cards: [cardItem("a", "p1"), cardItem("b", "p2"), cardItem("c", "p3")],
    });
    const fwd = get().getScopedCards(["p1", "p2"]);
    const rev = get().getScopedCards(["p2", "p1"]);
    expect(rev).toBe(fwd); // same cache entry via the sorted key
    expect(fwd.map((c: TaskCard) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("excludes archived cards and projects outside the scope", () => {
    const { get } = setup({
      cards: [
        cardItem("keep", "p1"),
        cardItem("arch", "p1", { archivedAt: "2026-01-01" } as any),
        cardItem("other", "p9"),
      ],
    });
    expect(get().getScopedCards(["p1"]).map((c: TaskCard) => c.id)).toEqual(["keep"]);
  });
});

describe("getActiveProject / getActiveWorkspace", () => {
  it("resolves the active project and workspace by id", () => {
    const { get } = setup({
      projects: [project("p1", "ws-1", { name: "Alpha" }), project("p2", "ws-1")],
      workspaces: [{ id: "ws-1", name: "Main" }],
      activeProjectId: "p1",
      activeWorkspaceId: "ws-1",
    });
    expect(get().getActiveProject()?.id).toBe("p1");
    expect(get().getActiveProject()?.name).toBe("Alpha");
    expect(get().getActiveWorkspace()?.id).toBe("ws-1");
  });

  it("returns undefined when nothing is selected or the id is unknown", () => {
    const { get, replace } = setup({
      projects: [project("p1", "ws-1")],
      workspaces: [{ id: "ws-1", name: "Main" }],
    });
    expect(get().getActiveProject()).toBeUndefined();
    expect(get().getActiveWorkspace()).toBeUndefined();

    replace({ activeProjectId: "nope", activeWorkspaceId: "nope" });
    expect(get().getActiveProject()).toBeUndefined();
    expect(get().getActiveWorkspace()).toBeUndefined();
  });
});

describe("getProjectColumns Phase-6 bugfix (sort a copy)", () => {
  it("sorts by order without mutating the source columns array", () => {
    const cols = [column("c2", "p1", 2), column("c0", "p1", 0), column("c1", "p1", 1)];
    const { get } = setup({ columns: cols });
    const result = get().getProjectColumns("p1");
    expect(result.map((c: BoardColumn) => c.id)).toEqual(["c0", "c1", "c2"]);
    // The state array itself must keep its original order.
    expect(cols.map((c) => c.id)).toEqual(["c2", "c0", "c1"]);
  });

  it("sorting a copy of the result does not corrupt the cache", () => {
    const { get } = setup({
      columns: [column("c0", "p1", 0), column("c1", "p1", 1)],
    });
    const first = get().getProjectColumns("p1");
    // Callers that need a different order must sort a copy — that must leave
    // the memoized entry untouched for the next caller.
    const reordered = [...first].sort((a, b) => b.order - a.order);
    expect(reordered.map((c: BoardColumn) => c.id)).toEqual(["c1", "c0"]);
    const second = get().getProjectColumns("p1");
    expect(second).toBe(first);
    expect(second.map((c: BoardColumn) => c.id)).toEqual(["c0", "c1"]);
  });
});
