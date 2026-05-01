"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
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
import { Plus, Kanban, Archive, Trash2 } from "lucide-react";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { KanbanColumn } from "./column";
import { KanbanCard } from "./card";
import { CardDetailModal } from "./card-detail";
import type { TaskCard, BoardColumn } from "@/types";

const ZONE_H = 56;

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
  } = useCairnStore();

  const [activeCard, setActiveCard]         = useState<TaskCard | null>(null);
  const [activeColumn, setActiveColumn]     = useState<BoardColumn | null>(null);
  const [detailCardId, setDetailCardId]     = useState<string | null>(null);
  const [overId, setOverId]                 = useState<string | null>(null);
  const [deleteFlashing, setDeleteFlashing] = useState(false);
  const [hoverZone, setHoverZone]           = useState<"archive" | "delete" | null>(null);

  // Portal zone rects — computed from the board container when drag starts
  const boardRef    = useRef<HTMLDivElement>(null);
  const [zoneRect, setZoneRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const columns = activeProjectId ? getProjectColumns(activeProjectId) : [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Compute portal zone position from board container
  function computeZoneRect() {
    const r = boardRef.current?.getBoundingClientRect();
    if (!r) return null;
    return { top: r.top, left: r.left, width: r.width };
  }

  // Hit-test a pointer position against the two zones
  function getZoneHit(clientX: number, clientY: number, rect: { top: number; left: number; width: number }): "archive" | "delete" | null {
    const { top, left, width } = rect;
    const bottom = top + ZONE_H;
    const mid    = left + width / 2;
    if (clientY < top || clientY > bottom) return null;
    if (clientX < left || clientX > left + width) return null;
    return clientX < mid ? "archive" : "delete";
  }

  function handleDragStart(event: DragStartEvent) {
    const col  = event.active.data.current?.column as BoardColumn | undefined;
    const card = event.active.data.current?.card   as TaskCard    | undefined;
    if (col)       { setActiveColumn(col); setZoneRect(null); }
    else if (card) { setActiveCard(card);  setZoneRect(computeZoneRect()); }
  }

  function handleDragMove(event: DragMoveEvent) {
    if (!activeCard || !zoneRect) { setHoverZone(null); return; }
    const init = event.activatorEvent as PointerEvent;
    const x = init.clientX + event.delta.x;
    const y = init.clientY + event.delta.y;
    const zone = getZoneHit(x, y, zoneRect);
    setHoverZone(zone);
    // Clear column/card drop highlight while hovering an action zone
    if (zone) setOverId(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setOverId(event.over?.id as string ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const draggedCard = active.data.current?.card as TaskCard | undefined;

    // Compute final pointer position before clearing state
    const init  = event.activatorEvent as PointerEvent;
    const dropX = init.clientX + event.delta.x;
    const dropY = init.clientY + event.delta.y;
    const rect  = zoneRect;

    setActiveCard(null);
    setActiveColumn(null);
    setOverId(null);
    setHoverZone(null);
    setZoneRect(null);

    // ── Action zones ──────────────────────────────────────────────────────
    if (draggedCard && rect) {
      const zone = getZoneHit(dropX, dropY, rect);
      if (zone === "archive") {
        archiveCard(draggedCard.id);
        return;
      }
      if (zone === "delete") {
        setDeleteFlashing(true);
        setTimeout(() => {
          setDeleteFlashing(false);
          deleteCard(draggedCard.id);
        }, 300);
        return;
      }
    }

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
    const overIdStr = over.id as string;
    let targetColumnId: string;
    let targetIndex: number;

    const isOverColumn = columns.some((c) => c.id === overIdStr);
    if (isOverColumn) {
      targetColumnId = overIdStr;
      targetIndex = getColumnCards(overIdStr).length;
    } else {
      const allCards = columns.flatMap((c) =>
        getColumnCards(c.id).map((card) => ({ ...card, _colId: c.id }))
      );
      const overCard = allCards.find((c) => c.id === overIdStr);
      if (!overCard) return;
      targetColumnId = overCard._colId;
      const colCards = getColumnCards(targetColumnId).filter((c) => c.id !== draggedCard.id);
      const overIdx  = colCards.findIndex((c) => c.id === overIdStr);
      targetIndex = overIdx >= 0 ? overIdx : colCards.length;
    }

    if (
      draggedCard.columnId === targetColumnId &&
      getColumnCards(targetColumnId)[targetIndex]?.id === draggedCard.id
    ) return;

    moveCard(draggedCard.id, targetColumnId, targetIndex);
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

  function handleAddColumnConfirm() {
    if (newColumnName.trim() && activeProjectId) createColumn(activeProjectId, newColumnName.trim());
    setAddColumnOpen(false);
  }

  if (!activeProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[var(--text-tertiary)] text-sm">No project selected</p>
      </div>
    );
  }

  // Portal action zones — rendered into document.body, positioned over the board top edge
  const actionZonesPortal = activeCard && zoneRect && typeof document !== "undefined"
    ? createPortal(
        <div
          style={{
            position: "fixed",
            top: zoneRect.top,
            left: zoneRect.left,
            width: zoneRect.width,
            height: ZONE_H,
            display: "flex",
            zIndex: 9999,
            pointerEvents: "none", // visual only — drop detected via hit-test in handleDragEnd
          }}
        >
          {/* Archive half */}
          <div
            style={{
              width: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontSize: 13,
              fontWeight: 500,
              background: hoverZone === "archive" ? "color-mix(in srgb, var(--warning) 22%, transparent)" : "color-mix(in srgb, var(--warning) 8%, transparent)",
              color: hoverZone === "archive" ? "var(--warning)" : "color-mix(in srgb, var(--warning) 50%, transparent)",
              borderBottom: `1px solid color-mix(in srgb, var(--warning) ${hoverZone === "archive" ? "45%" : "20%"}, transparent)`,
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}
          >
            <Archive size={14} />
            Archive
          </div>
          {/* Delete half */}
          <div
            style={{
              width: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontSize: 13,
              fontWeight: 500,
              background: deleteFlashing
                ? "color-mix(in srgb, var(--danger) 40%, transparent)"
                : hoverZone === "delete"
                ? "color-mix(in srgb, var(--danger) 22%, transparent)"
                : "color-mix(in srgb, var(--danger) 8%, transparent)",
              color: hoverZone === "delete" || deleteFlashing ? "var(--danger)" : "color-mix(in srgb, var(--danger) 50%, transparent)",
              borderBottom: `1px solid color-mix(in srgb, var(--danger) ${hoverZone === "delete" ? "45%" : "20%"}, transparent)`,
              borderLeft: "1px solid color-mix(in srgb, var(--danger) 15%, transparent)",
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}
          >
            <Trash2 size={14} />
            Delete
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div ref={boardRef} className="flex-1 flex flex-col min-h-0 w-full overflow-hidden">
          <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
            <div
              ref={boardScrollRef}
              className="flex-1 flex gap-3 overflow-x-auto p-5 min-h-0 transition-all duration-200"
              style={{ paddingTop: activeCard ? ZONE_H + 20 : 20 }}
            >
              {columns.map((column) => (
                <div key={column.id} ref={(el) => { columnRefs.current[column.id] = el; }} className="flex-shrink-0">
                  <KanbanColumn
                    column={column}
                    cards={getColumnCards(column.id)}
                    archivedCards={getArchivedColumnCards(column.id)}
                    onCardClick={(cardId) => setDetailCardId(cardId)}
                    onAddCard={(data) => createCard(column.id, activeProjectId, data.title, { dueDate: data.dueDate, assignee: data.assignee })}
                    onRename={(name) => updateColumn(column.id, { name })}
                    onSetLimit={(limit) => updateColumn(column.id, { cardLimit: limit ?? undefined })}
                    onDelete={() => deleteColumn(column.id)}
                    onRestoreCard={(cardId) => restoreCard(cardId)}
                    isDragOver={overId === column.id}
                    isColumnDragging={activeColumn?.id === column.id}
                    isHighlighted={highlightedColumnId === column.id}
                  />
                </div>
              ))}

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
          </SortableContext>
        </div>

        {actionZonesPortal}

        <DragOverlay>
          {activeCard && (
            <div className="rotate-2 opacity-90">
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
                onAddCard={(_data) => {}}
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
