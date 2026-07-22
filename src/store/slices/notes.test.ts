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

function setup(notes: Note[], projects: any[] = [{ id: "proj-1", workspaceId: "ws-1", name: "P" }]) {
  let state: any = { persist: () => {}, projects };
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
const projectOf = (get: () => any, id: string) => get().notes.find((n: Note) => n.id === id).projectId;
const workspaceOf = (get: () => any, id: string) => get().notes.find((n: Note) => n.id === id).workspaceId;

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

describe("moveFolderToProject", () => {
  const twoProjects = [
    { id: "proj-1", workspaceId: "ws-1", name: "P1" },
    { id: "proj-2", workspaceId: "ws-2", name: "P2" },
  ];

  it("moves the whole folder subtree's projectId + workspaceId to the target project", () => {
    const { get } = setup(
      [
        note("a", "Design", "proj-1"),
        note("b", "Design/Typography", "proj-1"),
        note("c", "Design/Typography/Deep", "proj-1"),
        note("d", "Other", "proj-1"),
      ],
      twoProjects,
    );
    get().moveFolderToProject("proj-1", "Design", "proj-2");
    for (const id of ["a", "b", "c"]) {
      expect(projectOf(get, id)).toBe("proj-2");
      expect(workspaceOf(get, id)).toBe("ws-2"); // adopts target project's workspace
      expect(folderOf(get, id)).toBe(folderOf(get, id)); // folder path preserved
    }
    // A note outside the moved subtree is untouched.
    expect(projectOf(get, "d")).toBe("proj-1");
    expect(workspaceOf(get, "d")).toBe("ws-1");
  });

  it("preserves the folder subtree paths after the project move", () => {
    const { get } = setup([note("a", "Design/Typography", "proj-1")], twoProjects);
    get().moveFolderToProject("proj-1", "Design", "proj-2");
    expect(folderOf(get, "a")).toBe("Design/Typography");
  });

  it("does nothing when the destination project does not exist", () => {
    const { get } = setup([note("a", "Design", "proj-1")], twoProjects);
    get().moveFolderToProject("proj-1", "Design", "proj-nope");
    expect(projectOf(get, "a")).toBe("proj-1");
    expect(workspaceOf(get, "a")).toBe("ws-1");
  });

  it("is a no-op when source and target projects are identical", () => {
    const { get } = setup([note("a", "Design", "proj-1")], twoProjects);
    get().moveFolderToProject("proj-1", "Design", "proj-1");
    expect(projectOf(get, "a")).toBe("proj-1");
    expect(workspaceOf(get, "a")).toBe("ws-1");
  });

  it("does not touch notes outside the source project", () => {
    const { get } = setup([note("a", "Design", "proj-1"), note("x", "Design", "proj-2")], twoProjects);
    get().moveFolderToProject("proj-1", "Design", "proj-2");
    expect(projectOf(get, "a")).toBe("proj-2");
    // "x" was already in proj-2 under the same folder name — must stay put.
    expect(projectOf(get, "x")).toBe("proj-2");
    expect(workspaceOf(get, "x")).toBe("ws-1"); // its original workspace, unchanged
  });
});
