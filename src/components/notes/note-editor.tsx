"use client";

import React, { useRef, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pin, PinOff, Calendar, Eye, Pencil } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import type { Note } from "@/types";
import { AITextToolbar, buildAIActionPrompt, type AITextAction } from "./ai-text-toolbar";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor";

interface NoteEditorProps {
  note: Note;
}

type EditorMode = "write" | "read";

export function NoteEditor({ note }: NoteEditorProps) {
  const { updateNote, aiConfig } = useCairnStore();
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const [mode, setMode] = useState<EditorMode>("write");



  // AI toolbar state
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const selectionRef = useRef<{ text: string } | null>(null);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleContentChange = useCallback(
    (markdown: string) => {
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

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNote(note.id, { title: e.target.value });
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const electron = (window as any).electron;
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
