/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the pure state transitions in the board slice:
 *   - moveCard   — cross/same-column reindex math
 *   - getReadyCards — blocker-resolution + done/archived filtering
 *
 * Runs in the node env (isElectron() === false), so IPC is a no-op. The
 * historyManager singleton is touched by moveCard but its side effects don't
 * affect the assertions here.
 */

import { describe, it, expect } from "vitest";
import { createBoardSlice } from "./board";
import type { BoardColumn, TaskCard } from "@/types";

const col = (id: string, projectId: string, type: string, order = 0): BoardColumn =>
  ({ id, projectId, workspaceId: "ws-1", name: id, type, order, createdAt: "", updatedAt: "" } as unknown as BoardColumn);

const card = (
  id: string,
  columnId: string,
  order: number,
  extra: Partial<TaskCard> = {},
): TaskCard =>
  ({
    id,
    columnId,
    projectId: "proj-1",
    workspaceId: "ws-1",
    title: id,
    tagIds: [],
    priority: "medium",
    linkedNoteIds: [],
    blockedByIds: [],
    order,
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as unknown as TaskCard);

function setup(initial: any = {}) {
  let state: any = { persist: () => {}, columns: [], cards: [], notes: [], ...initial };
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createBoardSlice(mockSet, mockGet, {} as any);
  state = { ...state, ...slice, ...initial };
  return { get: () => state };
}

// Helper: cards in a column sorted by order, as [id, order] pairs.
const colState = (get: () => any, columnId: string) =>
  get().cards
    .filter((c: TaskCard) => c.columnId === columnId)
    .sort((a: TaskCard, b: TaskCard) => a.order - b.order)
    .map((c: TaskCard) => [c.id, c.order] as const);

describe("moveCard", () => {
  it("reorders within the same column (move to front)", () => {
    const { get } = setup({
      columns: [col("c1", "proj-1", "todo")],
      cards: [card("a", "c1", 0), card("b", "c1", 1), card("x", "c1", 2)],
    });

    get().moveCard("x", "c1", 0);

    expect(colState(get, "c1")).toEqual([
      ["x", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("reorders within the same column (move to end)", () => {
    const { get } = setup({
      columns: [col("c1", "proj-1", "todo")],
      cards: [card("a", "c1", 0), card("b", "c1", 1), card("x", "c1", 2)],
    });

    get().moveCard("a", "c1", 2);

    expect(colState(get, "c1")).toEqual([
      ["b", 0],
      ["x", 1],
      ["a", 2],
    ]);
  });

  it("moves a card to another column and reindexes both", () => {
    const { get } = setup({
      columns: [col("c1", "proj-1", "todo"), col("c2", "proj-1", "in_progress")],
      cards: [
        card("a", "c1", 0),
        card("b", "c1", 1),
        card("c", "c2", 0),
      ],
    });

    // Move "a" into c2 at index 0.
    get().moveCard("a", "c2", 0);

    // Source column reindexed contiguously.
    expect(colState(get, "c1")).toEqual([["b", 0]]);
    // Target column has the moved card at front, existing card shifted.
    expect(colState(get, "c2")).toEqual([
      ["a", 0],
      ["c", 1],
    ]);
    // The moved card's columnId updated.
    expect(get().cards.find((c: TaskCard) => c.id === "a").columnId).toBe("c2");
  });

  it("clamps an out-of-range targetIndex to the end of the column", () => {
    const { get } = setup({
      columns: [col("c1", "proj-1", "todo"), col("c2", "proj-1", "done")],
      cards: [card("a", "c1", 0), card("c", "c2", 0)],
    });

    get().moveCard("a", "c2", 99);

    expect(colState(get, "c2")).toEqual([
      ["c", 0],
      ["a", 1],
    ]);
  });

  it("leaves cards in unrelated columns untouched", () => {
    const { get } = setup({
      columns: [
        col("c1", "proj-1", "todo"),
        col("c2", "proj-1", "in_progress"),
        col("c3", "proj-1", "review"),
      ],
      cards: [
        card("a", "c1", 0),
        card("other", "c3", 0),
      ],
    });

    get().moveCard("a", "c2", 0);

    expect(colState(get, "c3")).toEqual([["other", 0]]);
  });

  it("is a no-op for an unknown card id", () => {
    const { get } = setup({
      columns: [col("c1", "proj-1", "todo")],
      cards: [card("a", "c1", 0)],
    });

    get().moveCard("does-not-exist", "c1", 0);

    expect(colState(get, "c1")).toEqual([["a", 0]]);
  });
});

describe("getReadyCards", () => {
  it("returns active cards with no blockers", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [card("a", "todo", 0), card("b", "todo", 1)],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("excludes cards in a done column", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [card("a", "todo", 0), card("finished", "done", 0)],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["a"]);
  });

  it("excludes archived cards", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [card("a", "todo", 0), card("arch", "todo", 1, { archivedAt: "2026-01-01" } as any)],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["a"]);
  });

  it("excludes a card whose blocker is unresolved", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [
        card("blocker", "todo", 0),
        card("blocked", "todo", 1, { blockedByIds: ["blocker"] }),
      ],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["blocker"]);
  });

  it("includes a card whose blocker is resolved (in a done column)", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [
        card("blocker", "done", 0),
        card("blocked", "todo", 0, { blockedByIds: ["blocker"] }),
      ],
    });

    // blocker is in done (excluded from ready), blocked becomes ready.
    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["blocked"]);
  });

  it("includes a card whose blocker is archived (resolved)", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [
        card("blocker", "todo", 0, { archivedAt: "2026-01-01" } as any),
        card("blocked", "todo", 1, { blockedByIds: ["blocker"] }),
      ],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["blocked"]);
  });

  it("treats an orphan blocker (deleted card) as resolved", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [card("blocked", "todo", 0, { blockedByIds: ["ghost"] })],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["blocked"]);
  });

  it("requires ALL blockers resolved (mixed → not ready)", () => {
    const { get } = setup({
      columns: [col("todo", "proj-1", "todo"), col("done", "proj-1", "done")],
      cards: [
        card("done-blocker", "done", 0),
        card("open-blocker", "todo", 0),
        card("blocked", "todo", 1, { blockedByIds: ["done-blocker", "open-blocker"] }),
      ],
    });

    const ready = get().getReadyCards("proj-1").map((c: TaskCard) => c.id);
    expect(ready).toContain("open-blocker");
    expect(ready).not.toContain("blocked");
  });

  it("scopes results to the given project", () => {
    const { get } = setup({
      columns: [
        col("todo1", "proj-1", "todo"),
        col("todo2", "proj-2", "todo"),
      ],
      cards: [
        card("a", "todo1", 0, { projectId: "proj-1" }),
        card("b", "todo2", 0, { projectId: "proj-2" }),
      ],
    });

    expect(get().getReadyCards("proj-1").map((c: TaskCard) => c.id)).toEqual(["a"]);
  });
});
