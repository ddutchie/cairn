"use client";

import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import {
  FileText, Plus, Pin, PinOff, Trash2, MoreHorizontal, Search,
  Wand2, Archive, ArchiveRestore, FolderInput,
  ChevronDown, ChevronRight, LayoutDashboard, Folder, FolderOpen,
  FolderPlus, FolderSymlink,
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
    revealNote, generatePrd,
    getTagById,
    getWorkspaceProjects,
  } = useCairnStore();

  const [activeNoteId, setActiveNoteId]         = useState<string | null>(null);
  const [filter, setFilter]                     = useState("");
  const [activeTagId, setActiveTagId]           = useState<string | null>(null);
  const [prdModalOpen, setPrdModalOpen]         = useState(false);
  const [moveNoteId, setMoveNoteId]             = useState<string | null>(null);
  const [showArchivedNotes, setShowArchivedNotes] = useState(false);
  const [dashboardTemplateOpen, setDashboardTemplateOpen] = useState(false);
  const [deleteNoteId, setDeleteNoteId]         = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen]        = useState(false);
  const [newFolderName, setNewFolderName]        = useState("");

  // folder → collapsed state; true = collapsed, undefined/false = open
  const [collapsedFolders, setCollapsedFolders]  = useState<Record<string, boolean>>({});
  // "Move to folder" for a specific note
  const [folderMoveNoteId, setFolderMoveNoteId]  = useState<string | null>(null);
  const [folderMoveDest, setFolderMoveDest]       = useState("");

  const notes           = activeProjectId ? getProjectNotes(activeProjectId) : [];
  const archivedNotes   = activeProjectId ? getArchivedProjectNotes(activeProjectId) : [];
  const workspaceProjects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : [];
  const projectTagIds   = [...new Set(notes.flatMap((n) => n.tagIds))];
  const projectTags     = projectTagIds.map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];

  const filtered   = useNoteFilter(notes, filter, activeTagId);
  const activeNote = notes.find((n) => n.id === activeNoteId) ?? notes[0] ?? null;

  // Folder tree — only built when not filtering
  const isFiltering = !!(filter || activeTagId);
  const { rootNotes, folders: folderTree } = isFiltering
    ? { rootNotes: filtered, folders: [] }
    : buildFolderTree(notes);

  // All unique folder paths for the "move to folder" picker
  const allFolderPaths = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort();

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

  function handleCreateNote(inFolder = "") {
    if (!activeProjectId) return;
    // Pass folder directly to createNote so the IPC create call already
    // carries the folder — avoids a separate moveToFolder IPC round-trip
    // and the race window it creates.
    const note = createNote(activeProjectId, "Untitled Note", "note", inFolder);
    setActiveNoteId(note.id);
  }

  function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name || !activeProjectId) return;
    // Immediately create a note in the new folder so it appears in the tree
    handleCreateNote(name);
    setNewFolderOpen(false);
    setNewFolderName("");
    // Auto-expand the new folder
    setCollapsedFolders((prev) => ({ ...prev, [name]: false }));
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
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes..."
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]" />
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
                  onClick={() => setActiveNoteId(note.id)}
                  onPin={() => updateNote(note.id, { isPinned: !note.isPinned })}
                  onDelete={() => setDeleteNoteId(note.id)}
                  onArchive={() => handleArchive(note.id)}
                  onMove={() => setMoveNoteId(note.id)}
                  onMoveToFolder={() => setFolderMoveNoteId(note.id)}
                  onReveal={() => revealNote(note.id, note.projectId)}
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
                  onNoteClick={(id) => setActiveNoteId(id)}
                  onNotePin={(note) => updateNote(note.id, { isPinned: !note.isPinned })}
                  onNoteDelete={(note) => setDeleteNoteId(note.id)}
                  onNoteArchive={(note) => handleArchive(note.id)}
                  onNoteMove={(note) => setMoveNoteId(note.id)}
                  onNoteMoveToFolder={(note) => setFolderMoveNoteId(note.id)}
                  onNoteReveal={(note) => revealNote(note.id, note.projectId)}
                  onCreateInFolder={(folder) => handleCreateNote(folder)}
                />
              ))}
              {/* Root notes (no folder) */}
              {rootNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={note.id === activeNote?.id}
                  onClick={() => setActiveNoteId(note.id)}
                  onPin={() => updateNote(note.id, { isPinned: !note.isPinned })}
                  onDelete={() => setDeleteNoteId(note.id)}
                  onArchive={() => handleArchive(note.id)}
                  onMove={() => setMoveNoteId(note.id)}
                  onMoveToFolder={() => setFolderMoveNoteId(note.id)}
                  onReveal={() => revealNote(note.id, note.projectId)}
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
                <Button variant="accent" size="sm" onClick={() => handleCreateNote()}><Plus size={13} /> New Note</Button>
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

      {/* New folder dialog */}
      <Dialog open={newFolderOpen} onOpenChange={(o) => { if (!o) { setNewFolderOpen(false); setNewFolderName(""); } }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-3">
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") { setNewFolderOpen(false); setNewFolderName(""); } }}
              placeholder="Folder name (e.g. Design/Typography)"
              className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
            />
            <p className="text-[0.786rem] text-[var(--text-tertiary)]">
              Use / to create nested folders, e.g. <span className="font-mono">Research/Papers</span>
            </p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button variant="accent" size="sm" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
                <FolderPlus size={12} /> Create folder
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move note to folder dialog */}
      <Dialog open={!!folderMoveNoteId} onOpenChange={(o) => { if (!o) { setFolderMoveNoteId(null); setFolderMoveDest(""); } }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-3">
            <input
              autoFocus
              value={folderMoveDest}
              onChange={(e) => setFolderMoveDest(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && folderMoveNoteId) { handleMoveNoteToFolder(folderMoveNoteId, folderMoveDest); } if (e.key === "Escape") { setFolderMoveNoteId(null); setFolderMoveDest(""); } }}
              placeholder="Folder path (leave blank for root)"
              className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
            />
            {allFolderPaths.length > 0 && (
              <div className="space-y-0.5">
                <p className="text-[0.714rem] text-[var(--text-tertiary)] uppercase tracking-wider">Existing folders</p>
                <button
                  onClick={() => { if (folderMoveNoteId) handleMoveNoteToFolder(folderMoveNoteId, ""); }}
                  className="w-full text-left px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  / (root)
                </button>
                {allFolderPaths.map((fp) => (
                  <button
                    key={fp}
                    onClick={() => { if (folderMoveNoteId) handleMoveNoteToFolder(folderMoveNoteId, fp); }}
                    className="w-full text-left px-2 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    {fp}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                variant="accent" size="sm"
                onClick={() => { if (folderMoveNoteId) handleMoveNoteToFolder(folderMoveNoteId, folderMoveDest); }}
              >
                <FolderSymlink size={12} /> Move
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
}

const FolderTreeNode = memo(function FolderTreeNode({
  node, activeNoteId, collapsed, depth = 0,
  onToggle, onNoteClick, onNotePin, onNoteDelete,
  onNoteArchive, onNoteMove, onNoteMoveToFolder, onNoteReveal, onCreateInFolder,
}: FolderTreeNodeProps) {
  const isCollapsed = collapsed[node.path];
  const indent = depth * 10;

  return (
    <div>
      {/* Folder row */}
      <div
        className="group flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => onToggle(node.path)}
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
            />
          ))}
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
}

function NoteListItem({ note, isActive, indent = 0, onClick, onPin, onDelete, onArchive, onMove, onMoveToFolder, onReveal }: NoteListItemProps) {
  return (
    <div onClick={onClick}
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
              <FileText size={12} />Reveal in Finder
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
