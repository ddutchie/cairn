/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for moveFolder — reparenting a folder subtree within a project.
 *
 * Runs in the node env (isElectron() === false), so IPC is a no-op.
 */

import { describe, it, expect } from "vitest";
import { createNotesSlice } from "./notes";
import type { Note } from "@/types";

const note = (id: string, folder: string, projectId = "proj-1"): Note =>
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
    folder,
    createdAt: "",
    updatedAt: "",
    version: 0,
  } as unknown as Note);

function setup(notes: Note[]) {
  let state: any = { persist: () => {}, projects: [{ id: "proj-1", workspaceId: "ws-1", name: "P" }] };
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createNotesSlice(mockSet, mockGet, {} as any);
  // Apply the slice first (it seeds notes: []), then inject the test notes so
  // they aren't clobbered by the slice's own initial state.
  state = { ...state, ...slice, notes };
  return { get: () => state, slice };
}

const folderOf = (get: () => any, id: string) => get().notes.find((n: Note) => n.id === id).folder;

describe("moveFolder", () => {
  it("reparents a folder and re-prefixes all descendant notes", () => {
    const { get } = setup([
      note("a", "Design"),
      note("b", "Design/Typography"),
      note("c", "Design/Typography/Deep"),
      note("d", "Other"),
    ]);
    // Move "Design" inside "Other" → "Other/Design"
    get().moveFolder("proj-1", "Design", "Other");
    expect(folderOf(get, "a")).toBe("Other/Design");
    expect(folderOf(get, "b")).toBe("Other/Design/Typography");
    expect(folderOf(get, "c")).toBe("Other/Design/Typography/Deep");
    expect(folderOf(get, "d")).toBe("Other"); // untouched
  });

  it("moves a folder to root", () => {
    const { get } = setup([note("a", "Design/Typography"), note("b", "Design/Typography/X")]);
    get().moveFolder("proj-1", "Design/Typography", "");
    expect(folderOf(get, "a")).toBe("Typography");
    expect(folderOf(get, "b")).toBe("Typography/X");
  });

  it("is a no-op when dropping a folder into itself", () => {
    const { get } = setup([note("a", "Design")]);
    get().moveFolder("proj-1", "Design", "Design");
    expect(folderOf(get, "a")).toBe("Design");
  });

  it("is a no-op when dropping a folder into its own descendant", () => {
    const { get } = setup([note("a", "Design"), note("b", "Design/Sub")]);
    get().moveFolder("proj-1", "Design", "Design/Sub");
    expect(folderOf(get, "a")).toBe("Design");
    expect(folderOf(get, "b")).toBe("Design/Sub");
  });

  it("does not touch notes in other projects", () => {
    const { get } = setup([note("a", "Design", "proj-1"), note("x", "Design", "proj-2")]);
    get().moveFolder("proj-1", "Design", "Other");
    expect(folderOf(get, "a")).toBe("Other/Design");
    expect(folderOf(get, "x")).toBe("Design"); // different project — untouched
  });
});
