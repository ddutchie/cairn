/**
 * Build a folder tree from a flat list of notes — shared pure logic used by
 * both the desktop (src/components/notes/notes-view) and the mobile app.
 *
 * Generic over the note shape: any object with a `folder` string works, so the
 * desktop `Note` and the mobile `NoteRow` both satisfy it without importing
 * platform types.
 */

export interface NoteWithFolder {
  folder?: string | null;
}

export interface FolderNode<T extends NoteWithFolder> {
  name: string;
  path: string;
  notes: T[];
  children: FolderNode<T>[];
}

/**
 * De-duplicate a list of folder paths CASE-INSENSITIVELY, keeping the first-seen
 * casing of each path as the canonical entry. Shared by both platforms'
 * `list_folders` so the AI never sees "Mobile" and "mobile" as two folders
 * (mirrors the case-insensitive grouping in buildFolderTree). Blank/whitespace
 * entries are dropped. Input order is preserved.
 */
export function dedupeFoldersCaseInsensitive(paths: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return Array.from(seen.values());
}

export function buildFolderTree<T extends NoteWithFolder>(
  notes: T[],
): { rootNotes: T[]; folders: FolderNode<T>[] } {
  const rootNotes: T[] = [];
  // Grouping is CASE-INSENSITIVE: notes filed under "Mobile" and "mobile" (or
  // "Mobile/AI" and "mobile/ai") collapse into one folder. The Map is keyed by
  // the case-folded path; the FolderNode keeps the FIRST-SEEN original casing
  // as its display name/path (so the canonical label is deterministic — the
  // casing of whichever variant is encountered first in the note list).
  const folderMap = new Map<string, FolderNode<T>>();
  const keyOf = (path: string) => path.toLowerCase();

  for (const note of notes) {
    const folder = note.folder ?? "";
    if (!folder) {
      rootNotes.push(note);
      continue;
    }
    const normalizedFolder = folder.split("/").filter(Boolean).join("/");
    const segments = normalizedFolder.split("/");
    let built = "";
    for (const seg of segments) {
      built = built ? `${built}/${seg}` : seg;
      const key = keyOf(built);
      if (!folderMap.has(key)) {
        folderMap.set(key, { name: seg, path: built, notes: [], children: [] });
      }
    }
    folderMap.get(keyOf(normalizedFolder))!.notes.push(note);
  }

  for (const node of folderMap.values()) {
    const lastSlash = node.path.lastIndexOf("/");
    if (lastSlash === -1) continue;
    const parentPath = node.path.slice(0, lastSlash);
    folderMap.get(keyOf(parentPath))?.children.push(node);
  }

  const topLevel: FolderNode<T>[] = [];
  for (const node of folderMap.values()) {
    if (!node.path.includes("/")) topLevel.push(node);
  }

  // Sort every level alphabetically, not just the top — nested children were
  // left in insertion order.
  const byName = (a: FolderNode<T>, b: FolderNode<T>) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  const sortRecursive = (nodes: FolderNode<T>[]) => {
    nodes.sort(byName);
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(topLevel);

  return { rootNotes, folders: topLevel };
}
