"use client";

import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, FileText } from "lucide-react";
import { cn, formatDate, getDueDateStatus, PRIORITY_COLORS } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useCairnStore } from "@/store";
import type { TaskCard } from "@/types";

interface KanbanCardProps {
  card: TaskCard;
  onClick: () => void;
  isDragging?: boolean;
}

export function KanbanCard({ card, onClick, isDragging = false }: KanbanCardProps) {
  const { getTagById } = useCairnStore();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({
    id: card.id,
    data: { card },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const tags = card.tagIds.slice(0, 2).map((id) => getTagById(id)).filter(Boolean);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={cn(
        "group relative rounded-lg border bg-[var(--surface-2)] p-3 cursor-pointer",
        "border-[var(--border)] hover:border-[var(--accent)]/40",
        "transition-all duration-150 select-none",
        "hover:shadow-md hover:shadow-black/20",
        (isDragging || isSortableDragging) && "opacity-40 rotate-1"
      )}
    >
      {/* Priority indicator */}
      <div
        className={cn(
          "absolute top-0 left-0 w-0.5 h-full rounded-l-lg opacity-60",
          card.priority === "urgent" && "bg-red-500",
          card.priority === "high" && "bg-orange-400",
          card.priority === "medium" && "bg-amber-400",
          card.priority === "low" && "bg-stone-500"
        )}
      />

      <div className="pl-1.5">
        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {tags.map(
              (tag) =>
                tag && (
                  <Badge key={tag.id} color={tag.color}>
                    {tag.name}
                  </Badge>
                )
            )}
          </div>
        )}

        {/* Title */}
        <p className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] leading-relaxed transition-colors">
          {card.title}
        </p>

        {/* Description */}
        {card.description && (
          <p className="text-[11px] text-[var(--text-tertiary)] mt-1 line-clamp-2 leading-relaxed">
            {card.description}
          </p>
        )}

        {/* Footer */}
        {(card.dueDate || card.linkedNoteIds.length > 0) && (
          <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-[var(--border-subtle)]">
            {card.dueDate && (() => {
              const status = getDueDateStatus(card.dueDate);
              return (
                <span className={cn(
                  "flex items-center gap-1 text-[10px] font-medium rounded px-1 py-0.5",
                  status === "overdue" && "text-red-400 bg-red-400/10",
                  status === "today" && "text-amber-400 bg-amber-400/10",
                  status === "upcoming" && "text-[var(--text-tertiary)]",
                )}>
                  <Calendar size={9} />
                  {status === "overdue" ? `Overdue · ${formatDate(card.dueDate)}` :
                   status === "today" ? "Due today" :
                   formatDate(card.dueDate)}
                </span>
              );
            })()}
            {card.linkedNoteIds.length > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] ml-auto">
                <FileText size={9} />
                {card.linkedNoteIds.length}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
