/**
 * Unit tests for card-detail blocker logic (card-detail-utils.ts).
 *
 * computeCandidateBlockers applies a 5-clause exclusion filter; dropping any
 * one clause silently lets an invalid card be offered as a blocker (self-block,
 * cross-project, archived, done, or already-a-blocker). These tests pin each
 * clause independently.
 */

import { describe, it, expect } from "vitest";
import { computeDoneColumnIds, computeCandidateBlockers } from "./card-detail-utils";
import type { TaskCard, BoardColumn } from "@/types";

const col = (id: string, type: string, projectId = "p1"): BoardColumn =>
  ({ id, projectId, workspaceId: "w", name: id, type, order: 0,
     createdAt: "", updatedAt: "" }) as BoardColumn;

const card = (id: string, over: Partial<TaskCard> = {}): TaskCard =>
  ({ id, columnId: "todo", projectId: "p1", workspaceId: "w", title: id, tagIds: [],
     priority: "medium", linkedNoteIds: [], blockedByIds: [], order: 0,
     createdAt: "", updatedAt: "", version: 1, ...over }) as TaskCard;

describe("computeDoneColumnIds", () => {
  it("collects only done-type columns for the given project", () => {
    const cols = [
      col("todo", "todo"),
      col("done1", "done"),
      col("done2", "done", "p2"), // other project — excluded
    ];
    const ids = computeDoneColumnIds(cols, "p1");
    expect([...ids]).toEqual(["done1"]);
  });
});

describe("computeCandidateBlockers", () => {
  const subject = card("self", { projectId: "p1", blockedByIds: ["already"] });
  const done = new Set(["done"]);

  it("includes a valid same-project, non-archived, non-done, unrelated card", () => {
    const cards = [subject, card("ok", { columnId: "todo" })];
    expect(computeCandidateBlockers(cards, subject, done).map((c) => c.id)).toEqual(["ok"]);
  });

  it("excludes the card itself (no self-block)", () => {
    const cards = [subject];
    expect(computeCandidateBlockers(cards, subject, done)).toEqual([]);
  });

  it("excludes cards from other projects", () => {
    const cards = [subject, card("other", { projectId: "p2" })];
    expect(computeCandidateBlockers(cards, subject, done)).toEqual([]);
  });

  it("excludes archived cards", () => {
    const cards = [subject, card("arch", { archivedAt: "2026-01-01" })];
    expect(computeCandidateBlockers(cards, subject, done)).toEqual([]);
  });

  it("excludes cards already in a done column", () => {
    const cards = [subject, card("finished", { columnId: "done" })];
    expect(computeCandidateBlockers(cards, subject, done)).toEqual([]);
  });

  it("excludes cards already listed as blockers", () => {
    const cards = [subject, card("already", { columnId: "todo" })];
    expect(computeCandidateBlockers(cards, subject, done)).toEqual([]);
  });

  it("treats a missing blockedByIds as no existing blockers", () => {
    const noBlockers = card("self2", { blockedByIds: undefined as unknown as string[] });
    const cards = [noBlockers, card("ok")];
    expect(computeCandidateBlockers(cards, noBlockers, done).map((c) => c.id)).toEqual(["ok"]);
  });
});
