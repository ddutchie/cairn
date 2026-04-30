"use client";

import React, { useRef, useCallback, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pin, PinOff, Calendar, Eye, Pencil, Wand2, Loader2, CheckCircle2, Tag, Plus, X, Link2, Kanban, ChevronDown } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import type { Note } from "@/types";
import { AITextToolbar, buildAIActionPrompt, type AITextAction } from "./ai-text-toolbar";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor";

interface NoteEditorProps {
  note: Note;
}

type EditorMode = "write" | "read";

export function NoteEditor({ note }: NoteEditorProps) {
  const { updateNote, aiConfig, activeProjectId, getProjectColumns, tags, createTag, getTagById, activeWorkspaceId, notes, cards, columns, setView } = useCairnStore();
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mode, setMode] = useState<EditorMode>("write");
  const [wordCount, setWordCount] = useState(() => countWords(note.content ?? ""));
  // Reset when switching notes
  useEffect(() => {
    setWordCount(countWords(note.content ?? ""));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // Spawn tasks state
  const [spawnLoading, setSpawnLoading] = useState(false);
  const [spawnResult, setSpawnResult] = useState<{ count: number } | null>(null);
  const [spawnToolCalls, setSpawnToolCalls] = useState<string[]>([]);

  // AI toolbar state
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const selectionRef = useRef<{ text: string } | null>(null);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleContentChange = useCallback(
    (markdown: string) => {
      setWordCount(countWords(markdown));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateNote(note.id, {
          content: markdown,
          contentText: stripMarkdown(markdown),
        });
      }, 300);
    },
    [note.id, updateNote]
  );

  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = setTimeout(() => {
        updateNote(note.id, { title: value });
      }, 300);
    },
    [note.id, updateNote]
  );

  // ── AI toolbar — driven by CodeMirror selection events ────────────────────
  const handleSelectionChange = useCallback(
    (sel: { text: string; coords: { top: number; left: number } } | null) => {
      if (!sel) {
        setToolbarPos(null);
        selectionRef.current = null;
        return;
      }
      selectionRef.current = { text: sel.text };
      const rect = containerRef.current?.getBoundingClientRect();
      const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const OFFSET = 10;
      setToolbarPos({
        top: sel.coords.top - OFFSET,
        left: centerX,
      });
    },
    []
  );

  const handleAIAction = useCallback(
    async (action: AITextAction, customPrompt?: string) => {
      const sel = selectionRef.current;
      if (!sel) return;
      const electron = window.electron;
      if (!electron) return;

      setAiLoading(true);
      try {
        const prompt = buildAIActionPrompt(action, sel.text, customPrompt);
        const result = (await electron.chatSend({
          message: prompt,
          threadId: "ai-text-action",
          config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
        })) as { content: string };

        const replacement = result.content?.trim();
        if (!replacement) return;

        editorRef.current?.replaceSelection(replacement);
      } finally {
        setAiLoading(false);
        setToolbarPos(null);
        selectionRef.current = null;
      }
    },
    [aiConfig]
  );

  useEffect(() => {
    if (!spawnLoading) return;
    const electron = window.electron;
    if (!electron) return;
    const unsub = electron.chat.onToolCall((e) => {
      if (e.tool === "create_task") {
        setSpawnToolCalls((prev) => [...prev, e.label]);
      }
    });
    return unsub;
  }, [spawnLoading]);

  const handleSpawnTasks = useCallback(async () => {
    const electron = window.electron;
    if (!electron || !activeProjectId) return;

    const columns = getProjectColumns(activeProjectId);
    const backlogCol = columns.find((c) => c.type === "backlog") ?? columns[0];
    if (!backlogCol) return;

    setSpawnLoading(true);
    setSpawnResult(null);
    setSpawnToolCalls([]);
    try {
      const result = await electron.chatSend({
        message: `Spawn tasks from the note with id="${note.id}" into column "${backlogCol.id}". Use the spawn_tasks_from_note tool.`,
        threadId: "spawn-tasks",
        projectId: activeProjectId,
        config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
      }) as { content: string };

      // Try to parse task count from the tool result embedded in the response
      const match = result.content?.match(/(\d+)\s+task/i);
      const count = match ? parseInt(match[1], 10) : null;
      setSpawnResult({ count: count ?? 0 });
      setTimeout(() => setSpawnResult(null), 4000);
    } finally {
      setSpawnLoading(false);
    }
  }, [note.id, activeProjectId, getProjectColumns, aiConfig]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full overflow-hidden"
      onMouseDown={(e) => {
        // Dismiss toolbar when clicking outside the editor content
        const target = e.target as HTMLElement;
        if (!target.closest(".cm-editor") && !target.closest("[data-ai-toolbar]")) {
          setToolbarPos(null);
        }
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        {/* Mode toggle */}
        <div className="flex items-center gap-0.5 bg-[var(--surface-2)] rounded-md p-0.5">
          <button
            onClick={() => { setMode("write"); setTimeout(() => editorRef.current?.focus(), 50); }}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
              mode === "write"
                ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            )}
          >
            <Pencil size={11} />
            Write
          </button>
          <button
            onClick={() => setMode("read")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
              mode === "read"
                ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            )}
          >
            <Eye size={11} />
            Read
          </button>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-2">
          {spawnLoading ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
              <Loader2 size={11} className="animate-spin text-[var(--accent)] shrink-0" />
              <span className="text-[11px] text-[var(--text-tertiary)]">
                {spawnToolCalls.length === 0
                  ? "Analysing…"
                  : spawnToolCalls[spawnToolCalls.length - 1].replace("Creating task ", "").replace(/^"|"$/g, "")}
              </span>
              {spawnToolCalls.length > 0 && (
                <span className="text-[10px] text-[var(--accent)] font-medium">{spawnToolCalls.length}</span>
              )}
            </div>
          ) : (
            <Tooltip content="Spawn tasks from this note">
              <button
                onClick={handleSpawnTasks}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
                  spawnResult
                    ? "text-[var(--success)] bg-[var(--success)]/10"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                )}
              >
                {spawnResult ? <CheckCircle2 size={12} /> : <Wand2 size={12} />}
                {spawnResult ? `${spawnResult.count} tasks added` : "Spawn tasks"}
              </button>
            </Tooltip>
          )}
          <Tooltip content={note.isPinned ? "Unpin note" : "Pin note"}>
            <button
              onClick={() => updateNote(note.id, { isPinned: !note.isPinned })}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                note.isPinned
                  ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              )}
            >
              {note.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
          </Tooltip>
          <span className="text-[11px] text-[var(--text-tertiary)]">
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"} · {Math.max(1, Math.ceil(wordCount / 200))} min read
          </span>
          <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1">
            <Calendar size={10} />
            {formatRelative(note.updatedAt)}
          </span>
        </div>
      </div>

      {/* ── Title ──────────────────────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-3 flex-shrink-0 border-b border-[var(--border)]">
        <input
          type="text"
          value={note.title}
          onChange={handleTitleChange}
          placeholder="Note title"
          className="w-full bg-transparent text-2xl font-bold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none tracking-tight max-w-[680px] mx-auto block"
        />
        {/* Tag bar */}
        <NoteTagBar
          note={note}
          workspaceTags={tags.filter((t) => t.workspaceId === activeWorkspaceId)}
          onToggleTag={(tagId) => {
            const has = note.tagIds.includes(tagId);
            updateNote(note.id, { tagIds: has ? note.tagIds.filter((id) => id !== tagId) : [...note.tagIds, tagId] });
          }}
          onCreateTag={(name) => {
            if (!activeWorkspaceId) return;
            const tag = createTag(activeWorkspaceId, name);
            updateNote(note.id, { tagIds: [...note.tagIds, tag.id] });
          }}
          getTagById={getTagById}
        />
      </div>

      {/* ── Editor / Preview ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* CodeMirror — always mounted so state is preserved when toggling */}
        <div className={cn("absolute inset-0 overflow-auto", mode === "read" && "invisible pointer-events-none")}>
          <MarkdownEditor
            key={note.id}
            ref={editorRef}
            initialValue={note.content ?? ""}
            onChange={handleContentChange}
            onSelectionChange={handleSelectionChange}
            placeholder="Write here…"
          />
        </div>

        {/* Read / preview pane */}
        {mode === "read" && (
          <div className="absolute inset-0 overflow-y-auto">
            <div className="px-6 py-5 max-w-[680px] mx-auto">
              {note.content ? (
                <div className="prose-cairn">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {note.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-tertiary)] italic">Nothing to preview yet.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Backlinks panel ─────────────────────────────────────────────────── */}
      <BacklinksPanel note={note} notes={notes} cards={cards} columns={columns} onOpenCard={() => setView("board")} />

      {/* ── AI floating toolbar ─────────────────────────────────────────────── */}
      {toolbarPos && (
        <AITextToolbar
          position={toolbarPos}
          onAction={handleAIAction}
          loading={aiLoading}
          onDismiss={() => {
            setToolbarPos(null);
            selectionRef.current = null;
          }}
        />
      )}
    </div>
  );
}

// ── Backlinks Panel ───────────────────────────────────────────────────────────

interface BacklinksPanelProps {
  note: Note;
  notes: import("@/types").Note[];
  cards: import("@/types").TaskCard[];
  columns: import("@/types").BoardColumn[];
  onOpenCard: () => void;
}

function BacklinksPanel({ note, notes, cards, columns, onOpenCard }: BacklinksPanelProps) {
  const [open, setOpen] = useState(false);

  const linkedNotes = (note.linkedNoteIds ?? [])
    .map((id) => notes.find((n) => n.id === id))
    .filter(Boolean) as import("@/types").Note[];
  const linkedCards = (note.linkedCardIds ?? [])
    .map((id) => cards.find((c) => c.id === id))
    .filter(Boolean) as import("@/types").TaskCard[];

  const total = linkedNotes.length + linkedCards.length;
  if (total === 0) return null;

  return (
    <div className="flex-shrink-0 border-t border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-6 py-2.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
      >
        <Link2 size={11} />
        <span className="flex-1 text-left">{total} backlink{total !== 1 ? "s" : ""}</span>
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-6 pb-3 space-y-1">
          {linkedNotes.map((n) => (
            <div key={n.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors">
              <span className="w-3 h-3 flex items-center justify-center text-[var(--text-tertiary)]">📄</span>
              <span className="truncate flex-1">{n.title}</span>
              <span className="text-[10px] text-[var(--text-tertiary)]">note</span>
            </div>
          ))}
          {linkedCards.map((c) => {
            const col = columns.find((col) => col.id === c.columnId);
            return (
              <button
                key={c.id}
                onClick={onOpenCard}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
              >
                <Kanban size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                <span className="truncate flex-1">{c.title}</span>
                <span className="text-[10px] text-[var(--text-tertiary)]">{col?.name ?? "card"}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Note Tag Bar ──────────────────────────────────────────────────────────────

interface NoteTagBarProps {
  note: Note;
  workspaceTags: import("@/types").Tag[];
  onToggleTag: (tagId: string) => void;
  onCreateTag: (name: string) => void;
  getTagById: (id: string) => import("@/types").Tag | undefined;
}

function NoteTagBar({ note, workspaceTags, onToggleTag, onCreateTag, getTagById }: NoteTagBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close picker when clicking outside
  useEffect(() => {
    if (!pickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setNewTagName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pickerOpen]);

  useEffect(() => {
    if (pickerOpen) inputRef.current?.focus();
  }, [pickerOpen]);

  const assignedTags = note.tagIds.map((id) => getTagById(id)).filter(Boolean) as import("@/types").Tag[];
  const unassignedTags = workspaceTags.filter((t) => !note.tagIds.includes(t.id));
  const filteredUnassigned = newTagName
    ? unassignedTags.filter((t) => t.name.toLowerCase().includes(newTagName.toLowerCase()))
    : unassignedTags;

  function handleCreateTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    onCreateTag(trimmed);
    setNewTagName("");
    setPickerOpen(false);
  }

  return (
    <div className="flex items-center gap-1.5 mt-2.5 max-w-[680px] mx-auto flex-wrap relative">
      {/* Assigned tags */}
      {assignedTags.map((tag) => (
        <button
          key={tag.id}
          onClick={() => onToggleTag(tag.id)}
          className="group flex items-center gap-0.5"
          title={`Remove tag "${tag.name}"`}
        >
          <Badge color={tag.color}>{tag.name}</Badge>
          <X size={9} className="opacity-0 group-hover:opacity-100 text-[var(--text-tertiary)] transition-opacity -ml-1" />
        </button>
      ))}

      {/* Add tag button */}
      <div className="relative" ref={pickerRef}>
        <button
          onClick={() => setPickerOpen((o) => !o)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] border border-dashed border-[var(--border)] transition-colors"
        >
          <Tag size={9} />
          Add tag
        </button>

        {pickerOpen && (
          <div className="absolute top-full left-0 mt-1 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg p-2 w-48">
            <input
              ref={inputRef}
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (filteredUnassigned.length === 0 && newTagName.trim()) handleCreateTag();
                  else if (filteredUnassigned.length > 0) { onToggleTag(filteredUnassigned[0].id); setPickerOpen(false); setNewTagName(""); }
                }
                if (e.key === "Escape") { setPickerOpen(false); setNewTagName(""); }
              }}
              placeholder="Search or create…"
              className="w-full px-2 py-1 text-xs rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] mb-2"
            />
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {filteredUnassigned.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => { onToggleTag(tag.id); setPickerOpen(false); setNewTagName(""); }}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs hover:bg-[var(--surface-2)] transition-colors text-left"
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                  <span className="text-[var(--text-secondary)] truncate">{tag.name}</span>
                </button>
              ))}
              {newTagName.trim() && (
                <button
                  onClick={handleCreateTag}
                  className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs hover:bg-[var(--surface-2)] transition-colors text-left text-[var(--accent)]"
                >
                  <Plus size={10} />
                  Create &quot;{newTagName.trim()}&quot;
                </button>
              )}
              {filteredUnassigned.length === 0 && !newTagName.trim() && (
                <p className="text-[11px] text-[var(--text-tertiary)] px-2 py-1">No tags yet</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Count words in markdown content (strips syntax first) */
function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** Strip markdown syntax to get plain text for search indexing */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
