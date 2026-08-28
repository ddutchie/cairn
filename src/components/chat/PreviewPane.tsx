"use client";

import React, { useRef, useEffect, useState } from "react";
import { X, ExternalLink, FileText, Kanban, Code2, GitBranch } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { NoteEditor } from "@/components/notes/note-editor";
import { CardDetailPanel } from "@/components/kanban/card-detail-panel";
import { revealNote, revealCard } from "@/lib/events";
import { Button } from "@/components/ui/button";
import type { ContextPanel } from "@/types";

const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 900;
const DEFAULT_PREVIEW_WIDTH = 550;

function FileContextContent({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.electron?.agent.readFile(path).then((value) => {
      if (!cancelled) setContent(value as string);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [path]);
  if (error) return <div className="flex items-center justify-center flex-1 p-6 text-center text-xs text-[var(--danger)]">Unable to read file: {error}</div>;
  if (content === null) return <div className="flex items-center justify-center flex-1 text-xs text-[var(--text-tertiary)]">Loading file…</div>;
  return <pre className="flex-1 overflow-auto p-4 text-[0.714rem] leading-5 font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words">{content}</pre>;
}

function DiffContextContent({ path }: { path?: string }) {
  const project = useCairnStore((state) => state.projects.find((candidate) => candidate.id === state.activeProjectId));
  const [result, setResult] = useState<{ stat: { added: number; deleted: number }; diff: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!project?.codeDirectory || !window.electron?.git) return;
    const request = path
      ? window.electron.git.diffFile(project.codeDirectory, path)
      : window.electron.git.diff(project.codeDirectory).then((diff) => ({ stat: { added: 0, deleted: 0 }, diff }));
    request.then((value) => { if (!cancelled) setResult(value); }).catch(() => { if (!cancelled) setResult({ stat: { added: 0, deleted: 0 }, diff: "Unable to load diff." }); });
    return () => { cancelled = true; };
  }, [path, project?.codeDirectory]);
  if (!project?.codeDirectory) return <div className="flex items-center justify-center flex-1 p-6 text-center text-xs text-[var(--text-tertiary)]">No code directory connected.</div>;
  if (!result) return <div className="flex items-center justify-center flex-1 text-xs text-[var(--text-tertiary)]">Loading diff…</div>;
  return <pre className="flex-1 overflow-auto p-4 text-[0.714rem] leading-5 font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words">{result.diff || "No changes."}</pre>;
}

export function PreviewPane() {
  const { activePreviewItem, activeContextPanel, setActivePreviewItem, setActiveContextPanel, setView, openEditorFile, notes, cards } = useCairnStore(useShallow((s) => ({
    activePreviewItem: s.activePreviewItem,
    activeContextPanel: s.activeContextPanel,
    setActivePreviewItem: s.setActivePreviewItem,
    setActiveContextPanel: s.setActiveContextPanel,
    setView: s.setView,
    openEditorFile: s.openEditorFile,
    notes: s.notes,
    cards: s.cards,
  })));

  const [panelWidth, setPanelWidth] = useState(DEFAULT_PREVIEW_WIDTH);
  const panelRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const divider = dividerRef.current;
    const panel = panelRef.current;
    if (!divider || !panel) return;

    let dragging = false;
    let startX = 0;
    let startW = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      // Panel is on the right; dragging left (lower clientX) makes it wider
      const next = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, startW - (e.clientX - startX)));
      setPanelWidth(next);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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
  }, [activePreviewItem, activeContextPanel]);

  const panel = (activeContextPanel ?? activePreviewItem) as ContextPanel | null;
  if (!panel) return null;

  const { type } = panel;
  const id = "id" in panel ? panel.id : undefined;
  const note = type === "note" ? notes.find((n) => n.id === id) : null;
  const card = type === "task" ? cards.find((c) => c.id === id) : null;

  function handleGoToSection() {
    if (type === "note" && note) {
      revealNote(setView, note.id);
    } else if (type === "task" && card) {
      revealCard(setView, card.id);
    }
    setActivePreviewItem(null);
    setActiveContextPanel(null);
  }

  function handleOpenDeveloper() {
    if (!panel) return;
    const path = panel.type === "file" || panel.type === "diff" ? panel.path : undefined;
    if (path) openEditorFile(path);
    setActivePreviewItem(null);
    setActiveContextPanel(null);
    setView("agent");
  }

  return (
    <aside
      ref={panelRef}
      style={{ width: `${panelWidth}px` }}
      className="relative flex flex-col border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 min-h-0 overflow-hidden animate-slide-in-right z-30"
    >
      {/* Drag-to-resize handle */}
      <div
        ref={dividerRef}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize z-40 select-none hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)] transition-colors"
        style={{ marginLeft: -2 }}
        aria-hidden
      />

      {/* Pane header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
        <div className="flex items-center gap-2">
          {type === "note" ? (
            <FileText size={13} className="text-[var(--accent)]" />
          ) : type === "task" ? (
            <Kanban size={13} className="text-[var(--success)]" />
          ) : type === "file" ? (
            <Code2 size={13} className="text-[var(--info)]" />
          ) : (
            <GitBranch size={13} className="text-[var(--warning)]" />
          )}
          <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            {type === "note" ? "Note Preview" : type === "task" ? "Task Preview" : type === "file" ? "File Preview" : "Diff Preview"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {(note || card) && (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleGoToSection}
                className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                <ExternalLink size={11} />
                Go to {type === "note" ? "Notes" : "Board"}
              </Button>
              <div className="w-px h-3 bg-[var(--border)] my-1" />
            </>
          )}
          {(type === "file" || type === "diff") && (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleOpenDeveloper}
                className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                <ExternalLink size={11} />
                Open in Developer View
              </Button>
              <div className="w-px h-3 bg-[var(--border)] my-1" />
            </>
          )}

          <button
            onClick={() => setActivePreviewItem(null)}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors flex items-center justify-center"
            title="Close preview"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Pane content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-[var(--background)]">
        {type === "note" && (
          note ? (
            <div className="flex-1 min-h-0 overflow-auto">
              <NoteEditor note={note} />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 p-6 text-center text-xs text-[var(--text-tertiary)]">
              Note not found or deleted.
            </div>
          )
        )}
        {type === "task" && (
          card ? (
            <CardDetailPanel key={card.id} cardId={card.id} onClose={() => setActivePreviewItem(null)} />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 p-6 text-center text-xs text-[var(--text-tertiary)]">
              Task card not found or deleted.
            </div>
          )
        )}
        {type === "file" && <FileContextContent key={`file:${panel.path}`} path={panel.path} />}
        {type === "diff" && <DiffContextContent key={`diff:${panel.path ?? "all"}`} path={panel.path} />}
      </div>
    </aside>
  );
}
