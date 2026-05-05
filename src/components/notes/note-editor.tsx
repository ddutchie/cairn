"use client";

import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Pin, PinOff, Calendar, Eye, Pencil, Wand2, Loader2, CheckCircle2, Tag, Plus, X, Link2, Kanban, ChevronDown, FileText } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatRelative } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import type { Note } from "@/types";
import { MermaidDiagram } from "./MermaidDiagram";
import { TableOfContents, headingSlug } from "./TableOfContents";
import { CodeBlock } from "./CodeBlock";
import { Callout } from "./Callout";
import { MathBlock } from "./MathBlock";
import { AITextToolbar, buildAIActionPrompt, applyFormat, type AITextAction, type FormatAction } from "./ai-text-toolbar";
import { MarkdownEditor, type MarkdownEditorHandle } from "./markdown-editor";
// ── Remark plugin: callout blockquotes ────────────────────────────────────────
// Transforms > [!type] blockquotes in the mdast by tagging the blockquote node
// with data.hName = "callout" and data.hProperties = { data-* }, so that
// remark-rehype renders it as <callout data-callout-type="note" ...>.
// ReactMarkdown's components map picks up "callout" and renders <Callout>.
import type { Plugin as RemarkPlugin } from "unified";
import type { Root as MdastRoot, Blockquote, Paragraph, Text as MdastText } from "mdast";
import type { InlineMath } from "mdast-util-math";
import { visit as mdastVisit } from "unist-util-visit";

const CALLOUT_RE = /^\[!([^\]]+)\]([\+\-]?)([\s\S]*)/;

const remarkCallout: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  mdastVisit(tree, "blockquote", (node: Blockquote) => {
    const firstPara = node.children[0];
    if (!firstPara || firstPara.type !== "paragraph") return;

    const firstChild = (firstPara as Paragraph).children[0];
    if (!firstChild || firstChild.type !== "text") return;

    const firstValue = (firstChild as MdastText).value;
    const match = firstValue.match(CALLOUT_RE);
    if (!match) return;

    const [, rawType, modifier, restOfFirstLine] = match;
    const calloutType = rawType.trim().toLowerCase();
    const collapsible = modifier === "+" || modifier === "-";
    const defaultOpen = modifier !== "-";
    const title = restOfFirstLine.trim();

    // Strip the "[!type]\n" prefix from the first text node so the body renders cleanly.
    const afterDirective = firstValue.slice(firstValue.indexOf("\n") + 1);
    (firstChild as MdastText).value = afterDirective;

    // Tag the blockquote node with hast properties so remark-rehype renders it
    // as <callout data-type="note" data-title="..." ...> which ReactMarkdown
    // maps to the callout() component via the components prop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).data = {
      hName: "callout",
      hProperties: {
        "data-callout-type": calloutType,
        "data-title": title,
        "data-collapsible": collapsible ? "true" : "false",
        "data-default-open": defaultOpen ? "true" : "false",
      },
    };
  });
};

// ── Remark plugin: promote standalone inlineMath to display math ──────────────
// remark-math parses $$...$$ on a single line as inlineMath (inside a paragraph).
// When an inlineMath node is the sole child of a paragraph we want it rendered
// as a display block (katex-display), not inline. Override hName/hProperties so
// remark-rehype emits <pre><code class="math-display"> which rehype-katex then
// renders as <span class="katex-display">.
const remarkPromoteDisplayMath: RemarkPlugin<[], MdastRoot> = () => (tree) => {
  mdastVisit(tree, "paragraph", (node: Paragraph) => {
    if (
      node.children.length === 1 &&
      node.children[0].type === "inlineMath"
    ) {
      const inlineMath = node.children[0] as InlineMath;
      inlineMath.data = {
        ...inlineMath.data,
        hName: "code",
        hProperties: { className: ["language-math", "math-display"] },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).data = { hName: "pre", hProperties: {} };
    }
  });
};

// ── Rehype plugins: math tagging + ==highlight== marks ───────────────────────
// All post-katex hast work is done in two plugins to minimise full-tree traversals.
//
// rehypeCaptureLatex  (runs BEFORE rehype-katex)
//   Reads raw LaTeX from <code class="math-display"> nodes (emitted by remark-rehype
//   for both single-line and multi-line $$ blocks) into a shared array before
//   rehype-katex replaces them with rendered <span class="katex-display"> output.
//
// rehypeMergedPass  (runs AFTER rehype-katex) — single traversal for two jobs:
//   1. Rename <span class="katex-display"> → <mathblock data-latex="..."> so
//      ReactMarkdown routes it to components.mathblock (same hName trick as callouts).
//      Uses SKIP to avoid descending into the ~80-node KaTeX subtrees.
//   2. Convert ==text== marks → <mark> elements (previously a separate pass).
//
// Merging into one post-katex traversal saves a full walk of the ~5000-node hast.
import type { Plugin } from "unified";
import type { Root, Element, Text, ElementContent, Parent } from "hast";
import { visit, SKIP } from "unist-util-visit";

function makeLatexPlugins() {
  const latexBlocks: string[] = [];

  const rehypeCaptureLatex: Plugin<[], Root> = () => (tree) => {
    latexBlocks.length = 0;
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("math-display")) {
        const text = (node.children[0] as Text | undefined)?.value ?? "";
        latexBlocks.push(text);
      }
    });
  };

  const rehypeMergedPass: Plugin<[], Root> = () => (tree) => {
    let i = 0;
    visit(tree, (node, index, parent) => {
      // ── Job 1: rename katex-display spans to <mathblock> ──────────────────
      if (node.type === "element") {
        const cls = ((node as Element).properties?.className as string[] | undefined) ?? [];
        if (cls.includes("katex-display")) {
          if (latexBlocks[i] !== undefined) {
            (node as Element).tagName = "mathblock";
            (node as Element).properties = { "data-latex": latexBlocks[i++] };
          }
          // Skip the entire KaTeX subtree — it contains no ==marks== and
          // we've already handled this katex-display node.
          return SKIP;
        }
      }

      // ── Job 2: ==highlight== marks → <mark> elements ──────────────────────
      if (
        node.type === "text" &&
        (node as Text).value.includes("==") &&
        parent &&
        index !== undefined
      ) {
        const text = (node as Text).value;
        const parts = text.split(/(==.+?==)/g);
        if (parts.length > 1) {
          const nodes: ElementContent[] = parts
            .map((part): ElementContent | null => {
              if (part.startsWith("==") && part.endsWith("==") && part.length > 4) {
                const mark: Element = {
                  type: "element",
                  tagName: "mark",
                  properties: {},
                  children: [{ type: "text", value: part.slice(2, -2) }],
                };
                return mark;
              }
              if (part === "") return null;
              return { type: "text", value: part } as Text;
            })
            .filter((n): n is ElementContent => n !== null);
          (parent as Parent).children.splice(index, 1, ...nodes);
          return index; // revisit from same position after splice
        }
      }
    });
  };

  return { rehypeCaptureLatex, rehypeMergedPass };
}



// ── Color swatch inline code renderer ────────────────────────────────────────
// Detects hex / rgb / rgba / hsl / hsla values inside inline code spans and
// renders a small color swatch dot next to the code text.

const COLOR_RE = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?)\s*\([^)]+\))$/i;

function InlineCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  if (className?.startsWith("language-")) return <>{children}</>;
  const text = String(children ?? "").trim();
  const isColor = COLOR_RE.test(text);
  return (
    <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.786rem] text-[var(--text-primary)]">
      {isColor && (
        <span
          style={{
            display: "inline-block",
            width: "0.7em",
            height: "0.7em",
            borderRadius: "50%",
            background: text,
            border: "1px solid color-mix(in srgb, var(--text-primary) 20%, transparent)",
            marginRight: "0.35em",
            verticalAlign: "middle",
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </code>
  );
}

// ── MD Preview Panel ──────────────────────────────────────────────────────────
// Docked to the bottom of the editor. Renders selected raw markdown through
// the full pipeline and displays it as a collapsible bottom panel.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PREVIEW_REMARK_PLUGINS: any[] = [remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout];

interface MDPreviewPanelProps {
  text: string;
  onDismiss: () => void;
}

function MDPreviewPanel({ text, onDismiss }: MDPreviewPanelProps) {
  // Each panel instance gets its own latex plugin pair so the mutable capture
  // array is isolated — safe because the panel remounts when text changes.
  const { rehypeCaptureLatex: previewCapture, rehypeMergedPass: previewMerge } = useMemo(() => makeLatexPlugins(), []);

  // Dismiss on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onDismiss(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      data-md-preview-portal
      className="flex-shrink-0 border-t border-[var(--border)] animate-fade-in"
      style={{ background: "var(--surface)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--surface-2)" }}>
        <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">Preview</span>
        <button
          onClick={onDismiss}
          className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
        >
          <X size={11} />
        </button>
      </div>
      {/* Rendered markdown — capped at ~30vh so it never swamps the editor */}
      <div className="prose-cairn px-6 py-4 overflow-y-auto" style={{ maxHeight: "30vh" }}>
        <ReactMarkdown
          remarkPlugins={PREVIEW_REMARK_PLUGINS}
          rehypePlugins={[previewCapture, rehypeKatex, previewMerge]}
          urlTransform={(url) => url.startsWith("asset://") ? url : defaultUrlTransform(url)}
          components={({
            mark({ children }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
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
              const p = props as Record<string, string>;
              return <MathBlock renderedChildren={children} latex={p["data-latex"] ?? ""} />;
            },
            pre({ children }: React.HTMLAttributes<HTMLPreElement> & ExtraProps) {
              const child = Array.isArray(children) ? children[0] : children;
              const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
              const className = code?.props?.className ?? "";
              const lang = className.replace("language-", "") || undefined;
              const content = String(code?.props?.children ?? "").replace(/\n$/, "");
              return <CodeBlock code={content} language={lang} />;
            },
            code({ children, className }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
              return <InlineCode className={className}>{children}</InlineCode>;
            },
          } as import("react-markdown").Components)}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}





interface NoteEditorProps {
  note: Note;
}

type EditorMode = "write" | "read";

export function NoteEditor({ note }: NoteEditorProps) {
  const { updateNote, aiConfig, activeProjectId, getProjectColumns, tags, createTag, getTagById, activeWorkspaceId, setView } = useCairnStore(useShallow((s) => ({
    updateNote:        s.updateNote,
    aiConfig:          s.aiConfig,
    activeProjectId:   s.activeProjectId,
    getProjectColumns: s.getProjectColumns,
    tags:              s.tags,
    createTag:         s.createTag,
    getTagById:        s.getTagById,
    activeWorkspaceId: s.activeWorkspaceId,
    setView:           s.setView,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;
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
  const [aiLoading, setAiLoading] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const selectionRef = useRef<{ text: string } | null>(null);

  // MD preview panel state — selected text to render in the bottom panel
  const [previewText, setPreviewText] = useState<string | null>(null);

  // Scroll container ref — used by TableOfContents to scroll to headings
  const previewScrollRef = useRef<HTMLDivElement>(null);

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
      pendingContent.current = { noteId: note.id, markdown };
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
      // Revert to last saved title if field is left empty
      setLocalTitle(note.title);
      titleRef.current = note.title;
      return;
    }
    updateNote(note.id, { title: t });
  }, [note.id, note.title, updateNote]);

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
            config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
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
    [aiConfig.baseUrl, aiConfig.model, aiConfig.apiKey]
  );

  const handleFormat = useCallback((action: FormatAction) => {
    const view = editorRef.current?.getView();
    if (!view) return;
    const range = applyFormat(view, action);
    if (range) {
      const newText = view.state.sliceDoc(range.from, range.to).trim();
      if (newText.length >= 3) setPreviewText(newText);
    }
  }, []);

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
          config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
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
          onChange={(e) => {
            const checkboxes = Array.from(
              e.currentTarget.closest(".prose-cairn")!
                .querySelectorAll<HTMLInputElement>("input[type='checkbox']")
            );
            const idx = checkboxes.indexOf(e.currentTarget);
            if (idx === -1) return;
            const lines = (note.content ?? "").split("\n");
            let found = 0;
            const next = lines.map((line) => {
              if (/^(\s*[-*+]\s+)\[([ xX])\]/.test(line)) {
                if (found === idx) { found++; return line.replace(/\[([ xX])\]/, e.currentTarget.checked ? "[x]" : "[ ]"); }
                found++;
              }
              return line;
            }).join("\n");
            updateNote(note.id, { content: next });
          }}
        />
      );
    },
    pre({ children }: { children?: React.ReactNode }) {
      const child = Array.isArray(children) ? children[0] : children;
      const code = child as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      const className = code?.props?.className ?? "";
      const lang = className.replace("language-", "") || undefined;
      const content = String(code?.props?.children ?? "").replace(/\n$/, "");
      if (lang === "mermaid") return <MermaidDiagram chart={content} />;
      return <CodeBlock code={content} language={lang} />;
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
  // previewScrollRef is a stable React ref — no need to list it as a dep
  }), [note.id, note.content, updateNote]) as import("react-markdown").Components;

  const handleToggleTag = useCallback((tagId: string) => {
    const has = note.tagIds.includes(tagId);
    updateNote(note.id, { tagIds: has ? note.tagIds.filter((id) => id !== tagId) : [...note.tagIds, tagId] });
  }, [note.id, note.tagIds, updateNote]);

  const handleCreateTag = useCallback((name: string) => {
    if (!activeWorkspaceId) return;
    const tag = createTag(activeWorkspaceId, name);
    updateNote(note.id, { tagIds: [...note.tagIds, tag.id] });
  }, [activeWorkspaceId, note.id, note.tagIds, createTag, updateNote]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full overflow-hidden"
      onMouseDown={(e) => {
        // Dismiss preview when clicking outside the editor or docked panels
        const target = e.target as HTMLElement;
        if (!target.closest(".cm-editor") && !target.closest("[data-ai-toolbar]") && !target.closest("[data-md-preview-portal]")) {
          setPreviewText(null);
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

        {/* Meta */}
        <div className="flex items-center gap-2">
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
          <div ref={previewScrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden">
            {/* TOC — floats to the right of the content column on wide viewports */}
            {note.content && (
              <TableOfContents
                markdown={note.content}
                scrollContainerRef={previewScrollRef}
              />
            )}
            <div className="px-6 py-5 max-w-4xl mx-auto">
              {note.content ? (
                <div className="prose-cairn">
                  <ReactMarkdown
                     remarkPlugins={[remarkGfm, remarkBreaks, remarkMath, remarkPromoteDisplayMath, remarkCallout]}
                     rehypePlugins={[rehypeCaptureLatex, rehypeKatex, rehypeMergedPass]}
                     urlTransform={(url) => url.startsWith("asset://") ? url : defaultUrlTransform(url)}
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

      {/* ── Backlinks panel ─────────────────────────────────────────────────── */}
      <BacklinksPanel note={note} onOpenCard={() => setView("board")} />



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

// ── Backlinks Panel ───────────────────────────────────────────────────────────

interface BacklinksPanelProps {
  note: Note;
  onOpenCard: () => void;
}

function BacklinksPanel({ note, onOpenCard }: BacklinksPanelProps) {
  const { notes, cards, columns } = useCairnStore(useShallow((s) => ({
    notes:   s.notes,
    cards:   s.cards,
    columns: s.columns,
  })));
  const [open, setOpen] = useState(false);

  const linkedNotes = useMemo(
    () => (note.linkedNoteIds ?? []).map((id) => notes.find((n) => n.id === id)).filter(Boolean) as import("@/types").Note[],
    [note.linkedNoteIds, notes],
  );
  const linkedCards = useMemo(
    () => (note.linkedCardIds ?? []).map((id) => cards.find((c) => c.id === id)).filter(Boolean) as import("@/types").TaskCard[],
    [note.linkedCardIds, cards],
  );

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
            <button
              key={n.id}
              onClick={() => window.dispatchEvent(new CustomEvent("cairn:select-note", { detail: { noteId: n.id } }))}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] text-xs text-[var(--text-secondary)] transition-colors text-left"
            >
              <FileText size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <span className="truncate flex-1">{n.title}</span>
              <span className="text-[0.714rem] text-[var(--text-tertiary)]">note</span>
            </button>
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
                <span className="text-[0.714rem] text-[var(--text-tertiary)]">{col?.name ?? "card"}</span>
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
      if (pickerRef.current && !pickerRef.current.contains(e.target as globalThis.Node)) {
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
    <div className="flex items-center gap-1.5 mt-2.5 max-w-4xl mx-auto flex-wrap relative">
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
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] border border-dashed border-[var(--border)] transition-colors"
        >
          <Tag size={11} />
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
              className="w-full px-2 py-1 text-xs rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)] mb-2"
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
                <p className="text-[0.786rem] text-[var(--text-tertiary)] px-2 py-1">No tags yet</p>
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
