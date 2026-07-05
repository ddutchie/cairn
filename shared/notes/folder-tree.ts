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

export function buildFolderTree<T extends NoteWithFolder>(
  notes: T[],
): { rootNotes: T[]; folders: FolderNode<T>[] } {
  const rootNotes: T[] = [];
  const folderMap = new Map<string, FolderNode<T>>();

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
      if (!folderMap.has(built)) {
        folderMap.set(built, { name: seg, path: built, notes: [], children: [] });
      }
    }
    folderMap.get(normalizedFolder)!.notes.push(note);
  }

  for (const node of folderMap.values()) {
    const lastSlash = node.path.lastIndexOf("/");
    if (lastSlash === -1) continue;
    const parentPath = node.path.slice(0, lastSlash);
    folderMap.get(parentPath)?.children.push(node);
  }

  const topLevel: FolderNode<T>[] = [];
  for (const node of folderMap.values()) {
    if (!node.path.includes("/")) topLevel.push(node);
  }
  topLevel.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  return { rootNotes, folders: topLevel };
}
