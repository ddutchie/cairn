"use client";

import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { Pin, PinOff, Calendar, Eye, Pencil, Wand2, Loader2, CheckCircle2, FileDown, ChevronLeft, Sparkles, Sun, Moon, ChevronDown as Chevron } from "lucide-react";import { WikilinkPicker } from "./WikilinkPicker";
import { getActiveWikilink } from "@/lib/wikilink-parser";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatRelative, urlTransform } from "@/lib/utils";
import { prepareNoteHtmlForPdf, pdfSafeTitle } from "./note-pdf-export";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { Note } from "@/types";
import { renderCodeFence } from "./markdown-code-fence";
import { TableOfContents, headingSlug } from "./TableOfContents";
import { findSectionTitleAtOffset, extractSectionTextAtOffset } from "./toc-utils";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { AITextToolbar, buildAIActionPrompt, applyFormat, type AITextAction, type FormatAction } from "./ai-text-toolbar";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor";
import { remarkCallout, remarkObsidianEmbeds, remarkWikilinks, remarkPromoteDisplayMath, makeLatexPlugins, InlineCode, rehypeEscapeUnknownTags } from "@/lib/markdown/pipeline";
import { BacklinksPanel, NoteTagBar } from "./BacklinksPanel";
import { MDPreviewPanel } from "./MDPreviewPanel";
import { countWords, stripMarkdown, toggleCheckboxInSource } from "./note-editor-utils";

interface NoteEditorProps {
  note: Note;
  onBack?: () => void;
}

type EditorMode = "write" | "read";

/**
 * Render a table cell's children, converting any leading `[ ]` / `[x]` token
 * into a clickable checkbox. GFM table cells only parse inline content, so
 * remark-gfm never emits checkbox nodes inside `<td>`/`<th>` — we recover them
 * here so table task-lists are interactive like list task-items.
 *
 * Only the first text child is inspected (the token must lead the cell, mirroring
 * GFM task-list semantics: `| [x] done | …`). Toggle wiring maps the rendered
 * checkbox back to source order via toggleCheckboxInSource().
 */
function renderCellWithCheckboxes(
  children: React.ReactNode,
  onToggle: (el: HTMLInputElement) => void
): React.ReactNode {
  const arr = React.Children.toArray(children);
  if (arr.length === 0) return children;

  const first = arr[0];
  if (typeof first !== "string") return children;

  const m = first.match(/^\s*\[([ xX])\]\s?/);
  if (!m) return children;

  const checked = m[1] !== " ";
  const rest = first.slice(m[0].length);
  return (
    <>
      <input
        type="checkbox"
        defaultChecked={checked}
        className="cursor-pointer accent-[var(--accent)] w-3.5 h-3.5 relative top-[1px] mr-1"
        onChange={(e) => onToggle(e.currentTarget)}
      />
      {rest}
      {arr.slice(1)}
    </>
  );
}

export function NoteEditor({ note, onBack }: NoteEditorProps) {
  const { updateNote, aiConfig, activeProjectId, getProjectColumns, tags, createTag, getTagById, activeWorkspaceId, setView, notes, projects } = useCairnStore(useShallow((s) => ({
    updateNote:        s.updateNote,
    aiConfig:          s.aiConfig,
    activeProjectId:   s.activeProjectId,
    getProjectColumns: s.getProjectColumns,
    tags:              s.tags,
    createTag:         s.createTag,
    getTagById:        s.getTagById,
    activeWorkspaceId: s.activeWorkspaceId,
    setView:           s.setView,
    notes:             s.notes,
    projects:          s.projects,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mode, setMode] = useState<EditorMode>("write");
  const noteContent0 = note.content ?? "";
  const [wordCount, setWordCount] = useState(() => countWords(noteContent0));
  const [showSemanticPanel, setShowSemanticPanel] = useState(false);
  const [activeSectionTitle, setActiveSectionTitle] = useState<string | null>(null);
  const [activeSectionText, setActiveSectionText] = useState<string | null>(null);
  const noteId = note.id;
  const [semanticContent, setSemanticContent] = useState(noteContent0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWordCount(countWords(noteContent0));
    setSemanticContent(noteContent0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // ── AI write lock ─────────────────────────────────────────────────────────
  // When the in-app AI or MCP server is actively writing this note, the editor
  // goes read-only and a non-blocking banner is shown.
  const [isAiWriting, setIsAiWriting] = useState(false);
  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;
    const offStarted = electron.onAiWriteStarted(({ noteId }) => {
      if (noteId === note.id) setIsAiWriting(true);
    });
    const offEnded = electron.onAiWriteEnded(({ noteId }) => {
      if (noteId === note.id) setIsAiWriting(false);
    });
    return () => { offStarted(); offEnded(); };
  }, [note.id]);

  // Spawn tasks state
  const [spawnLoading, setSpawnLoading] = useState(false);
  const [spawnResult, setSpawnResult] = useState<{ count: number } | null>(null);
  const [spawnToolCalls, setSpawnToolCalls] = useState<string[]>([]);

  // AI toolbar state
  const [aiLoading, setAiLoading] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const selectionRef = useRef<{ text: string } | null>(null);

  // MD preview panel state — selected text to render in the bottom panel
  const [previewText, setPreviewText] = useState<string | null>(null);

  // ── Wikilink picker state ──────────────────────────────────────────────────
  const [wikilinkPicker, setWikilinkPicker] = useState<{
    query: string;
    triggerFrom: number;
    anchorRect: { top: number; bottom: number; left: number };
  } | null>(null);

  // Scroll container ref — used by TableOfContents to scroll to headings
  const previewScrollRef = useRef<HTMLDivElement>(null);
  // Ref to the prose-cairn div — used by PDF export to capture rendered HTML
  const proseRef = useRef<HTMLDivElement>(null);

  // ── Math plugins (stable per note) ────────────────────────────────────────
  // makeLatexPlugins() creates a shared mutable latexBlocks array coupled
  // across the capture and merge passes. Re-create the pair on note change
  // so the array resets cleanly. The inline wrapper satisfies react-hooks/use-memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { rehypeCaptureLatex, rehypeMergedPass } = useMemo(() => makeLatexPlugins(), [note.id]);

  // ── Save ──────────────────────────────────────────────────────────────────
  // pendingContent tracks the latest unsaved markdown so the flush can write
  // it without a stale closure value.
  const pendingContent = useRef<{ noteId: string; markdown: string } | null>(null);
  const updateNoteRef = useRef(updateNote);
  // Keep the ref current without mutating it during render
  useEffect(() => { updateNoteRef.current = updateNote; });

  // Flush any pending debounced save immediately. Safe to call at any time.
  const flushPending = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingContent.current) {
      const { noteId, markdown } = pendingContent.current;
      pendingContent.current = null;
      updateNoteRef.current(noteId, {
        content: markdown,
        contentText: stripMarkdown(markdown),
      });
    }
  }, []);

  const handleContentChange = useCallback(
    (markdown: string) => {
      setWordCount(countWords(markdown));

      // Detect [[ wikilink trigger
      const view = editorRef.current?.getView();
      if (view) {
        const cursorPos = view.state.selection.main.head;
        const active = getActiveWikilink(markdown, cursorPos);
        if (active) {
          // Position the picker near the cursor
          const coords = view.coordsAtPos(cursorPos);
          if (coords) {
            setWikilinkPicker({
              query: active.query,
              triggerFrom: active.triggerFrom,
              anchorRect: { top: coords.top, bottom: coords.bottom, left: coords.left },
            });
          } else {
            setWikilinkPicker((prev) => prev ? { ...prev, query: active.query, triggerFrom: active.triggerFrom } : null);
          }
        } else {
          setWikilinkPicker(null);
        }
      }

      pendingContent.current = { noteId: note.id, markdown };
      setSemanticContent(markdown);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        pendingContent.current = null;
        updateNote(note.id, {
          content: markdown,
          contentText: stripMarkdown(markdown),
        });
      }, 300);
    },
    [note.id, updateNote]
  );

  // Flush on note change or unmount so switching notes never drops edits.
  useEffect(() => {
    return () => flushPending();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // Local title state so the input is responsive immediately — store update is debounced.
  // titleRef always holds the latest value so the debounce callback never captures a stale closure.
  const [localTitle, setLocalTitle] = useState(note.title);
  const titleRef = useRef(note.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local title when switching to a different note.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalTitle(note.title);
    titleRef.current = note.title;
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalTitle(value);
      titleRef.current = value;
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = setTimeout(() => {
        const t = titleRef.current.trim();
        if (!t) return; // never save an empty title
        updateNote(note.id, { title: t });
      }, 500);
    },
    [note.id, updateNote]
  );

  const handleTitleBlur = useCallback(() => {
    if (titleTimer.current) clearTimeout(titleTimer.current);
    const t = titleRef.current.trim();
    if (!t) {
      setLocalTitle(note.title);
      titleRef.current = note.title;
      return;
    }
    updateNote(note.id, { title: t });
  }, [note.id, note.title, updateNote]);

  const handleCursorActivity = useCallback(
    (offset: number) => {
      const title = titleRef.current;
      const content = editorRef.current?.getView()?.state.doc.toString() ?? "";
      const section = findSectionTitleAtOffset(title, content, offset);
      setActiveSectionTitle((prev) => (prev === section ? prev : section));
      const extracted = extractSectionTextAtOffset(title, content, offset);
      setActiveSectionText(extracted ? extracted.text : null);
    },
    []
  );

  // ── AI toolbar — driven by CodeMirror selection events ────────────────────
  const handleSelectionChange = useCallback(
    (sel: { text: string; coords: { top: number; left: number } } | null) => {
      if (!sel) {
        setHasSelection(false);
        setPreviewText(null);
        selectionRef.current = null;
        return;
      }
      selectionRef.current = { text: sel.text };
      setHasSelection(true);
      setPreviewText(sel.text);
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
        const result = await new Promise<{ content: string }>((resolve) => {
          const unsub = electron.chat.onDone((e) => { unsub(); resolve(e); });
          electron.chat.stream({
            message: prompt,
            threadId: "ai-text-action",
            config: { provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
          });
        });

        const replacement = result.content?.trim();
        if (!replacement) return;

        editorRef.current?.replaceSelection(replacement);
      } finally {
        setAiLoading(false);
        setPreviewText(null);
        selectionRef.current = null;
      }
    },
    [aiConfig.baseUrl, aiConfig.model, aiConfig.apiKey, aiConfig.provider]
  );

  // Insert [[Title]] replacing the typed `[[query` trigger text
  const handleWikilinkSelect = useCallback((title: string) => {
    const view = editorRef.current?.getView();
    if (!view || !wikilinkPicker) {
      setWikilinkPicker(null);
      return;
    }
    // Replace from the `[[` trigger start to the current cursor
    const from = wikilinkPicker.triggerFrom;
    const to = view.state.selection.main.head;
    const insert = `[[${title}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
    setWikilinkPicker(null);
  }, [wikilinkPicker]);

  // Toolbar button: open picker at cursor position without a `[[` trigger
  const openWikilinkPicker = useCallback(() => {
    const view = editorRef.current?.getView();
    if (!view) return;
    // Restore focus so coordsAtPos returns a real position (the formatting
    // toolbar uses onMouseDown+preventDefault which can shift focus away from CM).
    view.focus();
    const cursorPos = view.state.selection.main.head;
    const coords = view.coordsAtPos(cursorPos);
    // coords are already viewport-relative — pass them straight through.
    // If unavailable (cursor not visible), fall back to a mid-screen estimate.
    const anchorRect = coords
      ? { top: coords.top, bottom: coords.bottom, left: coords.left }
      : { top: window.innerHeight / 2, bottom: window.innerHeight / 2 + 20, left: window.innerWidth / 2 };
    setWikilinkPicker({ query: "", triggerFrom: cursorPos, anchorRect });
  }, []);

  const handleFormat = useCallback((action: FormatAction) => {
    // wikilink opens the picker rather than inserting markdown directly
    if (action === "wikilink") { openWikilinkPicker(); return; }
    const view = editorRef.current?.getView();
    if (!view) return;
    const range = applyFormat(view, action);
    if (range) {
      const newText = view.state.sliceDoc(range.from, range.to).trim();
      if (newText.length >= 3) setPreviewText(newText);
    }
  }, [openWikilinkPicker]);

  useEffect(() => {
    if (!spawnLoading) return;
    const electron = window.electron;
    if (!electron) return;
    const unsub = electron.chat.onToolCall((e) => {
      if (e.tool === "create_task") {
        setSpawnToolCalls((prev) => [...prev, e.label]);
      }
    });
    return () => { unsub(); };
  }, [spawnLoading]);

  const handleSpawnTasks = useCallback(async () => {
    const electron = window.electron;
    if (!electron || !activeProjectId) return;

    const projectColumns = getProjectColumns(activeProjectId);
    const backlogCol = projectColumns.find((c) => c.type === "backlog") ?? projectColumns[0];
    if (!backlogCol) return;

    setSpawnLoading(true);
    setSpawnResult(null);
    setSpawnToolCalls([]);
    try {
      const result = await new Promise<{ content: string }>((resolve) => {
        const unsub = electron.chat.onDone((e) => { unsub(); resolve(e); });
        electron.chat.stream({
          message: `Spawn tasks from the note with id="${note.id}" into column "${backlogCol.id}". Use the spawn_tasks_from_note tool.`,
          threadId: "spawn-tasks",
          projectId: activeProjectId,
          config: { provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
        });
      });

      // Try to parse task count from the tool result embedded in the response
      const match = result.content?.match(/(\d+)\s+task/i);
      const count = match ? parseInt(match[1], 10) : null;
      setSpawnResult({ count: count ?? 0 });
      setTimeout(() => setSpawnResult(null), 4000);
    } finally {
      setSpawnLoading(false);
    }
  }, [note.id, activeProjectId, getProjectColumns, aiConfig]);

  // ── Stable ReactMarkdown component overrides ──────────────────────────────
  // Toggle the Nth checkbox (document order) in the raw markdown source.
  // Shared by both list-item checkboxes and table-cell checkboxes so their
  // indices map to a single source-order scan. `el` is the clicked input;
  // its index among all `.prose-cairn` checkboxes equals the source index.
  const toggleCheckbox = useCallback((el: HTMLInputElement) => {
    const root = el.closest(".prose-cairn");
    if (!root) return;
    const checkboxes = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[type='checkbox']")
    );
    const idx = checkboxes.indexOf(el);
    if (idx === -1) return;
    const next = toggleCheckboxInSource(note.content ?? "", idx);
    if (next !== (note.content ?? "")) {
      // Keep contentText in sync with content (matching the save flow above) so
      // derived plain-text state doesn't go stale after a preview toggle.
      updateNote(note.id, { content: next, contentText: stripMarkdown(next) });
    }
  }, [note.id, note.content, updateNote]);

  // Extracted from JSX so ReactMarkdown receives a stable object reference
  // across renders. Only recreated when the note or updateNote changes.
  // previewScrollRef is a stable ref so it doesn't need to be in deps.
  const mdComponents = useMemo(() => ({
    // Images — renders asset:// and https:// URLs
    img({ src, alt }: { src?: string; alt?: string }) {
      const srcStr = typeof src === "string" && src !== "" ? src : undefined;
      const isExternal = srcStr?.startsWith("http://") || srcStr?.startsWith("https://");
      const imgEl = (
        <img
          src={srcStr}
          alt={alt ?? ""}
          referrerPolicy="no-referrer"
          className="max-w-full rounded-md my-2 border border-[var(--border)]"
        />
      );
      if (isExternal && srcStr) {
        const url = srcStr;
        return (
          <a
            href={url}
            onClick={(e) => {
              e.preventDefault();
              const el = (window as { electron?: { openExternal?: (u: string) => void } }).electron;
              if (el?.openExternal) el.openExternal(url);
              else window.open(url, "_blank");
            }}
            className="block"
          >
            {imgEl}
          </a>
        );
      }
      return imgEl;
    },
    mark({ children }: { children?: React.ReactNode }) {
      return (
        <mark className="rounded px-0.5" style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text-primary)" }}>
          {children}
        </mark>
      );
    },
    callout({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const p = props as Record<string, string>;
      return (
        <Callout
          type={p["data-callout-type"] ?? "note"}
          title={p["data-title"] || undefined}
          collapsible={p["data-collapsible"] === "true"}
          defaultOpen={p["data-default-open"] !== "false"}
        >
          {children}
        </Callout>
      );
    },
    mathblock({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const latex: string = (props as Record<string, string>)["data-latex"] ?? "";
      return <MathBlock key={latex} latex={latex} renderedChildren={children} />;
    },
    blockquote({ children }: { children?: React.ReactNode }) {
      return (
        <blockquote className="border-l-2 border-[var(--border)] pl-4 text-[var(--text-secondary)] my-3">
          {children}
        </blockquote>
      );
    },
    // Clickable checkboxes — toggle [ ] ↔ [x] in the raw markdown source
    input({ type, checked }: { type?: string; checked?: boolean }) {
      if (type !== "checkbox") return <input type={type} />;
      return (
        <input
          type="checkbox"
          defaultChecked={checked}
          className="cursor-pointer accent-[var(--accent)] w-3.5 h-3.5 relative top-[1px]"
          onChange={(e) => toggleCheckbox(e.currentTarget)}
        />
      );
    },
    pre({ children }: { children?: React.ReactNode }) {
      return renderCodeFence(children);
    },
    code({ className, children }: { className?: string; children?: React.ReactNode }) {
      return <InlineCode className={className}>{children}</InlineCode>;
    },
    h1({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h1 id={id} data-heading-id={id}>{children}</h1>;
    },
    h2({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h2 id={id} data-heading-id={id}>{children}</h2>;
    },
    h3({ children }: { children?: React.ReactNode }) {
      const text = String(children); const id = headingSlug(text);
      return <h3 id={id} data-heading-id={id}>{children}</h3>;
    },
    sup({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const isFootnoteRef = (props as Record<string, unknown>)["data-footnote-ref"] === true;
      if (!isFootnoteRef) return <sup>{children}</sup>;
      return (
        <sup className="text-[0.714rem] leading-none" style={{ color: "var(--accent)", fontFeatureSettings: "'sups' 0" }}>
          {children}
        </sup>
      );
    },
    a({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
      if (href?.startsWith("#")) {
        const isFootnoteRef = (props as Record<string, unknown>)["data-footnote-ref"] === true;
        const rawClassName: unknown = props.className;
        const isBackref = typeof rawClassName === "string"
          ? rawClassName.includes("data-footnote-backref")
          : Array.isArray(rawClassName) && rawClassName.includes("data-footnote-backref");
        return (
          <a
            {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            href={href}
            style={isFootnoteRef ? { color: "var(--accent)", textDecoration: "none" } : undefined}
            aria-label={isBackref ? "Back to reference" : undefined}
            onClick={(e) => {
              e.preventDefault();
              const rawId = href.slice(1);
              const container = previewScrollRef.current;
              if (!container) return;
              const target =
                container.querySelector(`[data-heading-id="${rawId}"]`) ??
                container.querySelector(`[id="${CSS.escape(rawId)}"]`);
              target?.scrollIntoView({ behavior: "smooth", block: isBackref ? "center" : "start" });
            }}
          >
            {children}
          </a>
        );
      }
      if (href) {
        const isExternal = /^(https?:|\/\/)/.test(href);
        if (isExternal) {
          return (
            <a
              {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                const el = (window as { electron?: { openExternal?: (u: string) => void } }).electron;
                if (el?.openExternal) el.openExternal(href);
                else window.open(href, "_blank");
              }}
            >
              {children}
            </a>
          );
        }
        const stripped = href.replace(/^\.?\//, "").replace(/\.md$/i, "").replace(/^[./]+/, "");
        const target = notes.find(
          (n) =>
            n.title.toLowerCase() === stripped.toLowerCase() ||
            n.title.toLowerCase() === stripped.replace(/[-_]/g, " ").toLowerCase() ||
            n.id === stripped,
        );
        return (
          <a
            {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            href={href}
            title={target ? `Open: ${target.title}` : href}
            style={target ? { color: "var(--accent)", textDecoration: "none" } : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (target) {
                window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: target.id } }));
              }
            }}
          >
            {children}
          </a>
        );
      }
      return <a href={href} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>;
    },
    section({ children, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      if ((props.className ?? "").includes("footnotes")) {
        return (
          <section {...props} className="footnotes mt-8 pt-4 text-[0.786rem] text-[var(--text-secondary)]" style={{ borderTop: "1px solid var(--border)" }}>
            {children}
          </section>
        );
      }
      return <section {...props}>{children}</section>;
    },
    wikilink({ ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
      const title = (props as Record<string, string>)["data-title"] ?? "";
      const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
      const resolved = target != null;
      return (
        <button
          type="button"
          onClick={() => {
            if (target) {
              window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: target.id } }));
            }
          }}
          title={resolved ? `Open: ${title}` : `Note not found: ${title}`}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[0.82em] font-medium transition-colors align-baseline",
            resolved
              ? "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] cursor-pointer"
              : "text-[var(--text-tertiary)] bg-[var(--surface-2)] cursor-default opacity-60"
          )}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          {resolved ? title : `${title} ↗`}
        </button>
      );
    },
    table({ children }: { children?: React.ReactNode }) {
      return (
        <div className="w-full overflow-x-auto my-3 scrollbar-thin">
          <table className="min-w-full border-collapse">
            {children}
          </table>
        </div>
      );
    },
    td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
      return <td style={style}>{renderCellWithCheckboxes(children, toggleCheckbox)}</td>;
    },
    th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
      return <th style={style}>{renderCellWithCheckboxes(children, toggleCheckbox)}</th>;
    },
  // previewScrollRef is a stable React ref — no need to list it as a dep
  // notes is needed for wikilink resolution; toggleCheckbox carries the
  // note id/content/updateNote closure for checkbox source-toggling.
  }), [notes, toggleCheckbox]) as import("react-markdown").Components;

  const handleToggleTag = useCallback((tagId: string) => {
    const has = note.tagIds.includes(tagId);
    updateNote(note.id, { tagIds: has ? note.tagIds.filter((id) => id !== tagId) : [...note.tagIds, tagId] });
  }, [note.id, note.tagIds, updateNote]);

  const handleCreateTag = useCallback((name: string) => {
    if (!activeWorkspaceId) return;
    const tag = createTag(activeWorkspaceId, name);
    updateNote(note.id, { tagIds: [...note.tagIds, tag.id] });
  }, [activeWorkspaceId, note.id, note.tagIds, createTag, updateNote]);

  const [exportState, setExportState] = useState<"idle" | "exporting" | "done">("idle");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const handleExportPdf = useCallback(async (theme: "light" | "dark" = "light") => {
    if (!proseRef.current) return;
    setShowExportMenu(false);
    setExportState("exporting");
    try {
      const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
      const isMobile = typeof window !== "undefined" && !!window.electron && !isElectron;

      const raw = proseRef.current.innerHTML;
      // Post-process HTML to make code blocks print-friendly (light-palette
      // remap + strip Copy button). See prepareNoteHtmlForPdf.
      const html = prepareNoteHtmlForPdf(raw, theme);

      if (isElectron && window.electron?.exportNotePdf) {
        await window.electron.exportNotePdf(note.title, html, { theme });
      } else if (isMobile && window.electron?.exportNotePdf) {
        const result = await window.electron.exportNotePdf(note.title, html, { returnBuffer: true, theme });
        if (result?.pdfBase64) {
          const binStr = atob(result.pdfBase64);
          const len = binStr.length;
          const arr = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
          }
          const blob = new Blob([arr], { type: "application/pdf" });
          const safeTitle = pdfSafeTitle(note.title);
          const file = new File([blob], `${safeTitle}.pdf`, { type: "application/pdf" });

          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
              files: [file],
              title: note.title,
            });
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${safeTitle}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
        }
      } else {
        // Fallback to native browser printing (which enables printing/PDF saving on mobile)
        window.print();
      }
      setExportState("done");
      setTimeout(() => setExportState("idle"), 2000);
    } catch (err) {
      console.error("PDF export failed:", err);
      setExportState("idle");
    }
  }, [note.title]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full overflow-hidden note-editor-print-container"
      onMouseDown={(e) => {
        // Dismiss preview when clicking outside the editor or docked panels
        const target = e.target as HTMLElement;
        if (!target.closest(".cm-editor") && !target.closest("[data-ai-toolbar]") && !target.closest("[data-md-preview-portal]")) {
          setPreviewText(null);
        }
        // Dismiss wikilink picker when clicking outside it
        if (!target.closest("[data-wikilink-picker]")) {
          setWikilinkPicker(null);
        }
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap md:flex-nowrap items-center justify-between gap-2.5 px-3 py-2.5 md:px-4 md:h-9 md:py-0 border-b border-[var(--border)] flex-shrink-0 w-full">
        <div className="flex items-center justify-between w-full md:w-auto gap-2">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="md:hidden gap-1.5 pl-1.5 pr-2.5 h-8 text-[var(--text-secondary)]"
            >
              <ChevronLeft size={14} />
              <span>Notes</span>
            </Button>
          )}

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
              onClick={() => { flushPending(); setMode("read"); }}
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
        </div>

        {/* Meta */}
        <div className="flex items-center gap-2 flex-wrap md:flex-nowrap">
          {aiEnabled && (spawnLoading ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
              <Loader2 size={11} className="animate-spin text-[var(--accent)] shrink-0" />
              <span className="text-[0.786rem] text-[var(--text-tertiary)]">
                {spawnToolCalls.length === 0
                  ? "Analysing…"
                  : spawnToolCalls[spawnToolCalls.length - 1].replace("Creating task ", "").replace(/^"|"$/g, "")}
              </span>
              {spawnToolCalls.length > 0 && (
                <span className="text-[0.714rem] text-[var(--accent)] font-medium">{spawnToolCalls.length}</span>
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
          ))}

          {mode === "read" && (
            <div className="relative">
              <Tooltip content="Export as PDF">
                <button
                  onClick={() => setShowExportMenu((v) => !v)}
                  disabled={exportState === "exporting"}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
                    exportState === "done"
                      ? "text-[var(--success)]"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                  )}
                >
                  {exportState === "exporting"
                    ? <Loader2 size={12} className="animate-spin" />
                    : exportState === "done"
                      ? <CheckCircle2 size={12} />
                      : <FileDown size={12} />}
                  {exportState === "done" ? "Saved" : "PDF"}
                  {exportState === "idle" && <Chevron size={10} className="opacity-60" />}
                </button>
              </Tooltip>
              {showExportMenu && exportState === "idle" && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 min-w-[120px] rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg overflow-hidden">
                    <button
                      onClick={() => handleExportPdf("light")}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                    >
                      <Sun size={12} /> Light
                    </button>
                    <button
                      onClick={() => handleExportPdf("dark")}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                    >
                      <Moon size={12} /> Dark
                    </button>
                  </div>
                </>
              )}
            </div>
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
          <Tooltip content={showSemanticPanel ? "Hide semantic hubs" : "Show semantic hubs (similar notes)"}>
            <button
              onClick={() => setShowSemanticPanel((v) => !v)}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                showSemanticPanel
                  ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              )}
            >
              <Sparkles size={13} />
            </button>
          </Tooltip>
          <span className="text-[0.786rem] text-[var(--text-tertiary)]">
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"} · {Math.max(1, Math.ceil(wordCount / 200))} min read
          </span>
          <span className="text-[0.786rem] text-[var(--text-tertiary)] flex items-center gap-1">
            <Calendar size={10} />
            {formatRelative(note.updatedAt)}
          </span>
        </div>
      </div>

      {/* ── Title ──────────────────────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-3 flex-shrink-0 border-b border-[var(--border)]">
        <input
          type="text"
          value={localTitle}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          placeholder="Note title"
          className="w-full bg-transparent text-2xl font-bold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none tracking-tight max-w-4xl mx-auto block"
        />
        {/* Tag bar */}
        <NoteTagBar
          note={note}
          workspaceTags={tags.filter((t) => t.workspaceId === activeWorkspaceId)}
          onToggleTag={handleToggleTag}
          onCreateTag={handleCreateTag}
          getTagById={getTagById}
        />
      </div>

      {/* ── AI + Format toolbar — write mode only ───────────────────────────── */}
      {mode === "write" && (
        <AITextToolbar
          onAction={handleAIAction}
          onFormat={handleFormat}
          loading={aiLoading}
          hasSelection={hasSelection}
          aiEnabled={aiEnabled}
          onDismiss={() => {
            setPreviewText(null);
            selectionRef.current = null;
          }}
        />
      )}

      {/* ── Editor / Preview + Semantic Hubs panel ───────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* AI write lock banner */}
        {isAiWriting && (
          <div
            className="absolute top-0 inset-x-0 z-10 flex items-center gap-2 px-4 py-1.5 text-xs"
            style={{
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              borderBottom: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
              color: "var(--accent)",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 animate-spin" style={{ animationDuration: "1.5s" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            AI is editing this note…
          </div>
        )}
        {/* CodeMirror — always mounted so state is preserved when toggling */}
        <div className={cn("absolute inset-0 overflow-auto", mode === "read" && "invisible pointer-events-none", isAiWriting && "pt-8")}>
          <MarkdownEditor
            key={note.id}
            ref={editorRef}
            initialValue={note.content ?? ""}
            onChange={handleContentChange}
            onSelectionChange={handleSelectionChange}
            onCursorActivity={handleCursorActivity}
            placeholder="Write here…"
            readOnly={isAiWriting}
          />
        </div>

        {/* Wikilink autocomplete picker — rendered in a portal at fixed viewport coords */}
        {wikilinkPicker && mode === "write" && (
          <WikilinkPicker
            notes={notes.filter((n) => n.id !== note.id)}
            projects={projects}
            query={wikilinkPicker.query}
            onSelect={handleWikilinkSelect}
            onClose={() => setWikilinkPicker(null)}
            anchorRect={wikilinkPicker.anchorRect}
          />
        )}

        {/* Read / preview pane */}
        {mode === "read" && (
          <div ref={previewScrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden">
            {/* TOC — floats to the right of the content column on wide viewports */}
            {note.content && (
              <TableOfContents
                markdown={note.content}
                scrollContainerRef={previewScrollRef}
                notes={notes}
              />
            )}
            <div className="px-6 py-5 max-w-4xl mx-auto">
              {note.content ? (
                <div className="prose-cairn" ref={proseRef}>
                   <ReactMarkdown
                     remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout, remarkObsidianEmbeds, remarkWikilinks]}
                      rehypePlugins={[rehypeRaw, rehypeEscapeUnknownTags, rehypeCaptureLatex, rehypeKatex, rehypeMergedPass]}
                     urlTransform={urlTransform}
                     components={mdComponents}
                   >
                    {note.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Eye size={20} className="text-[var(--text-tertiary)] opacity-40" />
                  <p className="text-sm text-[var(--text-tertiary)]">Nothing to preview yet.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      </div>

      {/* ── Backlinks panel ─────────────────────────────────────────────────── */}
      <BacklinksPanel
        note={note}
        onOpenCard={() => setView("board")}
        semanticEnabled={showSemanticPanel}
        semanticContent={semanticContent}
        activeSectionTitle={showSemanticPanel ? activeSectionTitle : null}
        activeSectionText={showSemanticPanel ? activeSectionText : null}
        workspaceId={activeWorkspaceId}
      />



      {/* ── MD preview panel — docked to bottom of editor ───────────────────── */}
      {previewText && (
        <MDPreviewPanel
          text={previewText}
          onDismiss={() => setPreviewText(null)}
        />
      )}
     </div>
   );
 }
