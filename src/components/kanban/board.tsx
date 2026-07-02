"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragMoveEvent,
  closestCorners,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { Plus, Kanban, Archive, Trash2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { ArchiveView } from "./archive-view";
import { KanbanColumn } from "./column";
import { KanbanCard } from "./card";
import { CardDetailModal } from "./card-detail";
import type { TaskCard, BoardColumn } from "@/types";
import { getZoneHit, resolveCardDrop } from "./board-dnd";

export function KanbanBoard() {
  const {
    activeProjectId,
    getProjectColumns,
    getColumnCards,
    getArchivedColumnCards,
    moveCard,
    archiveCard,
    deleteCard,
    createColumn,
    createCard,
    updateColumn,
    deleteColumn,
    reorderColumns,
    restoreCard,
    archiveAllDoneCards,
    getArchivedProjectCards,
  } = useCairnStore(useShallow((s) => ({
    activeProjectId:          s.activeProjectId,
    // Subscribe to cards directly so bulk archive/restore triggers a re-render.
    // Selector functions (getColumnCards etc.) read from get() but are stable
    // references — they won't cause a re-render on their own when cards change.
    cards:                    s.cards,
    getProjectColumns:        s.getProjectColumns,
    getColumnCards:           s.getColumnCards,
    getArchivedColumnCards:   s.getArchivedColumnCards,
    getArchivedProjectCards:  s.getArchivedProjectCards,
    moveCard:                 s.moveCard,
    archiveCard:              s.archiveCard,
    deleteCard:               s.deleteCard,
    createColumn:             s.createColumn,
    createCard:               s.createCard,
    updateColumn:             s.updateColumn,
    deleteColumn:             s.deleteColumn,
    reorderColumns:           s.reorderColumns,
    restoreCard:              s.restoreCard,
    archiveAllDoneCards:      s.archiveAllDoneCards,
  })));

  const [activeCard, setActiveCard]         = useState<TaskCard | null>(null);
  const [activeColumn, setActiveColumn]     = useState<BoardColumn | null>(null);
  const [detailCardId, setDetailCardId]     = useState<string | null>(null);
  const [overId, setOverId]                 = useState<string | null>(null);
  const [deleteFlashing, setDeleteFlashing] = useState(false);

  // Board filter — ⌘F / Ctrl+F toggles and focuses
  const [boardFilter, setBoardFilter]       = useState("");
  const [filterVisible, setFilterVisible]   = useState(false);
  const filterInputRef                      = useRef<HTMLInputElement>(null);

  // Archive view
  const [archiveViewOpen, setArchiveViewOpen] = useState(false);
  const [archiveFilter, setArchiveFilter]     = useState("");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        setFilterVisible(true);
        setTimeout(() => { filterInputRef.current?.focus(); filterInputRef.current?.select(); }, 0);
      }
      if (e.key === "Escape") {
        setFilterVisible((visible) => {
          if (visible) setBoardFilter("");
          return false;
        });
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const columns = activeProjectId ? getProjectColumns(activeProjectId) : [];

  const sensors = useSensors(
    // Slight distance increase prevents accidental drags on trackpads
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // TouchSensor: 250ms hold-to-drag so touch doesn't conflict with native scroll
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  function handleDragStart(event: DragStartEvent) {
    const col  = event.active.data.current?.column as BoardColumn | undefined;
    const card = event.active.data.current?.card   as TaskCard    | undefined;
    if (col)       { setActiveColumn(col); }
    else if (card) { setActiveCard(card); }
  }

  const hoverZoneRef = useRef<"archive" | "delete" | null>(null);
  const dragOverlayRef = useRef<HTMLDivElement | null>(null);

  function applyZoneHighlight(zone: "archive" | "delete" | null) {
    const a = archiveBtnRef.current;
    const d = deleteBtnRef.current;
    if (a) a.classList.toggle("zone-active", zone === "archive");
    if (d) d.classList.toggle("zone-active", zone === "delete");
    const ov = dragOverlayRef.current;
    if (ov) {
      ov.classList.toggle("ring-2", !!zone);
      ov.classList.toggle("ring-[var(--warning)]", zone === "archive");
      ov.classList.toggle("ring-[var(--danger)]", zone === "delete");
    }
  }

  function handleDragMove(_event: DragMoveEvent) {
    if (!activeCard) { return; }
    const p = livePointer.current;
    if (!p) return;
    const barRect = titleBarRef.current?.getBoundingClientRect() ?? null;
    const archive = archiveBtnRef.current?.getBoundingClientRect() ?? null;
    const del = deleteBtnRef.current?.getBoundingClientRect() ?? null;
    const zone = getZoneHit(p.x, p.y, barRect, archive, del);
    if (zone !== hoverZoneRef.current) {
      hoverZoneRef.current = zone;
      applyZoneHighlight(zone);
    }
    if (zone) setOverId(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setOverId(event.over?.id as string ?? null);
  }

  function handleDragCancel() {
    setActiveCard(null);
    setActiveColumn(null);
    setOverId(null);
    hoverZoneRef.current = null;
    applyZoneHighlight(null);
    livePointer.current = null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const draggedCard = active.data.current?.card as TaskCard | undefined;

    // Use the last known live pointer position (tracked via window listener).
    const drop = livePointer.current;
    const dropX = drop?.x ?? 0;
    const dropY = drop?.y ?? 0;
    const barRect = titleBarRef.current?.getBoundingClientRect() ?? null;
    const archive = archiveBtnRef.current?.getBoundingClientRect() ?? null;
    const del = deleteBtnRef.current?.getBoundingClientRect() ?? null;

    // Check action zones before clearing drag state — the delete flash
    // needs activeCard to stay truthy so the zone buttons remain mounted.
    if (draggedCard) {
      const zone = getZoneHit(dropX, dropY, barRect, archive, del);
      if (zone === "archive") {
        setActiveCard(null);
        setActiveColumn(null);
        setOverId(null);
        hoverZoneRef.current = null;
        applyZoneHighlight(null);
        livePointer.current = null;
        archiveCard(draggedCard.id);
        return;
      }
      if (zone === "delete") {
        setDeleteFlashing(true);
        applyZoneHighlight("delete");
        setTimeout(() => {
          setDeleteFlashing(false);
          setActiveCard(null);
          setActiveColumn(null);
          setOverId(null);
          hoverZoneRef.current = null;
          applyZoneHighlight(null);
          livePointer.current = null;
          deleteCard(draggedCard.id);
        }, 300);
        return;
      }
    }

    setActiveCard(null);
    setActiveColumn(null);
    setOverId(null);
    hoverZoneRef.current = null;
    applyZoneHighlight(null);
    livePointer.current = null;

    if (!over || active.id === over.id) return;

    // ── Column reorder ────────────────────────────────────────────────────
    if (active.data.current?.column) {
      if (!activeProjectId) return;
      const oldIndex = columns.findIndex((c) => c.id === active.id);
      const newIndex = columns.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      reorderColumns(activeProjectId, arrayMove(columns, oldIndex, newIndex).map((c) => c.id));
      return;
    }

    // ── Card move / reorder ───────────────────────────────────────────────
    if (!draggedCard) return;
    const cardDrop = resolveCardDrop(columns, getColumnCards, draggedCard, over.id as string);
    if (!cardDrop) return;
    moveCard(draggedCard.id, cardDrop.targetColumnId, cardDrop.targetIndex);
  }

  // Deep-link: open card detail
  useEffect(() => {
    const handler = (e: Event) => setDetailCardId((e as CustomEvent).detail.cardId);
    window.addEventListener("cairn:open-card", handler);
    return () => window.removeEventListener("cairn:open-card", handler);
  }, []);

  // Deep-link: scroll to column
  const columnRefs     = useRef<Record<string, HTMLDivElement | null>>({});
  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const titleBarRef = useRef<HTMLDivElement | null>(null);
  const archiveBtnRef = useRef<HTMLButtonElement | null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement | null>(null);
  const livePointer = useRef<{ x: number; y: number } | null>(null);

  // Track real pointer position via window listener during drag — dnd-kit's
  // event.delta doesn't account for auto-scroll, so we can't rely on
  // activatorEvent + delta for screen coordinates.
  useEffect(() => {
    if (!activeCard) { livePointer.current = null; return; }
    function onPointerMove(e: PointerEvent) {
      livePointer.current = { x: e.clientX, y: e.clientY };
    }
    function onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (t) livePointer.current = { x: t.clientX, y: t.clientY };
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("touchmove", onTouchMove);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [activeCard]);
  const [highlightedColumnId, setHighlightedColumnId] = useState<string | null>(null);

  const scrollToColumn = useCallback((columnId: string) => {
    const el = columnRefs.current[columnId];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setHighlightedColumnId(columnId);
    setTimeout(() => setHighlightedColumnId(null), 1200);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => scrollToColumn((e as CustomEvent).detail.columnId);
    window.addEventListener("cairn:scroll-to-column", handler);
    return () => window.removeEventListener("cairn:scroll-to-column", handler);
  }, [scrollToColumn]);

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  const handleAddColumnConfirm = useCallback(() => {
    if (newColumnName.trim() && activeProjectId) createColumn(activeProjectId, newColumnName.trim());
    setAddColumnOpen(false);
  }, [newColumnName, activeProjectId, createColumn, setAddColumnOpen]);

  if (!activeProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[var(--text-tertiary)] text-sm">No project selected</p>
      </div>
    );
  }

  // No more portal — action zones are rendered inline in the title bar.

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex-1 flex flex-col min-h-0 w-full overflow-hidden">
          {/* Board / Archive toggle bar */}
          <div ref={titleBarRef} className="flex items-center gap-1 px-4 h-9 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
            <button
              onClick={() => setArchiveViewOpen(false)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
                !archiveViewOpen
                  ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              )}
            >
              <Kanban size={11} />
              Board
              {activeProjectId && (() => {
                const count = columns.reduce((n, col) => n + getColumnCards(col.id).length, 0);
                return count > 0 ? (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[0.643rem] bg-[var(--surface-3)] text-[var(--text-tertiary)]">{count}</span>
                ) : null;
              })()}
            </button>
            <button
              onClick={() => setArchiveViewOpen(true)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
                archiveViewOpen
                  ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              )}
            >
              <Archive size={11} />
              Archive
              {activeProjectId && (() => {
                const count = getArchivedProjectCards(activeProjectId).length;
                return count > 0 ? (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[0.643rem] bg-[var(--surface-3)] text-[var(--text-tertiary)]">{count}</span>
                ) : null;
              })()}
            </button>

            {/* Drop zones — shown alongside toggle buttons during card drag */}
            {activeCard && (
              <div className="flex items-center gap-1 ml-auto">
                <button
                  ref={archiveBtnRef}
                  type="button"
                  className="zone-archive flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                >
                  <Archive size={11} />
                  Archive
                </button>
                <button
                  ref={deleteBtnRef}
                  type="button"
                  className={cn(
                    "zone-delete flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
                    deleteFlashing && "zone-active"
                  )}
                >
                  <Trash2 size={11} />
                  Delete
                </button>
              </div>
            )}
          </div>

          {/* Filter bar — shown when ⌘F is pressed */}
          {filterVisible && !archiveViewOpen && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface-1)] flex-shrink-0">
              <div className="relative flex items-center flex-1 max-w-xs">
                <Search size={12} className="absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
                <input
                  ref={filterInputRef}
                  type="text"
                  value={boardFilter}
                  onChange={(e) => setBoardFilter(e.target.value)}
                  placeholder="Filter cards…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              {boardFilter && (() => {
                const q = boardFilter.toLowerCase();
                const matchCount = columns.reduce((n, col) =>
                  n + getColumnCards(col.id).filter((c) =>
                    c.title.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q)
                  ).length, 0);
                return (
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {matchCount} match{matchCount === 1 ? "" : "es"}
                  </span>
                );
              })()}
              <button
                onClick={() => { setBoardFilter(""); setFilterVisible(false); }}
                className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {/* ── Archive view ── */}
          {archiveViewOpen && activeProjectId && (
            <ArchiveView
              projectId={activeProjectId}
              filter={archiveFilter}
              onFilterChange={setArchiveFilter}
              onOpenCard={setDetailCardId}
            />
          )}

          {/* ── Kanban board ── */}
          {!archiveViewOpen && <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
            <div
              ref={boardScrollRef}
              data-tutorial="kanban-columns"
              className="flex-1 flex gap-3 overflow-x-auto p-5 min-h-0"
            >
              {columns.map((column) => {
                const allCards = getColumnCards(column.id);
                const filteredCards = boardFilter
                  ? allCards.filter((c) => {
                      const q = boardFilter.toLowerCase();
                      return c.title.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q);
                    })
                  : allCards;
                return (
                  <div key={column.id} ref={(el) => { columnRefs.current[column.id] = el; }} className="flex-shrink-0 self-stretch">
                    <KanbanColumn
                      column={column}
                      cards={filteredCards}
                      archivedCards={getArchivedColumnCards(column.id)}
                      onCardClick={(cardId) => setDetailCardId(cardId)}
                      onAddCard={(data) => createCard(column.id, activeProjectId, data.title, { dueDate: data.dueDate, assignee: data.assignee })}
                      onRename={(name) => updateColumn(column.id, { name })}
                      onSetLimit={(limit) => updateColumn(column.id, { cardLimit: limit ?? undefined })}
                      onDelete={() => deleteColumn(column.id)}
                      onRestoreCard={(cardId) => restoreCard(cardId)}
                      onArchiveAllDone={column.type === "done" && allCards.length > 0 ? () => archiveAllDoneCards(column.id) : undefined}
                      isDragOver={overId === column.id}
                      isColumnDragging={activeColumn?.id === column.id}
                      isHighlighted={highlightedColumnId === column.id}
                    />
                  </div>
                );
              })}

              <div className="flex-shrink-0 w-56">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { if (activeProjectId) { setNewColumnName(""); setAddColumnOpen(true); } }}
                  className="w-full border border-dashed border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)] hover:text-[var(--accent)] h-auto py-3"
                >
                  <Plus size={13} />
                  Add column
                </Button>
              </div>

              {columns.length === 0 && (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <Kanban size={32} className="mx-auto mb-3 text-[var(--text-tertiary)] opacity-30" />
                    <p className="text-sm text-[var(--text-tertiary)]">No columns yet</p>
                  </div>
                </div>
              )}
            </div>
          </SortableContext>}
        </div>

        <DragOverlay>
          {activeCard && (
            <div
              ref={dragOverlayRef}
              className="rotate-2 opacity-90 rounded-lg"
            >
              <KanbanCard card={activeCard} isDragging onClick={() => {}} />
            </div>
          )}
          {activeColumn && (
            <div className="rotate-1 opacity-80">
              <KanbanColumn
                column={activeColumn}
                cards={getColumnCards(activeColumn.id)}
                archivedCards={[]}
                onCardClick={() => {}}
                onAddCard={() => {}}
                onRename={() => {}}
                onSetLimit={() => {}}
                onDelete={() => {}}
                onRestoreCard={() => {}}
                isDragOver={false}
                isColumnDragging={true}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {detailCardId && (
        <CardDetailModal cardId={detailCardId} onClose={() => setDetailCardId(null)} />
      )}

      <Dialog open={addColumnOpen} onOpenChange={setAddColumnOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Add column</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); handleAddColumnConfirm(); }}
            className="px-5 py-4 space-y-4"
          >
            <input
              autoFocus
              type="text"
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              placeholder="Column name"
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm" type="button">Cancel</Button>
              </DialogClose>
              <Button variant="accent" size="sm" type="submit" disabled={!newColumnName.trim()}>
                Add column
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
