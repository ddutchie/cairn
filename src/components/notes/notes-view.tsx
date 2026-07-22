"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileText, Plus, Search, Wand2,
  LayoutDashboard, FolderPlus, LayoutTemplate,
  ChevronDown, ChevronRight, Trash2, X,
} from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MIN_NOTES_SIDEBAR_WIDTH, MAX_NOTES_SIDEBAR_WIDTH } from "@/store/slices/ui";
import { Tooltip } from "@/components/ui/tooltip";
import { NoteEditor } from "./note-editor";
import { DashboardView } from "./dashboard-view";
import { PrdModal } from "./notes-view/PrdModal";
import { MoveNoteModal } from "./notes-view/MoveNoteModal";
import { DashboardTemplateModal } from "./DashboardTemplateModal";
import { useNoteFilter } from "./notes-view/useNoteFilter";
import { buildFolderTree, type FolderNode } from "./notes-view/buildFolderTree";
import { NoteListItem } from "./notes-view/NoteListItem";
import { ArchivedNoteListItem } from "./notes-view/ArchivedNoteListItem";
import { FolderTreeNode } from "./notes-view/FolderTreeNode";
import { setActiveCrossProjectDrag } from "@/lib/cross-project-dnd";
import { FolderPickerDialog } from "./notes-view/FolderPickerDialog";
import { instantiateTemplate, defaultTitleFromTemplate } from "../../../shared/notes/templates";
import { STARTER_TEMPLATES } from "../../../shared/notes/starter-templates";
import { stripMarkdown } from "./note-editor-utils";
import type { Note } from "@/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";

// ── NotesView orchestrator ──────────────────────────────────────────────────

export function NotesView() {
  const {
    activeProjectId, activeWorkspaceId,
    getProjectNotes, getArchivedProjectNotes, getProjectTemplates,
    createNote, updateNote, deleteNote,
    archiveNote, restoreNote, moveNoteToProject, moveNoteToFolder, moveFolder,
    revealNote,
    getTagById,
    getWorkspaceProjects,
    notes: allNotes,
    aiConfig,
    notesSidebarWidth,
    setNotesSidebarWidth,
    notesFullscreen,
    toggleNotesFullscreen,
  } = useCairnStore(useShallow((s) => ({
    activeProjectId:         s.activeProjectId,
    activeWorkspaceId:       s.activeWorkspaceId,
    getProjectNotes:         s.getProjectNotes,
    getArchivedProjectNotes: s.getArchivedProjectNotes,
    getProjectTemplates:     s.getProjectTemplates,
    createNote:              s.createNote,
    updateNote:              s.updateNote,
    deleteNote:              s.deleteNote,
    archiveNote:             s.archiveNote,
    restoreNote:             s.restoreNote,
    moveNoteToProject:       s.moveNoteToProject,
    moveNoteToFolder:        s.moveNoteToFolder,
    moveFolder:              s.moveFolder,
    revealNote:              s.revealNote,
    getTagById:              s.getTagById,
    getWorkspaceProjects:    s.getWorkspaceProjects,
    notes:                   s.notes,
    aiConfig:                s.aiConfig,
    notesSidebarWidth:       s.notesSidebarWidth,
    setNotesSidebarWidth:    s.setNotesSidebarWidth,
    notesFullscreen:         s.notesFullscreen,
    toggleNotesFullscreen:   s.toggleNotesFullscreen,
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

  // ── Resizable sidebar ──────────────────────────────────────────────────────────
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarDividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const divider = sidebarDividerRef.current;
    const panel = sidebarRef.current;
    if (!divider || !panel) return;

    let dragging = false;
    let startX = 0;
    let startW = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      const next = Math.min(MAX_NOTES_SIDEBAR_WIDTH, Math.max(MIN_NOTES_SIDEBAR_WIDTH, startW + (e.clientX - startX)));
      panel!.style.width = `${next}px`;
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setNotesSidebarWidth(panel!.offsetWidth);
    }

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      startX = e.clientX;
      startW = panel!.offsetWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    divider.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      divider.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [setNotesSidebarWidth]);

  // folder → collapsed state; true = collapsed, undefined/false = open
  const [collapsedFolders, setCollapsedFolders]  = useState<Record<string, boolean>>({});

  // ⌘F / Ctrl+F — focus the filter input, but only when the CM6 editor
  // is NOT focused (CM6's own searchKeymap handles it when the editor is active).
  // ⌘. / Ctrl+. — toggle distraction-free mode (works from anywhere in the view).
  const filterInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        const inEditor = document.activeElement?.closest(".cm-editor") !== null;
        if (inEditor) return; // let CM6 searchKeymap handle it
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ".") {
        e.preventDefault();
        toggleNotesFullscreen();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleNotesFullscreen]);

  // "Move to folder" for a specific note
  const [folderMoveNoteId, setFolderMoveNoteId]  = useState<string | null>(null);
  const [, setFolderMoveDest]       = useState("");

  // Drag-and-drop: note → folder, and folder → folder (reparent subtree)
  const dragNoteIdRef = useRef<string | null>(null);
  const dragFolderPathRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget]              = useState<string | null>(null); // folder path or "__root__"
  const [isDragging, setIsDragging]              = useState(false);

  const handleNoteDragStart = useCallback((noteId: string) => {
    dragNoteIdRef.current = noteId;
    dragFolderPathRef.current = null;
    setIsDragging(true);
    // Also expose the drag to the leftmost project sidebar so a single note can
    // be dropped onto another project (moves just that note, keeping its folder).
    if (activeProjectId) {
      const note = allNotes.find((n) => n.id === noteId);
      setActiveCrossProjectDrag({
        kind: "note",
        noteId,
        sourceProjectId: activeProjectId,
        label: note?.title ?? "note",
      });
    }
  }, [activeProjectId, allNotes]);

  const handleNoteDragEnd = useCallback(() => {
    dragNoteIdRef.current = null;
    setDropTarget(null);
    setIsDragging(false);
    setActiveCrossProjectDrag(null);
  }, []);

  const handleFolderDragStart = useCallback((folderPath: string) => {
    dragFolderPathRef.current = folderPath;
    dragNoteIdRef.current = null;
    setIsDragging(true);
    // Also expose the drag to the leftmost project sidebar so the folder can be
    // dropped onto another project (moves the whole subtree cross-project).
    if (activeProjectId) {
      setActiveCrossProjectDrag({
        kind: "folder",
        sourceProjectId: activeProjectId,
        folderPath,
        label: folderPath.split("/").pop() ?? folderPath,
      });
    }
  }, [activeProjectId]);

  const handleFolderDragEndSource = useCallback(() => {
    dragFolderPathRef.current = null;
    setDropTarget(null);
    setIsDragging(false);
    setActiveCrossProjectDrag(null);
  }, []);

  const handleFolderDragOver = useCallback((folderPath: string) => {
    // Don't highlight a folder as a drop target when dragging it onto itself
    // or into one of its own descendants (an illegal reparent).
    const dragged = dragFolderPathRef.current;
    if (dragged && (folderPath === dragged || folderPath.startsWith(`${dragged}/`))) {
      setDropTarget(null);
      return;
    }
    setDropTarget(folderPath);
  }, []);

  const handleFolderDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleFolderDrop = useCallback((folderPath: string) => {
    const folderPathDragged = dragFolderPathRef.current;
    if (folderPathDragged && activeProjectId) {
      // folderPath is the DESTINATION folder ("" = root). Reparent the dragged
      // subtree so it lives inside the destination folder.
      moveFolder(activeProjectId, folderPathDragged, folderPath);
    } else {
      const noteId = dragNoteIdRef.current;
      if (noteId) moveNoteToFolder(noteId, folderPath);
    }
    dragNoteIdRef.current = null;
    dragFolderPathRef.current = null;
    setDropTarget(null);
    setIsDragging(false);
  }, [moveNoteToFolder, moveFolder, activeProjectId]);


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
  const templates = useMemo(
    () => activeProjectId ? getProjectTemplates(activeProjectId) : [],
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
  // Resolve the active note across notes and templates (templates are excluded
  // from `notes`, but a just-saved/opened template can be the active id), then
  // fall back to the first note.
  const activeNote = notes.find((n) => n.id === activeNoteId)
    ?? templates.find((n) => n.id === activeNoteId)
    ?? notes[0]
    ?? null;

  // Folder tree — only built when not filtering
  const isFiltering = !!(filter || activeTagId);
  const { rootNotes, folders: folderTree } = useMemo(
    () => isFiltering ? { rootNotes: filtered, folders: [] as FolderNode[] } : buildFolderTree(notes),
    [notes, isFiltering, filtered],
  );



  // Auto-select first note / newly created note in a single unified effect.
  // Merging the two previous competing effects eliminates the race where both
  // could fire in the same render cycle and produce two setState calls.
  const prevNoteIdsRef = useRef<string[]>(notes.map((n) => n.id));
  useEffect(() => {
    const prevIds = prevNoteIdsRef.current;
    if (notes.length > prevIds.length) {
      // A new note was added — select the id that wasn't there before, rather
      // than assuming it sorted to index 0 (pinned notes can sort ahead of it).
      const prevSet = new Set(prevIds);
      const added = notes.find((n) => !prevSet.has(n.id));
      setActiveNoteId((added ?? notes[0]).id);
    } else if (!activeNoteId && notes.length > 0) {
      // No active note yet — select the first one
      setActiveNoteId(notes[0].id);
    }
    prevNoteIdsRef.current = notes.map((n) => n.id);
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

  // Instantiate a new note from a template: substitute {{vars}} and create a
  // normal note (type="note"). No live link back — templates are a starting point.
  function handleNewFromTemplate(template: Note) {
    if (!activeProjectId) return;
    const now = new Date();
    const title = defaultTitleFromTemplate(template.title.replace(/^Template:\s*/i, ""), { now });
    const content = instantiateTemplate(template.content ?? "", { title, now });
    const note = createNote(activeProjectId, title, "note");
    updateNote(note.id, {
      content,
      contentText: stripMarkdown(content),
      tagIds: template.tagIds ?? [],
    });
    setActiveNoteId(note.id);
    setMobileShowEditor(true);
  }

  // Turn the active note into a reusable template (type="template").
  function handleSaveAsTemplate(note: Note) {
    if (!activeProjectId) return;
    const title = /^Template:/i.test(note.title) ? note.title : `Template: ${note.title}`;
    const tpl = createNote(activeProjectId, title, "template");
    updateNote(tpl.id, {
      content: note.content ?? "",
      contentText: note.contentText ?? "",
      tagIds: note.tagIds ?? [],
    });
    setActiveNoteId(tpl.id);
    setMobileShowEditor(true);
  }

  // Seed the built-in starter templates into this project (one-time convenience).
  function handleAddStarterTemplates() {
    if (!activeProjectId) return;
    const existing = new Set(templates.map((t) => t.title.toLowerCase()));
    for (const s of STARTER_TEMPLATES) {
      const title = `Template: ${s.name}`;
      if (existing.has(title.toLowerCase())) continue;
      const tpl = createNote(activeProjectId, title, "template");
      updateNote(tpl.id, { content: s.body, contentText: stripMarkdown(s.body) });
    }
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

  // Deep-link from graph: filter by tag
  useEffect(() => {
    const handler = (e: Event) => {
      const { tagId } = (e as CustomEvent).detail;
      setActiveTagId(tagId);
    };
    window.addEventListener("cairn:filter-by-tag", handler);
    return () => window.removeEventListener("cairn:filter-by-tag", handler);
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
      {/* Notes list — hidden in distraction-free mode at the desktop breakpoint only;
          mobile visibility stays governed by mobileShowEditor (Back restores the list). */}
      <div ref={sidebarRef} className={cn("flex-shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)] relative", mobileShowEditor ? "hidden" : "flex", (notesFullscreen && activeNote) ? "md:hidden" : "md:flex")} style={{ width: `${notesSidebarWidth}px` }}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)] flex-shrink-0">
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
            <DropdownMenu>
              <Tooltip content="New from template">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon"><LayoutTemplate size={13} /></Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-52">
                {templates.length === 0 ? (
                  <DropdownMenuItem onClick={handleAddStarterTemplates} className="flex items-center gap-2 text-xs">
                    <Plus size={11} />Add starter templates
                  </DropdownMenuItem>
                ) : (
                  templates.map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      onClick={() => handleNewFromTemplate(t)}
                      className="flex items-center gap-2 text-xs"
                    >
                      <LayoutTemplate size={11} />
                      {t.title.replace(/^Template:\s*/i, "")}
                    </DropdownMenuItem>
                  ))
                )}
                {activeNote && activeNote.type === "note" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleSaveAsTemplate(activeNote)} className="flex items-center gap-2 text-xs">
                      <Plus size={11} />Save current note as template
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
              className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]" />
            {filter && (
              <button
                onClick={() => setFilter("")}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
              >
                <X size={12} />
              </button>
            )}
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
                  onFolderDragStart={handleFolderDragStart}
                  onFolderDragEndSource={handleFolderDragEndSource}
                  onFolderDragOver={handleFolderDragOver}
                  onFolderDragLeave={handleFolderDragLeave}
                  onFolderDrop={handleFolderDrop}
                />
              ))}
              {/* Root drop zone — visible only while dragging, when folders exist */}
              {folderTree.length > 0 && (dropTarget !== null || isDragging) && (
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
                className="flex items-center gap-1.5 w-full px-3 py-2 text-[0.75rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors">
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

        {/* Drag-to-resize handle — sits on the right edge of the sidebar.
            Washes to a 50% accent glow on hover to match every other resize
            handle in the app (PreviewPane / chat / agent). */}
        <div
          ref={sidebarDividerRef}
          className="absolute right-0 top-0 h-full w-1 flex-shrink-0 cursor-col-resize z-10 select-none hidden md:block hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
          style={{ marginRight: -2 }}
          aria-hidden
        />
      </div>

      {/* Editor pane */}
      <div data-tutorial="notes-editor" className={cn("flex-1 min-w-0 flex flex-col overflow-hidden", mobileShowEditor ? "flex" : "hidden md:flex")}>
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

