"use client";

import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from "react";
import {
  FileText, Plus, Pin, PinOff, Trash2, MoreHorizontal, Search,
  Wand2, Archive, ArchiveRestore, FolderInput,
  ChevronDown, ChevronRight, LayoutDashboard, Folder, FolderOpen,
  FolderPlus, FolderSymlink, ChevronLeft,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
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

// ── Folder tree helpers ───────────────────────────────────────────────────────

interface FolderNode {
  name: string;        // segment name (last part of path)
  path: string;        // full path e.g. "Design/Typography"
  notes: Note[];
  children: FolderNode[];
}

/** Build a tree from a flat list of notes using their folder field. */
function buildFolderTree(notes: Note[]): { rootNotes: Note[]; folders: FolderNode[] } {
  const rootNotes: Note[] = [];
  const folderMap = new Map<string, FolderNode>();

  // Pass 1 — create every folder node (including all ancestors) and
  // assign notes to their leaf folder. Do NOT wire parent→child here
  // because the parent node may not exist yet when we encounter a deep path.
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

  // Pass 2 — wire every node into its parent now that all nodes exist.
  for (const node of folderMap.values()) {
    const lastSlash = node.path.lastIndexOf("/");
    if (lastSlash === -1) continue; // top-level — no parent to wire
    const parentPath = node.path.slice(0, lastSlash);
    folderMap.get(parentPath)?.children.push(node);
  }

  // Collect top-level folders and sort them alphabetically.
  const topLevel: FolderNode[] = [];
  for (const node of folderMap.values()) {
    if (!node.path.includes("/")) topLevel.push(node);
  }
  topLevel.sort((a, b) => a.name.localeCompare(b.name));

  return { rootNotes, folders: topLevel };
}

export function NotesView() {
  const {
    activeProjectId, activeWorkspaceId,
    getProjectNotes, getArchivedProjectNotes,
    createNote, updateNote, deleteNote,
    archiveNote, restoreNote, moveNoteToProject, moveNoteToFolder,
    revealNote,
    getTagById,
    getWorkspaceProjects,
    notes: allNotes,
    aiConfig,
  } = useCairnStore(useShallow((s) => ({
    activeProjectId:         s.activeProjectId,
    activeWorkspaceId:       s.activeWorkspaceId,
    getProjectNotes:         s.getProjectNotes,
    getArchivedProjectNotes: s.getArchivedProjectNotes,
    createNote:              s.createNote,
    updateNote:              s.updateNote,
    deleteNote:              s.deleteNote,
    archiveNote:             s.archiveNote,
    restoreNote:             s.restoreNote,
    moveNoteToProject:       s.moveNoteToProject,
    moveNoteToFolder:        s.moveNoteToFolder,
    revealNote:              s.revealNote,
    getTagById:              s.getTagById,
    getWorkspaceProjects:    s.getWorkspaceProjects,
    notes:                   s.notes,
    aiConfig:                s.aiConfig,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;

  const [activeNoteId, setActiveNoteId]         = useState<string | null>(null);
  const [filter, setFilter]                     = useState("");
  const [activeTagId, setActiveTagId]           = useState<string | null>(null);
  const [prdModalOpen, setPrdModalOpen]         = useState(false);
  const [moveNoteId, setMoveNoteId]             = useState<string | null>(null);
  const [showArchivedNotes, setShowArchivedNotes] = useState(false);
  const [dashboardTemplateOpen, setDashboardTemplateOpen] = useState(false);
  const [deleteNoteId, setDeleteNoteId]         = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen]        = useState(false);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  // folder → collapsed state; true = collapsed, undefined/false = open
  const [collapsedFolders, setCollapsedFolders]  = useState<Record<string, boolean>>({});

  // ⌘F / Ctrl+F — focus the filter input, but only when the CM6 editor
  // is NOT focused (CM6's own searchKeymap handles it when the editor is active).
  const filterInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        const inEditor = document.activeElement?.closest(".cm-editor") !== null;
        if (inEditor) return; // let CM6 searchKeymap handle it
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // "Move to folder" for a specific note
  const [folderMoveNoteId, setFolderMoveNoteId]  = useState<string | null>(null);
  const [, setFolderMoveDest]       = useState("");

  // Drag-and-drop: note → folder
  const dragNoteIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget]              = useState<string | null>(null); // folder path or "__root__"

  const handleNoteDragStart = useCallback((noteId: string) => {
    dragNoteIdRef.current = noteId;
  }, []);

  const handleNoteDragEnd = useCallback(() => {
    dragNoteIdRef.current = null;
    setDropTarget(null);
  }, []);

  const handleFolderDragOver = useCallback((folderPath: string) => {
    setDropTarget(folderPath);
  }, []);

  const handleFolderDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleFolderDrop = useCallback((folderPath: string) => {
    const noteId = dragNoteIdRef.current;
    if (noteId) moveNoteToFolder(noteId, folderPath);
    dragNoteIdRef.current = null;
    setDropTarget(null);
  }, [moveNoteToFolder]);

  // Subscribe to allNotes directly so this component re-renders when note
  // content changes (e.g. while typing). The selector functions are stable
  // references and don't trigger re-renders on content updates.
  const notes         = useMemo(
    () => activeProjectId ? getProjectNotes(activeProjectId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeProjectId, allNotes],
  );
  const archivedNotes = useMemo(
    () => activeProjectId ? getArchivedProjectNotes(activeProjectId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeProjectId, allNotes],
  );
  const workspaceProjects = useMemo(
    () => activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkspaceId, allNotes],
  );
  const projectTags = useMemo(() => {
    const tagIds = [...new Set(notes.flatMap((n) => n.tagIds))];
    return tagIds.map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];
  }, [notes, getTagById]);

  const filtered   = useNoteFilter(notes, filter, activeTagId);
  const activeNote = notes.find((n) => n.id === activeNoteId) ?? notes[0] ?? null;

  // Folder tree — only built when not filtering
  const isFiltering = !!(filter || activeTagId);
  const { rootNotes, folders: folderTree } = useMemo(
    () => isFiltering ? { rootNotes: filtered, folders: [] as FolderNode[] } : buildFolderTree(notes),
    [notes, isFiltering, filtered],
  );



  // Auto-select first note / newly created note in a single unified effect.
  // Merging the two previous competing effects eliminates the race where both
  // could fire in the same render cycle and produce two setState calls.
  const prevNoteCountRef = useRef(notes.length);
  useEffect(() => {
    if (notes.length > prevNoteCountRef.current) {
      // A new note was added — select it (it lands at index 0 after sort)
      setActiveNoteId(notes[0].id);
    } else if (!activeNoteId && notes.length > 0) {
      // No active note yet — select the first one
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveNoteId(notes[0].id);
    }
    prevNoteCountRef.current = notes.length;
  }, [notes, activeNoteId]);

  function handleCreateNote(inFolder = "") {
    if (!activeProjectId) return;
    // Pass folder directly to createNote so the IPC create call already
    // carries the folder — avoids a separate moveToFolder IPC round-trip
    // and the race window it creates.
    const note = createNote(activeProjectId, "Untitled Note", "note", inFolder);
    setActiveNoteId(note.id);
    setMobileShowEditor(true);
  }

  function handleMoveNoteToFolder(noteId: string, folder: string) {
    moveNoteToFolder(noteId, folder);
    setFolderMoveNoteId(null);
    setFolderMoveDest("");
  }

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [folderPath]: !prev[folderPath] }));
  }, []);

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
    setMobileShowEditor(true);
  }

  // ⌘N global shortcut — use a ref so the handler always sees the latest
  // handleCreateNote without needing to re-register the listener on every render.
  const handleCreateNoteRef = useRef(handleCreateNote);
  useEffect(() => { handleCreateNoteRef.current = handleCreateNote; });
  useEffect(() => {
    const handler = () => handleCreateNoteRef.current();
    window.addEventListener("cairn:new-note", handler);
    return () => window.removeEventListener("cairn:new-note", handler);
  }, []);

  // Deep-link from search/overview
  useEffect(() => {
    const handler = (e: Event) => {
      const { noteId } = (e as CustomEvent).detail;
      setActiveNoteId(noteId);
      setMobileShowEditor(true);
    };
    window.addEventListener("cairn:select-note", handler);
    return () => window.removeEventListener("cairn:select-note", handler);
  }, []);

  const handleDelete = useCallback((noteId: string) => {
    deleteNote(noteId);
    setDeleteNoteId(null);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
  }, [deleteNote, activeNoteId, notes]);

  const handleArchive = useCallback((noteId: string) => {
    archiveNote(noteId);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
  }, [archiveNote, activeNoteId, notes]);

  function handleMoveToProject(noteId: string, targetProjectId: string) {
    moveNoteToProject(noteId, targetProjectId);
    if (activeNoteId === noteId) setActiveNoteId(notes.filter((n) => n.id !== noteId)[0]?.id ?? null);
    setMoveNoteId(null);
  }

  // Stable per-note callbacks for NoteListItem — keyed on note.id to keep
  // React.memo effective. These are defined per-note at render time but each
  // callback identity is stable across re-renders of NotesView as long as the
  // relevant note ID and the handler dependencies don't change.
  const handleNoteClick        = useCallback((id: string) => {
    setActiveNoteId(id);
    setMobileShowEditor(true);
  }, []);
  const handleNotePin          = useCallback((note: Note) => updateNote(note.id, { isPinned: !note.isPinned }), [updateNote]);
  const handleNoteDelete       = useCallback((note: Note) => setDeleteNoteId(note.id), []);
  const handleNoteArchive      = useCallback((note: Note) => handleArchive(note.id), [handleArchive]);
  const handleNoteMove         = useCallback((note: Note) => setMoveNoteId(note.id), []);
  const handleNoteMoveToFolder = useCallback((note: Note) => setFolderMoveNoteId(note.id), []);
  const handleNoteReveal       = useCallback((note: Note) => revealNote(note.id, note.projectId), [revealNote]);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Notes list */}
      <div className={cn("w-full md:w-56 flex-shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)]", mobileShowEditor ? "hidden md:flex" : "flex")}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
          <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Notes</span>
          <div className="flex items-center gap-0.5">
            {aiEnabled && (
              <Tooltip content="Generate PRD with AI">
                <Button variant="ghost" size="icon" onClick={() => setPrdModalOpen(true)}>
                  <Wand2 size={13} />
                </Button>
              </Tooltip>
            )}
            <Tooltip content="New folder">
              <Button variant="ghost" size="icon" onClick={() => setNewFolderOpen(true)}><FolderPlus size={13} /></Button>
            </Tooltip>
            <Tooltip content="New note">
              <Button variant="ghost" size="icon" onClick={() => handleCreateNote()}><Plus size={14} /></Button>
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
            <input ref={filterInputRef} type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
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
          {notes.length === 0 && archivedNotes.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <FileText size={20} className="mx-auto mb-2 text-[var(--text-tertiary)] opacity-40" />
              <p className="text-xs text-[var(--text-tertiary)]">No notes yet</p>
              <button onClick={() => handleCreateNote()} className="mt-2 text-xs text-[var(--accent)] hover:underline">
                Create one
              </button>
            </div>
          ) : isFiltering ? (
            // Flat filtered list
            filtered.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-xs text-[var(--text-tertiary)]">No matching notes</p>
              </div>
            ) : (
              filtered.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={note.id === activeNote?.id}
                  onClick={() => handleNoteClick(note.id)}
                  onPin={() => handleNotePin(note)}
                  onDelete={() => handleNoteDelete(note)}
                  onArchive={() => handleNoteArchive(note)}
                  onMove={() => handleNoteMove(note)}
                  onMoveToFolder={() => handleNoteMoveToFolder(note)}
                  onReveal={() => handleNoteReveal(note)}
                  onDragStart={handleNoteDragStart}
                  onDragEnd={handleNoteDragEnd}
                />
              ))
            )
          ) : (
            // Folder tree
            <>
              {/* Folder nodes */}
              {folderTree.map((node) => (
                <FolderTreeNode
                  key={node.path}
                  node={node}
                  activeNoteId={activeNote?.id ?? null}
                  collapsed={collapsedFolders}
                  onToggle={toggleFolder}
                   onNoteClick={handleNoteClick}
                  onNotePin={handleNotePin}
                  onNoteDelete={handleNoteDelete}
                  onNoteArchive={handleNoteArchive}
                  onNoteMove={handleNoteMove}
                  onNoteMoveToFolder={handleNoteMoveToFolder}
                  onNoteReveal={handleNoteReveal}
                  onCreateInFolder={(folder) => handleCreateNote(folder)}
                  dropTarget={dropTarget}
                  onNoteDragStart={handleNoteDragStart}
                  onNoteDragEnd={handleNoteDragEnd}
                  onFolderDragOver={handleFolderDragOver}
                  onFolderDragLeave={handleFolderDragLeave}
                  onFolderDrop={handleFolderDrop}
                />
              ))}
              {/* Root drop zone — visible only while dragging, when folders exist */}
              {folderTree.length > 0 && dropTarget !== null && (
                <div
                  className={cn(
                    "mx-2 my-1 px-3 py-1.5 rounded text-[0.714rem] text-center transition-colors border border-dashed",
                    dropTarget === "__root__"
                      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)]",
                  )}
                  onDragOver={(e) => { e.preventDefault(); setDropTarget("__root__"); }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => { e.preventDefault(); handleFolderDrop(""); }}
                >
                  Move to root
                </div>
              )}
              {/* Root notes (no folder) */}
              {rootNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={note.id === activeNote?.id}
                  onClick={() => handleNoteClick(note.id)}
                  onPin={() => handleNotePin(note)}
                  onDelete={() => handleNoteDelete(note)}
                  onArchive={() => handleNoteArchive(note)}
                  onMove={() => handleNoteMove(note)}
                  onMoveToFolder={() => handleNoteMoveToFolder(note)}
                  onReveal={() => handleNoteReveal(note)}
                  onDragStart={handleNoteDragStart}
                  onDragEnd={handleNoteDragEnd}
                />
              ))}
            </>
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
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => handleCreateNote()}>
            <Plus size={12} /><span className="text-xs">New note</span>
          </Button>
        </div>
      </div>

      {/* Editor pane */}
      <div className={cn("flex-1 min-w-0 flex flex-col overflow-hidden", mobileShowEditor ? "flex" : "hidden md:flex")}>
        {activeNote ? (
          activeNote.type === "dashboard"
            ? <DashboardView note={activeNote} onBack={() => setMobileShowEditor(false)} />
            : <NoteEditor note={activeNote} onBack={() => setMobileShowEditor(false)} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText size={32} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
              <p className="text-sm text-[var(--text-tertiary)]">Select a note or create a new one</p>
              <div className="flex items-center gap-2 mt-4 justify-center">
                <Button variant="accent" size="sm" onClick={() => handleCreateNote()}><Plus size={13} /> New Note</Button>
                <Button variant="ghost" size="sm" onClick={handleCreateDashboard}><LayoutDashboard size={13} /> New Dashboard</Button>
                {aiEnabled && <Button variant="ghost" size="sm" onClick={() => setPrdModalOpen(true)}><Wand2 size={13} /> Generate PRD</Button>}
              </div>
            </div>
          </div>
        )}
      </div>

      {prdModalOpen && activeProjectId && activeWorkspaceId && (
        <PrdModal projectId={activeProjectId} workspaceId={activeWorkspaceId} onClose={() => setPrdModalOpen(false)} />
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

      {/* New folder dialog */}
      {newFolderOpen && (
        <FolderPickerDialog
          folderTree={folderTree}
          mode="create"
          onSelect={(path) => {
            handleCreateNote(path);
            setCollapsedFolders((prev) => ({ ...prev, [path]: false }));
            setNewFolderOpen(false);
          }}
          onClose={() => setNewFolderOpen(false)}
        />
      )}

      {/* Move note to folder dialog */}
      {folderMoveNoteId && (
        <FolderPickerDialog
          folderTree={folderTree}
          mode="move"
          currentFolder={notes.find((n) => n.id === folderMoveNoteId)?.folder ?? ""}
          onSelect={(fp) => { handleMoveNoteToFolder(folderMoveNoteId, fp); }}
          onClose={() => { setFolderMoveNoteId(null); setFolderMoveDest(""); }}
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

// ── FolderTreeNode ────────────────────────────────────────────────────────────

interface FolderTreeNodeProps {
  node: FolderNode;
  activeNoteId: string | null;
  collapsed: Record<string, boolean>;
  depth?: number;
  onToggle: (path: string) => void;
  onNoteClick: (id: string) => void;
  onNotePin: (note: Note) => void;
  onNoteDelete: (note: Note) => void;
  onNoteArchive: (note: Note) => void;
  onNoteMove: (note: Note) => void;
  onNoteMoveToFolder: (note: Note) => void;
  onNoteReveal: (note: Note) => void;
  onCreateInFolder: (folder: string) => void;
  // drag-and-drop
  dropTarget: string | null;
  onNoteDragStart: (noteId: string) => void;
  onNoteDragEnd: () => void;
  onFolderDragOver: (folderPath: string) => void;
  onFolderDragLeave: () => void;
  onFolderDrop: (folderPath: string) => void;
}

const FolderTreeNode = memo(function FolderTreeNode({
  node, activeNoteId, collapsed, depth = 0,
  onToggle, onNoteClick, onNotePin, onNoteDelete,
  onNoteArchive, onNoteMove, onNoteMoveToFolder, onNoteReveal, onCreateInFolder,
  dropTarget, onNoteDragStart, onNoteDragEnd, onFolderDragOver, onFolderDragLeave, onFolderDrop,
}: FolderTreeNodeProps) {
  const isCollapsed = collapsed[node.path];
  const indent = depth * 10;
  const isDragOver = dropTarget === node.path;

  return (
    <div>
      {/* Folder row */}
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1.5 cursor-pointer transition-colors",
          isDragOver
            ? "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] outline outline-1 outline-[var(--accent)] outline-offset-[-1px] rounded"
            : "hover:bg-[var(--surface-2)]",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => onToggle(node.path)}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onFolderDragOver(node.path); }}
        onDragLeave={(e) => { e.stopPropagation(); onFolderDragLeave(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onFolderDrop(node.path); }}
      >
        {isCollapsed
          ? <ChevronRight size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          : <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />}
        {isCollapsed
          ? <Folder size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
          : <FolderOpen size={12} className="text-[var(--accent)] flex-shrink-0" />}
        <span className="text-[0.786rem] font-medium text-[var(--text-secondary)] flex-1 truncate">{node.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onCreateInFolder(node.path); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-all"
          title={`New note in ${node.name}`}
        >
          <Plus size={10} />
        </button>
      </div>

      {/* Folder contents */}
      {!isCollapsed && (
        <div>
          {/* Child folders */}
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              activeNoteId={activeNoteId}
              collapsed={collapsed}
              depth={depth + 1}
              onToggle={onToggle}
              onNoteClick={onNoteClick}
              onNotePin={onNotePin}
              onNoteDelete={onNoteDelete}
              onNoteArchive={onNoteArchive}
              onNoteMove={onNoteMove}
              onNoteMoveToFolder={onNoteMoveToFolder}
              onNoteReveal={onNoteReveal}
              onCreateInFolder={onCreateInFolder}
              dropTarget={dropTarget}
              onNoteDragStart={onNoteDragStart}
              onNoteDragEnd={onNoteDragEnd}
              onFolderDragOver={onFolderDragOver}
              onFolderDragLeave={onFolderDragLeave}
              onFolderDrop={onFolderDrop}
            />
          ))}
          {/* Notes in this folder */}
          {node.notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              isActive={note.id === activeNoteId}
              indent={indent + 16}
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
          {/* Empty folder state */}
          {node.notes.length === 0 && node.children.length === 0 && (
            <button
              onClick={() => onCreateInFolder(node.path)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors"
              style={{ paddingLeft: `${indent + 24}px` }}
            >
              <Plus size={10} />
              New note
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// ── NoteListItem ──────────────────────────────────────────────────────────────

interface NoteListItemProps {
  note: Note; isActive: boolean; indent?: number;
  onClick: () => void; onPin: () => void; onDelete: () => void;
  onArchive: () => void; onMove: () => void; onMoveToFolder: () => void; onReveal: () => void;
  onDragStart?: (noteId: string) => void;
  onDragEnd?: () => void;
}

const NoteListItem = React.memo(function NoteListItem({ note, isActive, indent = 0, onClick, onPin, onDelete, onArchive, onMove, onMoveToFolder, onReveal, onDragStart, onDragEnd }: NoteListItemProps) {
  return (
    <div onClick={onClick}
      draggable={!!onDragStart}
      onDragStart={(e) => { e.stopPropagation(); onDragStart?.(note.id); }}
      onDragEnd={(e) => { e.stopPropagation(); onDragEnd?.(); }}
      className={cn("group relative flex flex-col gap-0.5 py-2.5 cursor-pointer transition-colors pr-3",
        isActive ? "bg-[var(--surface-2)] border-l-2 border-[var(--accent)]" : "hover:bg-[var(--surface-2)] border-l-2 border-transparent")}
      style={{ paddingLeft: `${12 + indent}px` }}
    >
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
              <FileText size={12} />Reveal in {window.electron?.platform === "win32" ? "Explorer" : window.electron?.platform === "linux" ? "Files" : "Finder"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onArchive(); }}>
              <Archive size={12} />Archive
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMoveToFolder(); }}>
              <FolderSymlink size={12} />Move to folder
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
});

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

// ── FolderPickerDialog ────────────────────────────────────────────────────────

interface FolderPickerDialogProps {
  folderTree: FolderNode[];
  /** "move" — clicking a row moves immediately. "create" — picking a row sets parent, inline input creates child. */
  mode: "move" | "create";
  currentFolder?: string;
  onSelect: (folder: string) => void;
  onClose: () => void;
}

function FolderPickerDialog({ folderTree, mode, currentFolder = "", onSelect, onClose }: FolderPickerDialogProps) {
  // parentPath="" means creating at root; "Design" means child of Design
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingUnder !== null) newInputRef.current?.focus();
  }, [addingUnder]);

  function handleCreate() {
    const name = newFolderName.trim();
    if (!name) return;
    const full = addingUnder ? `${addingUnder}/${name}` : name;
    onSelect(full);
  }

  function openAdd(parentPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    setAddingUnder(parentPath);
    setNewFolderName("");
  }

  function cancelAdd() {
    setAddingUnder(null);
    setNewFolderName("");
  }

  const inlineInput = (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--surface-2)]">
      <FolderPlus size={12} className="text-[var(--accent)] shrink-0" />
      <input
        ref={newInputRef}
        value={newFolderName}
        onChange={(e) => setNewFolderName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleCreate();
          if (e.key === "Escape") cancelAdd();
        }}
        placeholder="Folder name…"
        className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
      />
      <button
        onClick={handleCreate}
        disabled={!newFolderName.trim()}
        className="text-[0.714rem] text-[var(--accent)] disabled:opacity-30 hover:underline shrink-0"
      >
        Create & move
      </button>
      <button onClick={cancelAdd} className="text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
        ✕
      </button>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New folder" : "Move to folder"}</DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-5 pt-1">
          <div className="rounded-lg border border-[var(--border)] overflow-hidden mb-3">

            {/* Root row */}
            <div className={cn(
              "group flex items-center gap-2 px-3 py-2 text-xs transition-colors border-b border-[var(--border)]",
              currentFolder === "" && mode === "move" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            )}>
              <button
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                onClick={() => mode === "move" ? onSelect("") : openAdd("", { stopPropagation: () => {} } as React.MouseEvent)}
              >
                <Folder size={12} className="shrink-0" />
                <span className="font-medium">Root</span>
              </button>
              <button
                onClick={(e) => openAdd("", e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all"
                title="New folder in root"
              >
                <FolderPlus size={11} />
              </button>
            </div>

            {/* Inline input under root */}
            {addingUnder === "" && inlineInput}

            {folderTree.length === 0 && addingUnder === null && (
              <p className="px-3 py-3 text-[0.714rem] text-[var(--text-tertiary)]">No folders yet</p>
            )}

            {/* Recursive tree */}
            {folderTree.map((node) => (
              <FolderPickerNode
                key={node.path}
                node={node}
                currentFolder={currentFolder}
                depth={0}
                mode={mode}
                addingUnder={addingUnder}
                newFolderName={newFolderName}
                newInputRef={newInputRef}
                onSelect={onSelect}
                onOpenAdd={openAdd}
                onNameChange={setNewFolderName}
                onCreate={handleCreate}
                onCancel={cancelAdd}
                inlineInput={inlineInput}
              />
            ))}
          </div>

          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FolderPickerNodeProps {
  node: FolderNode;
  currentFolder: string;
  depth: number;
  mode: "move" | "create";
  addingUnder: string | null;
  newFolderName: string;
  newInputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (folder: string) => void;
  onOpenAdd: (parentPath: string, e: React.MouseEvent) => void;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  inlineInput: React.ReactNode;
}

function FolderPickerNode({
  node, currentFolder, depth, mode, addingUnder, onSelect, onOpenAdd, inlineInput,
}: FolderPickerNodeProps) {
  const [open, setOpen] = useState(true);
  const isSelected = mode === "move" && currentFolder === node.path;
  const indent = depth * 12;

  return (
    <div className="border-t border-[var(--border)]">
      <div
        className={cn(
          "group flex items-center gap-2 text-xs transition-colors",
          isSelected
            ? "bg-[var(--accent-dim)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
        style={{ paddingLeft: `${12 + indent}px`, paddingRight: "12px", paddingTop: "7px", paddingBottom: "7px" }}
      >
        {/* Chevron */}
        {node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            className="shrink-0 text-[var(--text-tertiary)]"
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : (
          <span className="w-[10px] shrink-0" />
        )}
        {/* Folder name */}
        <button
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          onClick={(e) => mode === "move" ? onSelect(node.path) : onOpenAdd(node.path, e)}
        >
          {open && node.children.length > 0
            ? <FolderOpen size={12} className="shrink-0" />
            : <Folder size={12} className="shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {/* Add child folder button */}
        <button
          onClick={(e) => onOpenAdd(node.path, e)}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all shrink-0"
          title={`New folder in ${node.name}`}
        >
          <FolderPlus size={11} />
        </button>
      </div>

      {/* Inline input for this node */}
      {addingUnder === node.path && inlineInput}

      {/* Children */}
      {open && node.children.map((child) => (
        <FolderPickerNode
          key={child.path}
          node={child}
          currentFolder={currentFolder}
          depth={depth + 1}
          mode={mode}
          addingUnder={addingUnder}
          newFolderName=""
          newInputRef={{ current: null }}
          onSelect={onSelect}
          onOpenAdd={onOpenAdd}
          onNameChange={() => {}}
          onCreate={() => {}}
          onCancel={() => {}}
          inlineInput={inlineInput}
        />
      ))}
    </div>
  );
}
