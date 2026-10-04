import { describe, it, expect } from "vitest";
import { cardMatchesFilter, EMPTY_BOARD_FILTER, UNASSIGNED, isFilterActive, activeCriteriaCount, assigneesOf, type BoardFilter } from "./board-filters";
import type { TaskCard } from "@/types";

const NOW = new Date(2026, 9, 4, 12).getTime();
const card = (patch: Partial<TaskCard>): TaskCard => ({
  id: "c", columnId: "todo", projectId: "p", workspaceId: "w", title: "Card", tagIds: [], priority: "medium",
  linkedNoteIds: [], blockedByIds: [], order: 0, createdAt: "", updatedAt: "", version: 0, ...patch,
});
const f = (patch: Partial<BoardFilter>): BoardFilter => ({ ...EMPTY_BOARD_FILTER, ...patch });
const match = (c: TaskCard, flt: BoardFilter, open = new Set<string>()) => cardMatchesFilter(c, flt, open, NOW);

describe("cardMatchesFilter", () => {
  it("passes everything with the empty filter", () => {
    expect(match(card({}), EMPTY_BOARD_FILTER)).toBe(true);
    expect(isFilterActive(EMPTY_BOARD_FILTER)).toBe(false);
  });

  it("filters by assignee, including unassigned", () => {
    expect(match(card({ assignee: "Ana" }), f({ assignee: "Ana" }))).toBe(true);
    expect(match(card({ assignee: "Bo" }), f({ assignee: "Ana" }))).toBe(false);
    expect(match(card({}), f({ assignee: UNASSIGNED }))).toBe(true);
    expect(match(card({ assignee: "  " }), f({ assignee: UNASSIGNED }))).toBe(true);
    expect(match(card({ assignee: "Ana" }), f({ assignee: UNASSIGNED }))).toBe(false);
  });

  it("matches any selected tag", () => {
    expect(match(card({ tagIds: ["a", "b"] }), f({ tagIds: ["b", "z"] }))).toBe(true);
    expect(match(card({ tagIds: ["a"] }), f({ tagIds: ["z"] }))).toBe(false);
  });

  it("filters by due window", () => {
    expect(match(card({ dueDate: "2026-10-01" }), f({ due: "overdue" }))).toBe(true);
    expect(match(card({ dueDate: "2026-10-09" }), f({ due: "overdue" }))).toBe(false);
    expect(match(card({ dueDate: "2026-10-09" }), f({ due: "week" }))).toBe(true);
    expect(match(card({ dueDate: "2026-11-09" }), f({ due: "week" }))).toBe(false);
    expect(match(card({}), f({ due: "none" }))).toBe(true);
    expect(match(card({}), f({ due: "week" }))).toBe(false);
  });

  it("blocked-only requires an open blocker", () => {
    const c = card({ blockedByIds: ["b1"] });
    expect(match(c, f({ blockedOnly: true }), new Set(["b1"]))).toBe(true);
    expect(match(c, f({ blockedOnly: true }), new Set())).toBe(false);
  });

  it("combines criteria with text search", () => {
    const c = card({ title: "Fix login", priority: "high", assignee: "Ana" });
    expect(match(c, f({ text: "login", priorities: ["high"], assignee: "Ana" }))).toBe(true);
    expect(match(c, f({ text: "logout", priorities: ["high"] }))).toBe(false);
  });
});

describe("helpers", () => {
  it("counts non-text criteria", () => {
    expect(activeCriteriaCount(f({ text: "x", assignee: "a", blockedOnly: true }))).toBe(2);
  });
  it("lists distinct sorted assignees", () => {
    expect(assigneesOf([card({ assignee: "Bo" }), card({ assignee: "Ana" }), card({ assignee: "Bo " }), card({})])).toEqual(["Ana", "Bo"]);
  });
});
