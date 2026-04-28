"use client";

import React, { useState, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  closestCorners,
} from "@dnd-kit/core";
import { Plus, Kanban } from "lucide-react";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { KanbanColumn } from "./column";
import { KanbanCard } from "./card";
import { CardDetailModal } from "./card-detail";
import type { TaskCard } from "@/types";

export function KanbanBoard() {
  const {
    activeProjectId,
    getProjectColumns,
    getColumnCards,
    moveCard,
    createColumn,
    createCard,
    updateColumn,
    deleteColumn,
  } = useCairnStore();

  const [activeCard, setActiveCard] = useState<TaskCard | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const columns = activeProjectId ? getProjectColumns(activeProjectId) : [];

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  function handleDragStart(event: DragStartEvent) {
    const card = event.active.data.current?.card as TaskCard;
    setActiveCard(card ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    setOverId(event.over?.id as string ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveCard(null);
    setOverId(null);

    if (!over) return;

    const draggedCard = active.data.current?.card as TaskCard;
    if (!draggedCard) return;

    const overId = over.id as string;

    // Determine target column
    // over can be a column ID or a card ID
    let targetColumnId: string;
    let targetIndex: number;

    const isOverColumn = columns.some((c) => c.id === overId);
    if (isOverColumn) {
      targetColumnId = overId;
      const colCards = getColumnCards(overId);
      targetIndex = colCards.length;
    } else {
      // over is a card — find its column
      const allCards = columns.flatMap((c) =>
        getColumnCards(c.id).map((card) => ({ ...card, _colId: c.id }))
      );
      const overCard = allCards.find((c) => c.id === overId);
      if (!overCard) return;
      targetColumnId = overCard._colId;
      const colCards = getColumnCards(targetColumnId).filter((c) => c.id !== draggedCard.id);
      const overIdx = colCards.findIndex((c) => c.id === overId);
      targetIndex = overIdx >= 0 ? overIdx : colCards.length;
    }

    if (
      draggedCard.columnId === targetColumnId &&
      getColumnCards(targetColumnId)[targetIndex]?.id === draggedCard.id
    ) {
      return;
    }

    moveCard(draggedCard.id, targetColumnId, targetIndex);
  }

  // Listen for deep-link events from search/overview
  useEffect(() => {
    const handler = (e: Event) => {
      const { cardId } = (e as CustomEvent).detail;
      setDetailCardId(cardId);
    };
    window.addEventListener("cairn:open-card", handler);
    return () => window.removeEventListener("cairn:open-card", handler);
  }, []);

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  function handleAddColumn() {
    if (!activeProjectId) return;
    setNewColumnName("");
    setAddColumnOpen(true);
  }

  function handleAddColumnConfirm() {
    if (newColumnName.trim() && activeProjectId) {
      createColumn(activeProjectId, newColumnName.trim());
    }
    setAddColumnOpen(false);
  }

  if (!activeProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[var(--text-tertiary)] text-sm">No project selected</p>
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 flex gap-3 overflow-x-auto p-5 min-h-0">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              cards={getColumnCards(column.id)}
              onCardClick={(cardId) => setDetailCardId(cardId)}
              onAddCard={(title) => createCard(column.id, activeProjectId, title)}
              onRename={(name) => updateColumn(column.id, { name })}
              onDelete={() => deleteColumn(column.id)}
              isDragOver={overId === column.id}
            />
          ))}

          {/* Add column */}
          <div className="flex-shrink-0 w-56">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAddColumn}
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

        <DragOverlay>
          {activeCard && (
            <div className="rotate-2 opacity-90">
              <KanbanCard
                card={activeCard}
                isDragging
                onClick={() => {}}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Card detail modal */}
      {detailCardId && (
        <CardDetailModal
          cardId={detailCardId}
          onClose={() => setDetailCardId(null)}
        />
      )}

      {/* Add column dialog */}
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
