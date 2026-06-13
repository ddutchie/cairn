"use client";

import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, Calendar, FileText, Lock, Pencil, Trash2 } from "lucide-react";
import { cn, formatDate, getDueDateStatus } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCairnStore } from "@/store";
import type { TaskCard } from "@/types";
import { PRIORITY_CSS_COLORS } from "@/lib/constants";

interface KanbanCardProps {
  card: TaskCard;
  onClick: () => void;
  isDragging?: boolean;
}

export const KanbanCard = React.memo(function KanbanCard({ card, onClick, isDragging = false }: KanbanCardProps) {
  const getTagById  = useCairnStore((s) => s.getTagById);
  const archiveCard = useCairnStore((s) => s.archiveCard);
  const deleteCard  = useCairnStore((s) => s.deleteCard);

  // A card is "actively blocked" if it has at least one blocker that isn't done/archived
  const isBlocked = (card.blockedByIds ?? []).length > 0;

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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{ ...style, touchAction: "none" }}
          {...attributes}
          {...listeners}
          onClick={onClick}
          className={cn(
            "group relative rounded-lg border bg-[var(--surface-2)] p-3 cursor-pointer overflow-hidden",
            "border-[var(--border)] hover:border-[var(--accent)]/40",
            "transition-all duration-150 select-none",
            "hover:shadow-md hover:shadow-black/20",
            (isDragging || isSortableDragging) && "opacity-40 rotate-1"
          )}
        >
      {/* Priority indicator */}
      <div
        className="absolute top-0 left-0 w-1 h-full opacity-60"
        style={{ backgroundColor: PRIORITY_CSS_COLORS[card.priority] }}
      />

      <div className="pl-2">
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
        <p className="text-[0.929rem] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] leading-snug transition-colors">
          {card.title}
        </p>

        {/* Description */}
        {card.description && (
          <p className="text-[0.786rem] text-[var(--text-tertiary)] mt-1.5 line-clamp-2 leading-relaxed">
            {card.description}
          </p>
        )}

        {/* Footer */}
        {(card.dueDate || card.linkedNoteIds.length > 0 || isBlocked) && (
          <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-[var(--border-subtle)]">
            {isBlocked && (
              <span className="flex items-center gap-1 text-[0.714rem] text-[var(--warning)] font-medium">
                <Lock size={10} />
                {(card.blockedByIds ?? []).length} blocker{(card.blockedByIds ?? []).length !== 1 ? "s" : ""}
              </span>
            )}
            {card.dueDate && (() => {
              const status = getDueDateStatus(card.dueDate);
              return (
                <span className={cn(
                  "flex items-center gap-1 text-[0.714rem] font-medium rounded px-1 py-0.5",
                  status === "overdue" && "text-[var(--danger)] bg-[var(--danger)]/10",
                  status === "today" && "text-[var(--warning)] bg-[var(--warning)]/10",
                  status === "upcoming" && "text-[var(--text-tertiary)]",
                )}>
                  <Calendar size={11} />
                  {status === "overdue" ? `Overdue · ${formatDate(card.dueDate)}` :
                   status === "today" ? "Due today" :
                   formatDate(card.dueDate)}
                </span>
              );
            })()}
            {card.linkedNoteIds.length > 0 && (
              <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] ml-auto">
                <FileText size={11} />
                {card.linkedNoteIds.length}
              </span>
            )}
          </div>
        )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onSelect={onClick}>
          <Pencil size={13} />
          Open card
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => archiveCard(card.id)}>
          <Archive size={13} />
          Archive
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => deleteCard(card.id)}
          className="text-[var(--danger)] hover:text-[var(--danger)]"
        >
          <Trash2 size={13} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
