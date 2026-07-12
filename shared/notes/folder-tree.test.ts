import { describe, it, expect } from "vitest";
import { buildFolderTree, type FolderNode } from "./folder-tree";

interface N {
  id: string;
  folder?: string | null;
}

/** Find a top-level (or nested) folder node by its display path. */
function findByPath<T extends { folder?: string | null }>(
  folders: FolderNode<T>[],
  path: string,
): FolderNode<T> | undefined {
  for (const f of folders) {
    if (f.path === path) return f;
    const nested = findByPath(f.children, path);
    if (nested) return nested;
  }
  return undefined;
}

describe("buildFolderTree", () => {
  it("puts folderless notes at the root", () => {
    const { rootNotes, folders } = buildFolderTree<N>([
      { id: "a" },
      { id: "b", folder: "" },
      { id: "c", folder: null },
    ]);
    expect(rootNotes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(folders).toHaveLength(0);
  });

  it("builds nested folders from slash-separated paths", () => {
    const { folders } = buildFolderTree<N>([{ id: "a", folder: "Mobile/AI" }]);
    expect(folders).toHaveLength(1);
    const mobile = folders[0];
    expect(mobile.name).toBe("Mobile");
    expect(mobile.notes).toHaveLength(0);
    expect(mobile.children).toHaveLength(1);
    expect(mobile.children[0].name).toBe("AI");
    expect(mobile.children[0].notes.map((n) => n.id)).toEqual(["a"]);
  });

  it("merges folders that differ only in case (top level)", () => {
    const { folders } = buildFolderTree<N>([
      { id: "a", folder: "Mobile" },
      { id: "b", folder: "mobile" },
    ]);
    expect(folders).toHaveLength(1);
    expect(folders[0].notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    // First-seen casing wins as the display name.
    expect(folders[0].name).toBe("Mobile");
  });

  it("merges case-variant nested folders under one parent", () => {
    const { folders } = buildFolderTree<N>([
      { id: "a", folder: "Mobile/AI" },
      { id: "b", folder: "mobile/ai" },
      { id: "c", folder: "Mobile" },
    ]);
    // One top-level "Mobile" with one child "AI", holding both nested notes.
    expect(folders).toHaveLength(1);
    const parent = folders[0];
    expect(parent.name).toBe("Mobile");
    expect(parent.notes.map((n) => n.id)).toEqual(["c"]);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0].notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("does not merge distinct sibling folders", () => {
    const { folders } = buildFolderTree<N>([
      { id: "a", folder: "Mobile" },
      { id: "b", folder: "Desktop" },
    ]);
    expect(folders.map((f) => f.name).sort()).toEqual(["Desktop", "Mobile"]);
  });

  it("normalizes redundant slashes", () => {
    const { folders } = buildFolderTree<N>([{ id: "a", folder: "Mobile//AI/" }]);
    const child = findByPath(folders, "Mobile/AI");
    expect(child).toBeDefined();
    expect(child!.notes.map((n) => n.id)).toEqual(["a"]);
  });
});
