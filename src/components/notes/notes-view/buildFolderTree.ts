import type { Note } from "@/types";
import {
  buildFolderTree as buildFolderTreeShared,
  type FolderNode as SharedFolderNode,
} from "../../../../shared/notes/folder-tree";

/** Desktop-typed folder node (notes are the full `Note` type). */
export type FolderNode = SharedFolderNode<Note>;

/**
 * Build a tree from a flat list of notes using their folder field.
 * Thin wrapper over the shared pure-logic (shared/notes/folder-tree) so desktop
 * and mobile group folders identically.
 */
export function buildFolderTree(notes: Note[]): { rootNotes: Note[]; folders: FolderNode[] } {
  return buildFolderTreeShared<Note>(notes);
}
