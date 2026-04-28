"use client";

import React, { useState, useEffect } from "react";
import {
  FileText,
  Plus,
  Pin,
  PinOff,
  Trash2,
  MoreHorizontal,
  Link,
  Search,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative, id } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NoteEditor } from "./note-editor";
import type { Note } from "@/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";

export function NotesView() {
  const {
    activeProjectId,
    getProjectNotes,
    createNote,
    updateNote,
    deleteNote,
  } = useCairnStore();

  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const notes = activeProjectId ? getProjectNotes(activeProjectId) : [];
  const filtered = filter
    ? notes.filter(
        (n) =>
          n.title.toLowerCase().includes(filter.toLowerCase()) ||
          n.contentText.toLowerCase().includes(filter.toLowerCase())
      )
    : notes;

  const activeNote = notes.find((n) => n.id === activeNoteId) ?? notes[0] ?? null;

  useEffect(() => {
    if (!activeNoteId && notes.length > 0) {
      setActiveNoteId(notes[0].id);
    }
  }, [activeNoteId, notes]);

  function handleCreateNote() {
    if (!activeProjectId) return;
    const note = createNote(activeProjectId, "Untitled Note");
    setActiveNoteId(note.id);
  }

  function handleDelete(noteId: string) {
    deleteNote(noteId);
    if (activeNoteId === noteId) {
      const remaining = notes.filter((n) => n.id !== noteId);
      setActiveNoteId(remaining[0]?.id ?? null);
    }
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Notes list */}
      <div className="w-56 flex-shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)]">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
          <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            Notes
          </span>
          <Button variant="ghost" size="icon" onClick={handleCreateNote}>
            <Plus size={14} />
          </Button>
        </div>

        {/* Search */}
        <div className="px-2 py-2 border-b border-[var(--border-subtle)]">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes..."
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <FileText size={20} className="mx-auto mb-2 text-[var(--text-tertiary)] opacity-40" />
              <p className="text-xs text-[var(--text-tertiary)]">
                {filter ? "No matching notes" : "No notes yet"}
              </p>
              {!filter && (
                <button
                  onClick={handleCreateNote}
                  className="mt-2 text-xs text-[var(--accent)] hover:underline"
                >
                  Create one
                </button>
              )}
            </div>
          ) : (
            filtered.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={note.id === activeNote?.id}
                onClick={() => setActiveNoteId(note.id)}
                onPin={() => updateNote(note.id, { isPinned: !note.isPinned })}
                onDelete={() => handleDelete(note.id)}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-2 border-t border-[var(--border)]">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={handleCreateNote}
          >
            <Plus size={12} />
            <span className="text-xs">New note</span>
          </Button>
        </div>
      </div>

      {/* Note editor */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {activeNote ? (
          <NoteEditor note={activeNote} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText size={32} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
              <p className="text-sm text-[var(--text-tertiary)]">Select a note or create a new one</p>
              <Button variant="accent" size="sm" className="mt-4" onClick={handleCreateNote}>
                <Plus size={13} /> New Note
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface NoteListItemProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
  onPin: () => void;
  onDelete: () => void;
}

function NoteListItem({ note, isActive, onClick, onPin, onDelete }: NoteListItemProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-0.5 px-3 py-2.5 cursor-pointer transition-colors",
        isActive
          ? "bg-[var(--surface-2)] border-l-2 border-[var(--accent)]"
          : "hover:bg-[var(--surface-2)] border-l-2 border-transparent"
      )}
    >
      <div className="flex items-center gap-1.5">
        {note.isPinned && (
          <Pin size={9} className="text-[var(--accent)] flex-shrink-0" />
        )}
        <span
          className={cn(
            "text-xs font-medium truncate flex-1",
            isActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
          )}
        >
          {note.title}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-all"
            >
              <MoreHorizontal size={11} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
            >
              {note.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
              {note.isPinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-red-400 hover:text-red-300"
            >
              <Trash2 size={12} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="text-[11px] text-[var(--text-tertiary)] truncate">
        {note.contentText.slice(0, 60) || "Empty note"}
      </span>
      <span className="text-[10px] text-[var(--text-tertiary)] opacity-60">
        {formatRelative(note.updatedAt)}
      </span>
    </div>
  );
}
