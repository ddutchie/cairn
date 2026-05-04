"use client";

/**
 * AgentEditor — multi-file tabbed editor for the Agent view centre pane.
 *
 * - One CM6 instance per open file, CSS-hidden when not active (preserves state).
 * - Syntax highlighting via HighlightStyle matched to CodeBlock.tsx palette.
 * - .md files get a Preview toggle that renders via NoteMarkdownPreview.
 * - Cmd/Ctrl+S saves the active file.
 * - Dirty dot per tab.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { X, Save, FileCode, Eye, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { Tooltip } from "@/components/ui/tooltip";

// ── Syntax highlight style (mirrors CodeBlock.tsx dark/light palettes) ────────

function buildHighlightStyle(isDark: boolean) {
  return syntaxHighlighting(
    HighlightStyle.define(
      isDark ? [
        { tag: [tags.keyword, tags.modifier],                    color: "#c678dd" },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#61afef" },
        { tag: [tags.definitionKeyword, tags.moduleKeyword],     color: "#c678dd" },
        { tag: [tags.typeName, tags.className, tags.typeOperator], color: "#e5c07b" },
        { tag: [tags.string, tags.special(tags.string)],         color: "#98c379" },

        { tag: [tags.number, tags.integer, tags.float],          color: "#d19a66" },
        { tag: [tags.bool, tags.null],                           color: "#56b6c2" },
        { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#5c6370", fontStyle: "italic" },
        { tag: tags.variableName,                                color: "#e06c75" },
        { tag: tags.propertyName,                                color: "#e06c75" },
        { tag: [tags.operator, tags.punctuation],                color: "#abb2bf" },
        { tag: [tags.tagName, tags.angleBracket],                color: "#e06c75" },
        { tag: tags.attributeName,                               color: "#d19a66" },
        { tag: tags.attributeValue,                              color: "#98c379" },
        { tag: [tags.meta, tags.processingInstruction],          color: "#61afef" },
        { tag: tags.regexp,                                      color: "#e06c75" },
      ] : [
        { tag: [tags.keyword, tags.modifier],                    color: "#7c3aed" },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#1d4ed8" },
        { tag: [tags.definitionKeyword, tags.moduleKeyword],     color: "#7c3aed" },
        { tag: [tags.typeName, tags.className, tags.typeOperator], color: "#b45309" },
        { tag: [tags.string, tags.special(tags.string)],         color: "#16a34a" },

        { tag: [tags.number, tags.integer, tags.float],          color: "#c2410c" },
        { tag: [tags.bool, tags.null],                           color: "#0891b2" },
        { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#9ca3af", fontStyle: "italic" },
        { tag: tags.variableName,                                color: "#dc2626" },
        { tag: tags.propertyName,                                color: "#dc2626" },
        { tag: [tags.operator, tags.punctuation],                color: "#374151" },
        { tag: [tags.tagName, tags.angleBracket],                color: "#dc2626" },
        { tag: tags.attributeName,                               color: "#1d4ed8" },
        { tag: tags.attributeValue,                              color: "#16a34a" },
        { tag: [tags.meta, tags.processingInstruction],          color: "#1d4ed8" },
        { tag: tags.regexp,                                      color: "#dc2626" },
      ]
    )
  );
}

// ── CM6 base theme ────────────────────────────────────────────────────────────

function buildTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "0.875rem",
      fontFamily: "var(--font-mono, ui-monospace, 'Cascadia Code', monospace)",
      background: "var(--background)",
      color: "var(--text-primary)",
    },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "auto", padding: "16px" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "var(--accent-dim) !important" },
    "&.cm-focused .cm-selectionBackground": { background: "var(--accent-dim) !important" },
    ".cm-gutters": {
      background: "var(--surface)",
      borderRight: "1px solid var(--border-subtle)",
      color: "var(--text-tertiary)",
      minWidth: "2.5rem",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--accent) 5%, transparent)" },
    ".cm-activeLineGutter": { background: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  });
}

// ── AgentEditor ───────────────────────────────────────────────────────────────

export function AgentEditor() {
  const { openEditorFiles, activeEditorFile, closeEditorFile, setActiveEditorFile } = useCairnStore();

  // Dirty state per file path
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  // Saving state per file
  const [savingFiles, setSavingFiles] = useState<Set<string>>(new Set());
  // Preview mode (md files only) per file
  const [previewFiles, setPreviewFiles] = useState<Set<string>>(new Set());
  // Preview content cache: path → content string
  const [previewContent, setPreviewContent] = useState<Record<string, string>>({});

  const isDark =
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme") !== "light"
      : true;

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      dirty ? next.add(path) : next.delete(path);
      return next;
    });
  }, []);

  const handleSave = useCallback(async (path: string, content: string) => {
    if (!window.electron) return;
    setSavingFiles((prev) => new Set(prev).add(path));
    try {
      await window.electron.agent.writeFile(path, content);
      handleDirtyChange(path, false);
      // Refresh preview content if in preview mode
      setPreviewContent((prev) => ({ ...prev, [path]: content }));
    } finally {
      setSavingFiles((prev) => { const n = new Set(prev); n.delete(path); return n; });
    }
  }, [handleDirtyChange]);

  const togglePreview = useCallback(async (path: string) => {
    setPreviewFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) { next.delete(path); return next; }
      next.add(path);
      return next;
    });
    // Load current content for preview if not cached
    if (!previewContent[path] && window.electron) {
      const result = await window.electron.agent.readFile(path) as { data?: string } | undefined;
      const content = result?.data ?? "";
      setPreviewContent((prev) => ({ ...prev, [path]: content }));
    }
  }, [previewContent]);

  const handleClose = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    closeEditorFile(path);
    setDirtyFiles((prev) => { const n = new Set(prev); n.delete(path); return n; });
    setPreviewFiles((prev) => { const n = new Set(prev); n.delete(path); return n; });
    setPreviewContent((prev) => { const n = { ...prev }; delete n[path]; return n; });
  }, [closeEditorFile]);

  // ── Empty state ──────────────────────────────────────────────────────────
  if (openEditorFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center p-8">
        <FileCode size={28} className="text-[var(--text-tertiary)]" />
        <p className="text-sm text-[var(--text-tertiary)]">Select a file to edit</p>
        <p className="text-xs text-[var(--text-tertiary)]">Click a file in the tree on the left</p>
      </div>
    );
  }

  const activeFile = activeEditorFile ?? openEditorFiles[0];
  const isMarkdown = (p: string) => p.endsWith(".md") || p.endsWith(".mdx");
  const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i.test(p);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      {/* Tab strip */}
      <div className="flex items-stretch gap-0 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-x-auto overflow-y-hidden">
        {openEditorFiles.map((filePath) => {
          const name = filePath.split("/").pop() ?? filePath;
          const isActive = filePath === activeFile;
          const isDirty = dirtyFiles.has(filePath);
          const isSaving = savingFiles.has(filePath);
          const inPreview = previewFiles.has(filePath);

          return (
            <div
              key={filePath}
              onClick={() => setActiveEditorFile(filePath)}
              title={filePath}
              className={cn(
                "group flex items-center gap-1.5 px-3 py-1.5 text-[0.714rem] cursor-pointer select-none flex-shrink-0 border-r border-[var(--border)] transition-colors",
                isActive
                  ? "bg-[var(--background)] text-[var(--text-primary)] border-b-2 border-b-[var(--accent)]"
                  : "bg-[var(--surface)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              )}
            >
              {isImage(filePath) && <ImageIcon size={10} className="flex-shrink-0 text-[var(--text-tertiary)]" />}
              <span className="max-w-[120px] truncate">{name}</span>
              {!isImage(filePath) && (isDirty || isSaving) && (
                <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", isSaving ? "bg-[var(--text-tertiary)]" : "bg-[var(--accent)]")} />
              )}
              {/* Preview toggle for md files */}
              {isActive && isMarkdown(filePath) && (
                <Tooltip content={inPreview ? "Edit" : "Preview"} side="bottom">
                  <button
                    onClick={(e) => { e.stopPropagation(); togglePreview(filePath); }}
                    className={cn(
                      "p-0.5 rounded transition-colors",
                      inPreview
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] opacity-0 group-hover:opacity-100"
                    )}
                  >
                    <Eye size={10} />
                  </button>
                </Tooltip>
              )}
              <Tooltip content="Close" side="bottom">
                <button
                  onClick={(e) => handleClose(e, filePath)}
                  className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={10} />
                </button>
              </Tooltip>
            </div>
          );
        })}

        {/* Save button for active file */}
        <div className="ml-auto flex items-center px-2 flex-shrink-0">
          {dirtyFiles.has(activeFile) && (
            <Tooltip content="Save (⌘S)" side="bottom">
              <button
                onClick={() => {
                  document.dispatchEvent(new CustomEvent("agent-editor-save", { detail: activeFile }));
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.714rem] text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors"
              >
                <Save size={11} />
                {savingFiles.has(activeFile) ? "Saving…" : "Save"}
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Editor instances — one per file, CSS-hidden when inactive */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {openEditorFiles.map((filePath) => {
          const isActive = filePath === activeFile;
          const inPreview = previewFiles.has(filePath);

          return (
            <div key={filePath} className={cn("absolute inset-0", !isActive && "hidden")}>
              {/* Image viewer — replaces CM6 for binary image files */}
              {isImage(filePath) ? (
                <ImageViewer filePath={filePath} />
              
              ) : (
                <>
                  {/* CM6 editor — hidden (not unmounted) when preview is active */}
                  <div className={cn("absolute inset-0", inPreview && "hidden")}>
                    <FileEditorInner
                      filePath={filePath}
                      isActive={isActive && !inPreview}
                      isDark={isDark}
                      onDirtyChange={handleDirtyChange}
                      onSave={handleSave}
                    />
                  </div>
                  {/* Markdown preview */}
                  {inPreview && (
                    <div className="absolute inset-0 overflow-y-auto">
                      <NoteMarkdownPreview content={previewContent[filePath] ?? ""} />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── FileEditorInner — wires the save custom event ─────────────────────────────

interface FileEditorInnerProps {
  filePath: string;
  isActive: boolean;
  isDark: boolean;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onSave: (path: string, content: string) => void;
}

function FileEditorInner({ filePath, isActive, isDark, onDirtyChange, onSave }: FileEditorInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pathRef = useRef(filePath);
  pathRef.current = filePath;

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!window.electron) return;

    window.electron.agent.readFile(filePath)
      .then(async (result: unknown) => {
        const r = result as { data?: string; error?: string };
        if (r && "error" in r) { setLoadError((r as { error: string }).error); return; }
        const content = (r as { data: string })?.data ?? "";

        const lang = await LanguageDescription.matchFilename(languages, filePath)
          ?.load().catch(() => null);

        const state = EditorState.create({
          doc: content,
            extensions: [
            buildTheme(),
            buildHighlightStyle(isDark),
            lineNumbers(),
            history(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              {
                key: "Mod-s",
                run: (view) => {
                  onSaveRef.current(pathRef.current, view.state.doc.toString());
                  return true;
                },
              },
            ]),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) onDirtyChange(pathRef.current, true);
            }),
            ...(lang ? [lang] : []),
          ],
        });

        viewRef.current?.destroy();
        if (containerRef.current) {
          viewRef.current = new EditorView({ state, parent: containerRef.current });
        }
      })
      .catch((e: unknown) => setLoadError(String(e)));

    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isDark]);

  // Focus when active
  useEffect(() => {
    if (isActive) viewRef.current?.focus();
  }, [isActive]);

  // Save button via custom event
  useEffect(() => {
    function handler(e: Event) {
      const path = (e as CustomEvent<string>).detail;
      if (path !== filePath) return;
      const content = viewRef.current?.state.doc.toString() ?? "";
      onSaveRef.current(filePath, content);
    }
    document.addEventListener("agent-editor-save", handler);
    return () => document.removeEventListener("agent-editor-save", handler);
  }, [filePath]);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {loadError && (
        <div className="px-4 py-2 text-xs text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] flex-shrink-0">
          {loadError}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}

// ── ImageViewer — loads via base64 IPC to avoid file:// CSP restrictions ──────

function ImageViewer({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    setError(null);
    if (!window.electron) return;
    (window.electron.agent.readFileBase64(filePath) as Promise<{ data?: string; error?: string }>)
      .then((result) => {
        const r = result as { data?: string; error?: string };
        if (r?.error) setError(r.error);
        else setSrc(r?.data ?? null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [filePath]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--background)] overflow-auto p-4">
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={filePath.split("/").pop()}
          className="max-w-full max-h-full object-contain rounded"
        />
      )}
      {!src && !error && <p className="text-xs text-[var(--text-tertiary)]">Loading…</p>}
      <p className="text-[0.714rem] text-[var(--text-tertiary)] font-mono">{filePath.split("/").pop()}</p>
    </div>
  );
}
