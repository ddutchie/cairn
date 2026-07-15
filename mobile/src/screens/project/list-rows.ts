import type { NoteRow } from "@/db/queries";
import type { FolderNode } from "@cairn/shared/notes/folder-tree";

/** A single virtualized row in the notes list: a folder header or a note. */
export type ListRow =
  | { kind: "folder"; node: FolderNode<NoteRow>; depth: number }
  | { kind: "note"; note: NoteRow; depth: number };

/** FlatList key for a flattened row — folder path or note id, both unique. */
export function rowKey(item: ListRow): string {
  return item.kind === "folder" ? `f:${item.node.path}` : `n:${item.note.id}`;
}
