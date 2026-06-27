"use client";

import React, { useRef, useEffect, useState } from "react";
import { X, ExternalLink, FileText, Kanban } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { NoteEditor } from "@/components/notes/note-editor";
import { CardDetailPanel } from "@/components/kanban/card-detail-panel";
import { CairnEvents } from "@/lib/events";
import { Button } from "@/components/ui/button";

const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 900;
const DEFAULT_PREVIEW_WIDTH = 550;

export function PreviewPane() {
  const { activePreviewItem, setActivePreviewItem, setView, notes, cards } = useCairnStore(useShallow((s) => ({
    activePreviewItem: s.activePreviewItem,
    setActivePreviewItem: s.setActivePreviewItem,
    setView: s.setView,
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
  }, [activePreviewItem]);

  if (!activePreviewItem) return null;

  const { type, id } = activePreviewItem;
  const note = type === "note" ? notes.find((n) => n.id === id) : null;
  const card = type === "task" ? cards.find((c) => c.id === id) : null;

  if (type === "note" && !note) {
    return (
      <aside className="w-80 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col items-center justify-center p-6 text-center text-xs text-[var(--text-tertiary)]">
        Note not found or deleted.
      </aside>
    );
  }

  if (type === "task" && !card) {
    return (
      <aside className="w-80 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col items-center justify-center p-6 text-center text-xs text-[var(--text-tertiary)]">
        Task card not found or deleted.
      </aside>
    );
  }

  function handleGoToSection() {
    if (type === "note" && note) {
      setView("notes");
      setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(note.id)), 50);
    } else if (type === "task" && card) {
      setView("board");
      setTimeout(() => window.dispatchEvent(CairnEvents.openCard(card.id)), 50);
    }
    setActivePreviewItem(null);
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
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize z-40 select-none hover:bg-[var(--accent)]/50 transition-colors"
        style={{ marginLeft: -2 }}
        aria-hidden
      />

      {/* Pane header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
        <div className="flex items-center gap-2">
          {type === "note" ? (
            <FileText size={13} className="text-[var(--accent)]" />
          ) : (
            <Kanban size={13} className="text-[var(--success,#22c55e)]" />
          )}
          <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            {type === "note" ? "Note Preview" : "Task Preview"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
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
        {type === "note" && note && (
          <div className="flex-1 min-h-0 overflow-auto">
            <NoteEditor note={note} />
          </div>
        )}
        {type === "task" && card && (
          <CardDetailPanel cardId={card.id} onClose={() => setActivePreviewItem(null)} />
        )}
      </div>
    </aside>
  );
}
