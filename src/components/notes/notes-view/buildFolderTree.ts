import type { Note } from "@/types";

export interface FolderNode {
  name: string;
  path: string;
  notes: Note[];
  children: FolderNode[];
}

/** Build a tree from a flat list of notes using their folder field. */
export function buildFolderTree(notes: Note[]): { rootNotes: Note[]; folders: FolderNode[] } {
  const rootNotes: Note[] = [];
  const folderMap = new Map<string, FolderNode>();

  for (const note of notes) {
    const folder = note.folder ?? "";
    if (!folder) {
      rootNotes.push(note);
      continue;
    }
    const segments = folder.split("/").filter(Boolean);
    let built = "";
    for (const seg of segments) {
      built = built ? `${built}/${seg}` : seg;
      if (!folderMap.has(built)) {
        folderMap.set(built, { name: seg, path: built, notes: [], children: [] });
      }
    }
    folderMap.get(folder)!.notes.push(note);
  }

  for (const node of folderMap.values()) {
    const lastSlash = node.path.lastIndexOf("/");
    if (lastSlash === -1) continue;
    const parentPath = node.path.slice(0, lastSlash);
    folderMap.get(parentPath)?.children.push(node);
  }

  const topLevel: FolderNode[] = [];
  for (const node of folderMap.values()) {
    if (!node.path.includes("/")) topLevel.push(node);
  }
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  return { rootNotes, folders: topLevel };
}
