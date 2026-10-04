"use client";

import React, { useState, useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, Calendar, ChevronDown, ChevronUp, FileText, Lock, Pencil, Trash2, User } from "lucide-react";
import { cn, formatDate, getDueDateStatus, parseIsoLocal } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { OverflowPill } from "@/components/ui/overflow-pill";
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
import { CardAgentBadge } from "./card-agent-badge";

interface KanbanCardProps {
  card: TaskCard;
  onOpenCard: (cardId: string) => void;
  isDragging?: boolean;
}

function isExpandable(description: string | undefined): boolean {
  if (!description?.trim()) return false;
  const lines = description.split("\n").filter((l) => l.trim()).length;
  return lines > 2 || description.length > 140;
}

/**
 * Memoized inner content of a card. Split out from KanbanCard because
 * useSortable re-renders the card on EVERY dnd-kit context change during a drag
 * (pointer move, over change, etc.) — regardless of React.memo on the card,
 * since that re-render originates from the hook's context subscription, not
 * props. With ~dozens of cards this reconciles the whole board every frame and
 * hitches. CardContent depends only on `card` + display state, so React reuses
 * this element tree across those context-driven re-renders (nothing here
 * changed), avoiding the expensive markdown/tag/tooltip reconciliation.
 */
interface CardContentProps {
  card: TaskCard;
  expanded: boolean;
  canExpand: boolean;
  descRef: React.RefObject<HTMLDivElement | null>;
  onToggleExpand: (e: React.MouseEvent | React.PointerEvent) => void;
}

/** Shared state-chip style: compact, never wraps internally. */
const chip = "inline-flex items-center gap-1 whitespace-nowrap text-[0.714rem] font-medium rounded px-1.5 py-0.5";

/** "Oct 6", or "Oct 6, 2027" when not in the current year. Full date lives in the title tooltip. */
function shortDate(iso: string): string {
  const d = parseIsoLocal(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

const CardContent = React.memo(function CardContent({ card, expanded, canExpand, descRef, onToggleExpand }: CardContentProps) {
  const getTagById = useCairnStore((s) => s.getTagById);
  const isDone = useCairnStore((s) => s.columns.find((c) => c.id === card.columnId)?.type === "done");
  const isBlocked = (card.blockedByIds ?? []).length > 0;
  const allTags = card.tagIds.map((id) => getTagById(id)).filter(Boolean);
  const tags = allTags.slice(0, 3);
  const extraTags = allTags.slice(3);
  const extraTagCount = extraTags.length;
  const description = card.description?.trim() || "";

  return (
    <>
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

        {/* Description — plain-text preview when collapsed, full markdown only
            when expanded. Rendering the heavy remark/rehype/KaTeX pipeline for
            every card up front blocked the Board mount (~350ms INP); the
            collapsed card only shows ~2 truncated lines anyway, where full
            markdown formatting adds no value. */}
        {description && (
          <div
            ref={descRef}
            className={cn(
              "text-[0.786rem] text-[var(--text-tertiary)] leading-relaxed",
              "[&_.prose-cairn]:!py-0 [&_.prose-cairn_p]:!my-0",
              expanded ? "max-h-80 overflow-y-auto pr-1" : "max-h-10 overflow-hidden"
            )}
          >
            {expanded ? (
              <NoteMarkdownPreview content={description} className="!px-0 !py-0" />
            ) : (
              <p className="whitespace-pre-wrap break-words line-clamp-2 m-0">{description}</p>
            )}
          </div>
        )}

        {/* Expand toggle */}
        {canExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            onPointerDown={(e) => e.stopPropagation()}
            className="self-start flex items-center gap-0.5 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors -mt-1"
            aria-label={expanded ? "Collapse description" : "Expand description"}
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {expanded ? "Less" : "More"}
          </button>
        )}

        {/* State — blocker / due / live agent. Each chip stays on one line; the
            row wraps so narrow columns stack chips instead of breaking text.
            empty:hidden collapses it when there's nothing to show (the agent
            badge renders null when no session is running). */}
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          {isBlocked && (
            <span className={cn(chip, "text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]")}>
              <Lock size={10} />
              {(card.blockedByIds ?? []).length} blocker{(card.blockedByIds ?? []).length !== 1 ? "s" : ""}
            </span>
          )}
          {card.dueDate && (() => {
            // A completed task is never "overdue" or "due today" — its due
            // date has been met, so render it plainly without emphasis.
            const status = isDone ? "upcoming" : getDueDateStatus(card.dueDate);
            return (
              <span
                title={`Due ${formatDate(card.dueDate)}`}
                className={cn(
                  chip,
                  status === "overdue" && "text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]",
                  status === "today" && "text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]",
                  status === "upcoming" && "text-[var(--text-tertiary)] bg-[var(--surface)]",
                )}
              >
                <Calendar size={10} />
                {status === "overdue" ? `Overdue · ${shortDate(card.dueDate)}` :
                 status === "today" ? "Due today" :
                 shortDate(card.dueDate)}
              </span>
            );
          })()}
          <CardAgentBadge cardId={card.id} />
        </div>

        {/* Meta — assignee / linked notes */}
        {(card.assignee || card.linkedNoteIds.length > 0) && (
          <div className="flex items-center gap-2 pt-1.5 border-t border-[var(--border-subtle)] min-w-0">
            {card.assignee && (
              <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] min-w-0" title={card.assignee}>
                <User size={10} className="flex-shrink-0" />
                <span className="truncate">{card.assignee}</span>
              </span>
            )}
            {card.linkedNoteIds.length > 0 && (
              <span className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] ml-auto flex-shrink-0" title={`${card.linkedNoteIds.length} linked note${card.linkedNoteIds.length === 1 ? "" : "s"}`}>
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
              <OverflowPill count={extraTagCount} names={extraTags.map((t) => t?.name ?? "")} />
            )}
          </div>
        )}
      </div>
    </>
  );
});

export const KanbanCard = React.memo(function KanbanCard({ card, onOpenCard, isDragging = false }: KanbanCardProps) {
  const archiveCard = useCairnStore((s) => s.archiveCard);
  const deleteCard  = useCairnStore((s) => s.deleteCard);

  const [expanded, setExpanded] = useState(false);
  const descRef = React.useRef<HTMLDivElement>(null);

  // Stable click handler bound to this card's id — passing a fresh inline
  // closure from the column would break the surrounding React.memo and
  // re-render every card when the column re-renders (e.g. on drag hover).
  const handleOpen = React.useCallback(() => onOpenCard(card.id), [onOpenCard, card.id]);

  const toggleExpanded = React.useCallback((e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    setExpanded((v) => {
      const next = !v;
      if (!next && descRef.current) descRef.current.scrollTop = 0;
      return next;
    });
  }, []);

  const canExpand = isExpandable(card.description);

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

  const transformStr = CSS.Transform.toString(transform);
  const dimmed = isDragging || isSortableDragging;

  // useSortable re-renders this card on EVERY dnd-kit context tick during a
  // drag, even when nothing about *this* card changed. Memoizing the element
  // tree means non-dragging cards create zero new JSX elements per tick (their
  // transform stays null / unchanged) — only the actively dragging card, whose
  // transformStr changes, rebuilds. This is the dominant per-frame cost the
  // profiler attributed to react-jsx-dev-runtime createTask.
  return useMemo(() => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{ transform: transformStr, transition, touchAction: "none" }}
          {...attributes}
          {...listeners}
          onClick={handleOpen}
          className={cn(
            "group relative rounded-lg border bg-[var(--surface-2)] p-3 cursor-pointer overflow-hidden",
            "border-[var(--border)] hover:border-[var(--accent)]/40",
            "transition-all duration-150 select-none",
            "hover:shadow-md hover:shadow-black/20",
            dimmed && "opacity-40 rotate-1"
          )}
        >
          <CardContent
            card={card}
            expanded={expanded}
            canExpand={canExpand}
            descRef={descRef}
            onToggleExpand={toggleExpanded}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onSelect={handleOpen}>
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
  ), [
    card, expanded, canExpand, transformStr, transition, dimmed,
    setNodeRef, attributes, listeners, handleOpen, toggleExpanded,
    archiveCard, deleteCard,
  ]);
});
