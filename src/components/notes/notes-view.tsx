"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  FileText, Plus, Pin, PinOff, Trash2, MoreHorizontal, Search,
  Wand2, Loader2, Archive, ArchiveRestore, FolderInput,
  ChevronDown, ChevronRight, LayoutDashboard,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { NoteEditor } from "./note-editor";
import { DashboardView } from "./dashboard-view";
import { PrdModal } from "./notes-view/PrdModal";
import { MoveNoteModal } from "./notes-view/MoveNoteModal";
import { DashboardTemplateModal } from "./DashboardTemplateModal";
import { useNoteFilter } from "./notes-view/useNoteFilter";
import type { Note } from "@/types";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";

export function NotesView() {
  const {
    activeProjectId, activeWorkspaceId,
    getProjectNotes, getArchivedProjectNotes,
    createNote, updateNote, deleteNote,
    archiveNote, restoreNote, moveNoteToProject,
    revealNote, generatePrd,
    getProjectColumns, tags, getTagById,
    getWorkspaceProjects,
  } = useCairnStore();

  const [activeNoteId, setActiveNoteId]         = useState<string | null>(null);
  const [filter, setFilter]                     = useState("");
  const [activeTagId, setActiveTagId]           = useState<string | null>(null);
  const [prdModalOpen, setPrdModalOpen]         = useState(false);
  const [moveNoteId, setMoveNoteId]             = useState<string | null>(null);
  const [showArchivedNotes, setShowArchivedNotes] = useState(false);
  const [dashboardTemplateOpen, setDashboardTemplateOpen] = useState(false);
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);

  const notes           = activeProjectId ? getProjectNotes(activeProjectId) : [];
  const archivedNotes   = activeProjectId ? getArchivedProjectNotes(activeProjectId) : [];
  const workspaceProjects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : [];
  const projectTagIds   = [...new Set(notes.flatMap((n) => n.tagIds))];
  const projectTags     = projectTagIds.map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];

  const filtered   = useNoteFilter(notes, filter, activeTagId);
  const activeNote = notes.find((n) => n.id === activeNoteId) ?? notes[0] ?? null;

  // Auto-select first note
  useEffect(() => {
    if (!activeNoteId && notes.length > 0) setActiveNoteId(notes[0].id);
  }, [activeNoteId, notes]);

  // Auto-select newly created note
  const prevNoteCountRef = useRef(notes.length);
  useEffect(() => {
    if (notes.length > prevNoteCountRef.current) setActiveNoteId(notes[0].id);
    prevNoteCountRef.current = notes.length;
  }, [notes]);

  function handleCreateNote() {
    if (!activeProjectId) return;
    const note = createNote(activeProjectId, "Untitled Note", "note");
    setActiveNoteId(note.id);
  }

  function handleCreateDashboard() {
    if (!activeProjectId) return;
    setDashboardTemplateOpen(true);
  }

  function handleTemplateSelect(html: string, title: string) {
    if (!activeProjectId) return;
    const note = createNote(activeProjectId, title, "dashboard");
    if (html) updateNote(note.id, { content: html, contentText: "" });
    setActiveNoteId(note.id);
    setDashboardTemplateOpen(false);
  }

  // ⌘N global shortcut
  useEffect(() => {
    const handler = () => handleCreateNote();
    window.addEventListener("cairn:new-note", handler);
    return () => window.removeEventListener("cairn:new-note", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Deep-link from search/overview
  useEffect(() => {
    const handler = (e: Event) => { const { noteId } = (e as CustomEvent).detail; setActiveNoteId(noteId); };
    window.addEventListener("cairn:select-note", handler);
    return () => window.removeEventListener("cairn:select-note", handler);
  }, []);

  function handleDelete(noteId: string) {
    deleteNote(noteId);
    setDeleteNoteId(null);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
  }

  function handleArchive(noteId: string) {
    archiveNote(noteId);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
  }

  function handleMoveToProject(noteId: string, targetProjectId: string) {
    moveNoteToProject(noteId, targetProjectId);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
    setMoveNoteId(null);
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Notes list */}
      <div className="w-56 flex-shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)]">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
          <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Notes</span>
          <div className="flex items-center gap-0.5">
            <Tooltip content="Generate PRD with AI">
              <Button variant="ghost" size="icon" onClick={() => setPrdModalOpen(true)}>
                <Wand2 size={13} />
              </Button>
            </Tooltip>
            <Tooltip content="New note">
              <Button variant="ghost" size="icon" onClick={handleCreateNote}><Plus size={14} /></Button>
            </Tooltip>
            <Tooltip content="New dashboard">
              <Button variant="ghost" size="icon" onClick={handleCreateDashboard}><LayoutDashboard size={13} /></Button>
            </Tooltip>
          </div>
        </div>

        {/* Search + tag filter */}
        <div className="px-2 py-2 border-b border-[var(--border-subtle)]">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes..."
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]" />
          </div>
          {projectTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {projectTags.map((tag) => (
                <button key={tag.id} onClick={() => setActiveTagId(activeTagId === tag.id ? null : tag.id)}
                  className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] border transition-colors",
                    activeTagId === tag.id
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]")}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <FileText size={20} className="mx-auto mb-2 text-[var(--text-tertiary)] opacity-40" />
              <p className="text-xs text-[var(--text-tertiary)]">
                {filter || activeTagId ? "No matching notes" : "No notes yet"}
              </p>
              {!filter && !activeTagId && (
                <button onClick={handleCreateNote} className="mt-2 text-xs text-[var(--accent)] hover:underline">
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
                onDelete={() => setDeleteNoteId(note.id)}
                onArchive={() => handleArchive(note.id)}
                onMove={() => setMoveNoteId(note.id)}
                onReveal={() => revealNote(note.id, note.projectId)}
              />
            ))
          )}

          {/* Archived notes */}
          {archivedNotes.length > 0 && (
            <div className="mt-1 border-t border-[var(--border-subtle)]">
              <button onClick={() => setShowArchivedNotes((v) => !v)}
                className="flex items-center gap-1.5 w-full px-3 py-2 text-[10.5px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors">
                {showArchivedNotes ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                {archivedNotes.length} archived
              </button>
              {showArchivedNotes && archivedNotes.map((note) => (
                <ArchivedNoteListItem key={note.id} note={note}
                  onRestore={() => restoreNote(note.id)}
                  onDelete={() => setDeleteNoteId(note.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-2 border-t border-[var(--border)]">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleCreateNote}>
            <Plus size={12} /><span className="text-xs">New note</span>
          </Button>
        </div>
      </div>

      {/* Editor pane */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {activeNote ? (
          activeNote.type === "dashboard"
            ? <DashboardView note={activeNote} />
            : <NoteEditor note={activeNote} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText size={32} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
              <p className="text-sm text-[var(--text-tertiary)]">Select a note or create a new one</p>
              <div className="flex items-center gap-2 mt-4 justify-center">
                <Button variant="accent" size="sm" onClick={handleCreateNote}><Plus size={13} /> New Note</Button>
                <Button variant="ghost" size="sm" onClick={handleCreateDashboard}><LayoutDashboard size={13} /> New Dashboard</Button>
                <Button variant="ghost" size="sm" onClick={() => setPrdModalOpen(true)}><Wand2 size={13} /> Generate PRD</Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {prdModalOpen && activeProjectId && (
        <PrdModal projectId={activeProjectId} generatePrd={generatePrd} onClose={() => setPrdModalOpen(false)} />
      )}

      {dashboardTemplateOpen && (
        <DashboardTemplateModal
          onSelect={handleTemplateSelect}
          onClose={() => setDashboardTemplateOpen(false)}
        />
      )}

      {moveNoteId && (
        <MoveNoteModal
          workspaceProjects={workspaceProjects}
          activeProjectId={activeProjectId}
          onMove={(pid) => handleMoveToProject(moveNoteId, pid)}
          onClose={() => setMoveNoteId(null)}
        />
      )}

      <Dialog open={!!deleteNoteId} onOpenChange={(o) => { if (!o) setDeleteNoteId(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              <strong className="text-[var(--text-primary)]">
                {notes.find((n) => n.id === deleteNoteId)?.title ?? "This note"}
              </strong>{" "}
              will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                variant="ghost" size="sm"
                className="text-[var(--danger)] hover:bg-[var(--danger)]/10"
                onClick={() => deleteNoteId && handleDelete(deleteNoteId)}
              >
                <Trash2 size={13} /> Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── NoteListItem ──────────────────────────────────────────────────────────────

interface NoteListItemProps {
  note: Note; isActive: boolean;
  onClick: () => void; onPin: () => void; onDelete: () => void;
  onArchive: () => void; onMove: () => void; onReveal: () => void;
}

function NoteListItem({ note, isActive, onClick, onPin, onDelete, onArchive, onMove, onReveal }: NoteListItemProps) {
  return (
    <div onClick={onClick}
      className={cn("group relative flex flex-col gap-0.5 px-3 py-2.5 cursor-pointer transition-colors",
        isActive ? "bg-[var(--surface-2)] border-l-2 border-[var(--accent)]" : "hover:bg-[var(--surface-2)] border-l-2 border-transparent")}>
      <div className="flex items-center gap-1.5">
        {note.isPinned && <Pin size={9} className="text-[var(--accent)] flex-shrink-0" />}
        {note.type === "dashboard" && <LayoutDashboard size={9} className="text-[var(--text-tertiary)] flex-shrink-0" />}
        <span className={cn("text-xs font-medium truncate flex-1", isActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]")}>
          {note.title}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button onClick={(e) => e.stopPropagation()}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-all">
              <MoreHorizontal size={11} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onPin(); }}>
              {note.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
              {note.isPinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onReveal(); }}>
              <FileText size={12} />Reveal in Finder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onArchive(); }}>
              <Archive size={12} />Archive
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMove(); }}>
              <FolderInput size={12} />Move to project
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-[var(--danger)] hover:text-[var(--danger)]">
              <Trash2 size={12} />Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="text-[0.786rem] text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 60) || "Empty note"}</span>
      <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(note.updatedAt)}</span>
    </div>
  );
}

// ── ArchivedNoteListItem ──────────────────────────────────────────────────────

function ArchivedNoteListItem({ note, onRestore, onDelete }: { note: Note; onRestore: () => void; onDelete: () => void }) {
  return (
    <div className="group flex items-center gap-1.5 px-3 py-2">
      <span className="flex-1 text-[0.786rem] text-[var(--text-tertiary)] truncate">{note.title}</span>
      <Tooltip content="Restore note">
        <button onClick={(e) => { e.stopPropagation(); onRestore(); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-all">
          <ArchiveRestore size={11} />
        </button>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button onClick={(e) => e.stopPropagation()}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-all">
            <MoreHorizontal size={11} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRestore(); }}>
            <ArchiveRestore size={12} />Restore
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-[var(--danger)] hover:text-[var(--danger)]">
            <Trash2 size={12} />Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
