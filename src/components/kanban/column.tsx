"use client";

import React, { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus, MoreHorizontal, Grip } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KanbanCard } from "./card";
import type { BoardColumn, TaskCard } from "@/types";

const COLUMN_ACCENT: Record<string, string> = {
  backlog: "#666360",
  todo: "#60a5fa",
  in_progress: "#f59e0b",
  review: "#a78bfa",
  done: "#3ecf8e",
  custom: "#9ca3af",
};

interface KanbanColumnProps {
  column: BoardColumn;
  cards: TaskCard[];
  onCardClick: (cardId: string) => void;
  onAddCard: (title: string) => void;
  isDragOver: boolean;
}

export function KanbanColumn({
  column,
  cards,
  onCardClick,
  onAddCard,
  isDragOver,
}: KanbanColumnProps) {
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState("");

  const { setNodeRef } = useDroppable({ id: column.id });

  const accent = COLUMN_ACCENT[column.type] ?? COLUMN_ACCENT.custom;

  function handleAddCard() {
    if (newCardTitle.trim()) {
      onAddCard(newCardTitle.trim());
      setNewCardTitle("");
      setIsAddingCard(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleAddCard();
    if (e.key === "Escape") {
      setIsAddingCard(false);
      setNewCardTitle("");
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col w-56 rounded-xl border flex-shrink-0 transition-colors duration-150",
        isDragOver
          ? "border-[var(--accent)]/50 bg-[var(--accent-dim)]"
          : "border-[var(--border)] bg-[var(--surface)]"
      )}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)]">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: accent }}
        />
        <span className="text-xs font-semibold text-[var(--text-secondary)] flex-1 truncate">
          {column.name}
        </span>
        <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0 font-mono">
          {cards.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="opacity-0 hover:opacity-100 group-hover:opacity-100 w-5 h-5"
          onClick={() => setIsAddingCard(true)}
        >
          <Plus size={11} />
        </Button>
      </div>

      {/* Cards */}
      <SortableContext
        items={cards.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[48px]"
        >
          {cards.map((card) => (
            <KanbanCard
              key={card.id}
              card={card}
              onClick={() => onCardClick(card.id)}
            />
          ))}

          {cards.length === 0 && !isAddingCard && (
            <div
              className="flex items-center justify-center h-12 rounded-lg border border-dashed border-[var(--border)] text-[11px] text-[var(--text-tertiary)] cursor-pointer hover:border-[var(--accent)]/40 hover:text-[var(--accent)]/60 transition-colors"
              onClick={() => setIsAddingCard(true)}
            >
              Drop here or add card
            </div>
          )}
        </div>
      </SortableContext>

      {/* Add card input */}
      {isAddingCard ? (
        <div className="p-2 border-t border-[var(--border)] space-y-2">
          <textarea
            autoFocus
            value={newCardTitle}
            onChange={(e) => setNewCardTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Card title…"
            rows={2}
            className="w-full px-2.5 py-2 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none"
          />
          <div className="flex gap-1.5">
            <Button variant="accent" size="xs" onClick={handleAddCard}>
              Add
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setIsAddingCard(false);
                setNewCardTitle("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-2 border-t border-[var(--border)]">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            onClick={() => setIsAddingCard(true)}
          >
            <Plus size={12} />
            <span className="text-xs">Add card</span>
          </Button>
        </div>
      )}
    </div>
  );
}
