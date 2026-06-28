/**
 * Unit tests for buildFolderTree — the two-pass folder tree builder that powers
 * the Notes sidebar. Focus on folder-path normalization edge cases.
 */

import { describe, expect, it } from "vitest";
import { buildFolderTree, type FolderNode } from "./buildFolderTree";
import type { Note } from "@/types";

// Minimal note factory — only id + folder matter for the tree shape.
const note = (id: string, folder?: string): Note =>
  ({ id, folder, title: id, content: "", contentText: "" } as unknown as Note);

// Find a folder node by path in the (possibly nested) tree.
function findFolder(folders: FolderNode[], path: string): FolderNode | undefined {
  for (const f of folders) {
    if (f.path === path) return f;
    const nested = findFolder(f.children, path);
    if (nested) return nested;
  }
  return undefined;
}

describe("buildFolderTree", () => {
  it("places notes with no folder at the root", () => {
    const { rootNotes, folders } = buildFolderTree([
      note("a"),
      note("b", ""),
    ]);
    expect(rootNotes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(folders).toEqual([]);
  });

  it("treats undefined and empty-string folder identically (root)", () => {
    const { rootNotes } = buildFolderTree([note("a"), note("b", "")]);
    expect(rootNotes).toHaveLength(2);
  });

  it("creates a top-level folder and nests its notes", () => {
    const { rootNotes, folders } = buildFolderTree([note("a", "Work")]);
    expect(rootNotes).toEqual([]);
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe("Work");
    expect(folders[0].path).toBe("Work");
    expect(folders[0].notes.map((n) => n.id)).toEqual(["a"]);
  });

  it("builds nested folders from a slash path", () => {
    const { folders } = buildFolderTree([note("a", "Work/Projects")]);
    expect(folders).toHaveLength(1);
    const work = folders[0];
    expect(work.path).toBe("Work");
    expect(work.children).toHaveLength(1);
    expect(work.children[0].path).toBe("Work/Projects");
    expect(work.children[0].notes.map((n) => n.id)).toEqual(["a"]);
    // The note lives only in the leaf, not the intermediate folder.
    expect(work.notes).toEqual([]);
  });

  it("normalizes leading/trailing/double slashes", () => {
    const { folders } = buildFolderTree([note("a", "/Work//Projects/")]);
    const leaf = findFolder(folders, "Work/Projects");
    expect(leaf).toBeDefined();
    expect(leaf!.notes.map((n) => n.id)).toEqual(["a"]);
    // No empty-segment folders were created.
    expect(findFolder(folders, "")).toBeUndefined();
  });

  it("groups multiple notes sharing a folder", () => {
    const { folders } = buildFolderTree([
      note("a", "Work"),
      note("b", "Work"),
    ]);
    expect(folders).toHaveLength(1);
    expect(folders[0].notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("sorts top-level folders alphabetically (case-insensitive locale)", () => {
    const { folders } = buildFolderTree([
      note("z", "Zebra"),
      note("a", "apple"),
      note("m", "Mango"),
    ]);
    expect(folders.map((f) => f.name)).toEqual(["apple", "Mango", "Zebra"]);
  });

  it("creates intermediate folders even when only a deep leaf has notes", () => {
    const { folders } = buildFolderTree([note("a", "A/B/C")]);
    expect(findFolder(folders, "A")).toBeDefined();
    expect(findFolder(folders, "A/B")).toBeDefined();
    const leaf = findFolder(folders, "A/B/C");
    expect(leaf!.notes.map((n) => n.id)).toEqual(["a"]);
    // Intermediates carry no notes.
    expect(findFolder(folders, "A")!.notes).toEqual([]);
    expect(findFolder(folders, "A/B")!.notes).toEqual([]);
  });

  it("separates root notes from foldered notes in the same input", () => {
    const { rootNotes, folders } = buildFolderTree([
      note("root1"),
      note("foldered", "Docs"),
      note("root2", ""),
    ]);
    expect(rootNotes.map((n) => n.id)).toEqual(["root1", "root2"]);
    expect(folders).toHaveLength(1);
    expect(folders[0].notes.map((n) => n.id)).toEqual(["foldered"]);
  });
});
