"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pin, PinOff, Calendar } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import type { Note } from "@/types";
import { AITextToolbar, buildAIActionPrompt, type AITextAction } from "./ai-text-toolbar";

interface NoteEditorProps {
  note: Note;
}

export function NoteEditor({ note }: NoteEditorProps) {
  const { updateNote, aiConfig } = useCairnStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AI toolbar state
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const selectionRef = useRef<{ start: number; end: number; text: string } | null>(null);

  // Focus editor when note changes
  useEffect(() => {
    textareaRef.current?.focus();
  }, [note.id]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const markdown = e.target.value;
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

  // Show AI toolbar when user releases mouse with a selection in the textarea
  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end).trim();
    if (!selected || selected.length < 3) { setToolbarPos(null); return; }

    selectionRef.current = { start, end, text: selected };

    // Position toolbar above where the mouse was released.
    // window.getSelection() is always empty for textareas, so we use the event coords.
    const TOOLBAR_HEIGHT = 40;
    const OFFSET = 8;
    setToolbarPos({
      top: e.clientY - TOOLBAR_HEIGHT - OFFSET,
      left: Math.max(8, e.clientX - 100),
    });
  }, []);

  const handleAIAction = useCallback(async (action: AITextAction, customPrompt?: string) => {
    const sel = selectionRef.current;
    if (!sel) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).electron;
    if (!electron) return;

    setAiLoading(true);
    try {
      const prompt = buildAIActionPrompt(action, sel.text, customPrompt);
      const result = await electron.chatSend({
        message: prompt,
        threadId: "ai-text-action",
        config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
      }) as { content: string };

      const replacement = result.content?.trim();
      if (!replacement) return;

      const ta = textareaRef.current;
      if (!ta) return;

      const newValue = ta.value.slice(0, sel.start) + replacement + ta.value.slice(sel.end);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      nativeSetter?.call(ta, newValue);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => {
        ta.selectionStart = sel.start;
        ta.selectionEnd = sel.start + replacement.length;
        ta.focus();
      });
    } finally {
      setAiLoading(false);
      setToolbarPos(null);
      selectionRef.current = null;
    }
  }, [aiConfig]);

  // Tab key inserts 2 spaces instead of moving focus
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newValue = ta.value.slice(0, start) + "  " + ta.value.slice(end);
      // Use native input value setter so React picks it up
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeInputValueSetter?.call(ta, newValue);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden" onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement)) { setToolbarPos(null); } }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-tertiary)] font-mono uppercase tracking-wider">Edit</span>
          <div className="w-px h-3 bg-[var(--border)]" />
          <span className="text-xs text-[var(--text-tertiary)] font-mono uppercase tracking-wider">Preview</span>
        </div>
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

      {/* Title */}
      <div className="px-6 pt-5 pb-3 flex-shrink-0 border-b border-[var(--border)]">
        <input
          type="text"
          value={note.title}
          onChange={handleTitleChange}
          placeholder="Note title"
          className="w-full bg-transparent text-2xl font-bold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none tracking-tight"
        />
      </div>

      {/* Split pane */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Editor pane */}
        <div className="flex-1 min-w-0 border-r border-[var(--border)] overflow-hidden flex flex-col">
          <textarea
            ref={textareaRef}
            defaultValue={note.content ?? ""}
            key={note.id}
            onChange={handleContentChange}
            onKeyDown={(e) => { if (e.key === "Escape") setToolbarPos(null); handleKeyDown(e); }}
            onMouseUp={handleMouseUp}
            onKeyUp={(e) => {
              // Handle keyboard selections (shift+arrows)
              if (!e.shiftKey) return;
              const ta = e.currentTarget;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const selected = ta.value.slice(start, end).trim();
              if (!selected || selected.length < 3) { setToolbarPos(null); return; }
              selectionRef.current = { start, end, text: selected };
              const rect = ta.getBoundingClientRect();
              setToolbarPos({ top: rect.top - 48, left: rect.left + rect.width / 2 - 100 });
            }}
            placeholder="Write markdown here…"
            spellCheck={false}
            className={cn(
              "flex-1 w-full h-full resize-none bg-transparent",
              "px-6 py-5 text-sm font-mono leading-relaxed",
              "text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
              "focus:outline-none"
            )}
          />
        </div>

        {/* Preview pane */}
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
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

      {/* AI floating toolbar */}
      {toolbarPos && (
        <AITextToolbar
          position={toolbarPos}
          onAction={handleAIAction}
          loading={aiLoading}
          onDismiss={() => { setToolbarPos(null); selectionRef.current = null; }}
        />
      )}
    </div>
  );
}

/** Strip markdown syntax to get plain text for search indexing */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")       // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/\*(.+?)\*/g, "$1")        // italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*+]\s+/gm, "")        // bullet lists
    .replace(/^\d+\.\s+/gm, "")        // ordered lists
    .replace(/^>\s+/gm, "")            // blockquotes
    .replace(/^---+$/gm, "")           // hr
    .replace(/\|/g, " ")               // tables
    .replace(/\n{2,}/g, "\n")
    .trim();
}
