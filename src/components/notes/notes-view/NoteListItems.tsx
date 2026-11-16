"use client";

import { NoteListItem } from "./NoteListItem";
import type { Note } from "@/types";

interface NoteListItemsProps {
  notes: Note[];
  activeNoteId?: string | null;
  changedNoteIds: ReadonlySet<string>;
  onNoteClick: (noteId: string) => void;
  onNotePin: (note: Note) => void;
  onNoteDelete: (note: Note) => void;
  onNoteArchive: (note: Note) => void;
  onNoteMove: (note: Note) => void;
  onNoteMoveToFolder: (note: Note) => void;
  onNoteReveal: (note: Note) => void;
  onNoteDragStart: (noteId: string) => void;
  onNoteDragEnd: () => void;
  indent?: number;
}

/** Flat note rows with the notes-view handler set. Used by the filtered list and the root-notes list. */
export function NoteListItems({
  notes,
  activeNoteId,
  changedNoteIds,
  onNoteClick,
  onNotePin,
  onNoteDelete,
  onNoteArchive,
  onNoteMove,
  onNoteMoveToFolder,
  onNoteReveal,
  onNoteDragStart,
  onNoteDragEnd,
  indent,
}: NoteListItemsProps) {
  return (
    <>
      {notes.map((note) => (
        <NoteListItem
          key={note.id}
          note={note}
          isActive={note.id === activeNoteId}
          hasChanges={changedNoteIds.has(note.id)}
          indent={indent}
          onClick={() => onNoteClick(note.id)}
          onPin={() => onNotePin(note)}
          onDelete={() => onNoteDelete(note)}
          onArchive={() => onNoteArchive(note)}
          onMove={() => onNoteMove(note)}
          onMoveToFolder={() => onNoteMoveToFolder(note)}
          onReveal={() => onNoteReveal(note)}
          onDragStart={onNoteDragStart}
          onDragEnd={onNoteDragEnd}
        />
      ))}
    </>
  );
}
