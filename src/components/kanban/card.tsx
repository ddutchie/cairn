"use client";

import React, { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, Calendar, ChevronDown, ChevronUp, FileText, Lock, Pencil, Trash2, User } from "lucide-react";
import { cn, formatDate, getDueDateStatus } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
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
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

interface KanbanCardProps {
  card: TaskCard;
  onClick: () => void;
  isDragging?: boolean;
}

function isExpandable(description: string | undefined): boolean {
  if (!description?.trim()) return false;
  const lines = description.split("\n").filter((l) => l.trim()).length;
  return lines > 2 || description.length > 140;
}

export const KanbanCard = React.memo(function KanbanCard({ card, onClick, isDragging = false }: KanbanCardProps) {
  const getTagById  = useCairnStore((s) => s.getTagById);
  const archiveCard = useCairnStore((s) => s.archiveCard);
  const deleteCard  = useCairnStore((s) => s.deleteCard);

  const [expanded, setExpanded] = useState(false);
  const descRef = React.useRef<HTMLDivElement>(null);

  const toggleExpanded = React.useCallback((e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    setExpanded((v) => {
      const next = !v;
      if (!next && descRef.current) descRef.current.scrollTop = 0;
      return next;
    });
  }, []);

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

  const tags = card.tagIds.slice(0, 3).map((id) => getTagById(id)).filter(Boolean);
  const extraTags = card.tagIds.slice(3).map((id) => getTagById(id)).filter(Boolean);
  const extraTagCount = Math.max(0, card.tagIds.length - 3);

  const description = card.description?.trim() || "";
  const canExpand = isExpandable(card.description);

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

          <div className="pl-2 flex flex-col gap-2">
            {/* Title */}
            <p className="text-[0.929rem] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] leading-snug transition-colors">
              {card.title}
            </p>

            {/* Description (markdown, collapsible) */}
            {description && (
              <div
                ref={descRef}
                className={cn(
                  "text-[0.786rem] text-[var(--text-tertiary)] leading-relaxed",
                  expanded ? "max-h-48 overflow-y-auto pr-1" : "line-clamp-2"
                )}
              >
                <NoteMarkdownPreview content={description} className="!px-0 !py-0" />
              </div>
            )}

            {/* Expand toggle */}
            {canExpand && (
              <button
                type="button"
                onClick={toggleExpanded}
                onPointerDown={(e) => e.stopPropagation()}
                className="self-start flex items-center gap-0.5 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors -mt-1"
                aria-label={expanded ? "Collapse description" : "Expand description"}
              >
                {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {expanded ? "Less" : "More"}
              </button>
            )}

            {/* Footer — due dates / blockers / assignee / linked notes */}
            {(card.dueDate || card.linkedNoteIds.length > 0 || isBlocked || card.assignee) && (
              <div className="flex items-center gap-2 pt-1.5 border-t border-[var(--border-subtle)]">
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
                {card.assignee && (
                  <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)]" title={card.assignee}>
                    <User size={10} />
                    <span className="truncate max-w-[4rem]">{card.assignee}</span>
                  </span>
                )}
                {card.linkedNoteIds.length > 0 && (
                  <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] ml-auto">
                    <FileText size={11} />
                    {card.linkedNoteIds.length}
                  </span>
                )}
              </div>
            )}

            {/* Tags — bottom, smaller */}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1.5 border-t border-[var(--border-subtle)]">
                {tags.map(
                  (tag) =>
                    tag && (
                      <Badge key={tag.id} color={tag.color} size="xs">
                        {tag.name}
                      </Badge>
                    )
                )}
                {extraTagCount > 0 && (
                  <Tooltip content={extraTags.map((t) => t?.name).filter(Boolean).join(", ")}>
                    <span className="text-[0.643rem] text-[var(--text-tertiary)] self-center px-0.5 cursor-default">
                      +{extraTagCount}
                    </span>
                  </Tooltip>
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
