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

import { useState, useCallback } from "react";
import { X, Save, FileCode, Eye, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsDark } from "@/hooks/useIsDark";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";
import { Tooltip } from "@/components/ui/tooltip";
import { FileEditorInner } from "./FileEditorInner";
import { ImageViewer } from "./ImageViewer";

// ── AgentEditor ───────────────────────────────────────────────────────────────

export function AgentEditor() {
  const { openEditorFiles, activeEditorFile, closeEditorFile, setActiveEditorFile, activeProjectId, projects } = useCairnStore(useShallow((s) => ({
    openEditorFiles: s.openEditorFiles,
    activeEditorFile: s.activeEditorFile,
    closeEditorFile: s.closeEditorFile,
    setActiveEditorFile: s.setActiveEditorFile,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
  })));

  // Dirty state per file path
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  // Saving state per file
  const [savingFiles, setSavingFiles] = useState<Set<string>>(new Set());
  // Preview mode (md files only) per file
  const [previewFiles, setPreviewFiles] = useState<Set<string>>(new Set());
  // Preview content cache: path → content string
  const [previewContent, setPreviewContent] = useState<Record<string, string>>({});

  const isDark = useIsDark();

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (dirty) { next.add(path); } else { next.delete(path); }
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
      const content = await window.electron.agent.readFile(path) as string;
      setPreviewContent((prev) => ({ ...prev, [path]: content ?? "" }));
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

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectRoot = activeProject?.codeDirectory ?? undefined;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      {/* Tab strip */}
      <div className="flex items-stretch gap-0 h-9 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-x-auto overflow-y-hidden">
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
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  handleClose(e, filePath);
                }
              }}
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
                      <NoteMarkdownPreview
                        content={previewContent[filePath] ?? ""}
                        filePath={filePath}
                        projectRoot={projectRoot}
                      />
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


