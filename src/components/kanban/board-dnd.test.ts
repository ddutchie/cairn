/**
 * Unit tests for the Kanban board's pure drag-and-drop logic.
 *
 * Guards two regression-prone behaviors extracted from board.tsx:
 *  - getZoneHit: destructive archive/delete drop-zone hit-testing.
 *  - resolveCardDrop: the column/card move + reorder index math, including the
 *    same-column off-by-one (excluding the dragged card) and no-op detection.
 */

import { describe, it, expect } from "vitest";
import { getZoneHit, resolveCardDrop } from "./board-dnd";
import type { TaskCard, BoardColumn } from "@/types";

// ── Fixtures ────────────────────────────────────────────────────────────────
const col = (id: string): BoardColumn =>
  ({ id, projectId: "p", workspaceId: "w", name: id, type: "todo", order: 0,
     createdAt: "", updatedAt: "" }) as BoardColumn;

const card = (id: string, columnId: string): TaskCard =>
  ({ id, columnId, projectId: "p", workspaceId: "w", title: id, tagIds: [],
     priority: "medium", linkedNoteIds: [], blockedByIds: [], order: 0,
     createdAt: "", updatedAt: "", version: 1 }) as TaskCard;

const rect = (left: number, right: number, top = 0, bottom = 50): DOMRect =>
  ({ left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top,
     toJSON: () => ({}) }) as DOMRect;

// ── getZoneHit ────────────────────────────────────────────────────────────────
describe("getZoneHit", () => {
  const bar = rect(0, 200, 100, 150);
  const archive = rect(0, 100, 100, 150);
  const del = rect(100, 200, 100, 150);

  it("returns null when there is no bar rect", () => {
    expect(getZoneHit(50, 120, null, archive, del)).toBeNull();
  });

  it("returns null when the pointer is above or below the bar", () => {
    expect(getZoneHit(50, 90, bar, archive, del)).toBeNull();
    expect(getZoneHit(50, 160, bar, archive, del)).toBeNull();
  });

  it("returns 'archive' when over the archive zone", () => {
    expect(getZoneHit(50, 120, bar, archive, del)).toBe("archive");
  });

  it("returns 'delete' when over the delete zone", () => {
    expect(getZoneHit(150, 120, bar, archive, del)).toBe("delete");
  });

  it("returns null when within the bar vertically but between/outside zones", () => {
    expect(getZoneHit(250, 120, bar, archive, del)).toBeNull();
  });

  it("prefers archive when zones overlap at a boundary", () => {
    const a = rect(0, 100, 100, 150);
    const d = rect(100, 200, 100, 150);
    // x=100 is the shared edge → archive (checked first) wins.
    expect(getZoneHit(100, 120, bar, a, d)).toBe("archive");
  });

  it("ignores zones that are null", () => {
    expect(getZoneHit(150, 120, bar, null, del)).toBe("delete");
    expect(getZoneHit(50, 120, bar, archive, null)).toBe("archive");
  });
});

// ── resolveCardDrop ─────────────────────────────────────────────────────────
describe("resolveCardDrop", () => {
  // Board: todo = [a, b, c], done = [d]
  const columns = [col("todo"), col("done")];
  const byCol: Record<string, TaskCard[]> = {
    todo: [card("a", "todo"), card("b", "todo"), card("c", "todo")],
    done: [card("d", "done")],
  };
  const getColumnCards = (id: string) => byCol[id] ?? [];

  it("appends to the end when dropped on a column", () => {
    const drop = resolveCardDrop(columns, getColumnCards, card("d", "done"), "todo");
    expect(drop).toEqual({ targetColumnId: "todo", targetIndex: 3 });
  });

  it("inserts at the target card's index when moving across columns", () => {
    // Move d (done) onto b (index 1 in todo).
    const drop = resolveCardDrop(columns, getColumnCards, card("d", "done"), "b");
    expect(drop).toEqual({ targetColumnId: "todo", targetIndex: 1 });
  });

  it("excludes the dragged card so same-column reorder isn't off by one", () => {
    // Move a (todo[0]) onto c (todo[2]). After excluding a, list is [b, c]; c is index 1.
    const drop = resolveCardDrop(columns, getColumnCards, card("a", "todo"), "c");
    expect(drop).toEqual({ targetColumnId: "todo", targetIndex: 1 });
  });

  it("returns null for an unknown over-id", () => {
    expect(resolveCardDrop(columns, getColumnCards, card("a", "todo"), "ghost")).toBeNull();
  });

  it("returns null for a no-op drop onto the card's current column slot", () => {
    // done = [d]. Dragging d onto d: exclude d → [], index falls back to 0, and
    // the slot at index 0 is still d → recognised as a no-op (no move fired).
    const cols = [col("done")];
    const get = (id: string) => (id === "done" ? [card("d", "done")] : []);
    expect(resolveCardDrop(cols, get, card("d", "done"), "d")).toBeNull();
  });

  it("appends to an empty target column", () => {
    const cols = [col("todo"), col("empty")];
    const get = (id: string) => (id === "todo" ? [card("a", "todo")] : []);
    const drop = resolveCardDrop(cols, get, card("a", "todo"), "empty");
    expect(drop).toEqual({ targetColumnId: "empty", targetIndex: 0 });
  });
});
