"use client";

/**
 * CardContextMenu — the one right-click menu for a task card. Wrap any card
 * representation (board card, calendar chip, flow task node…) and every surface
 * offers the same actions. Built on `asChild`, so the child must forward refs
 * and spread props onto a DOM element.
 */

import { useMemo, type ReactNode } from "react";
import { format, addDays } from "date-fns";
import {
  Archive, CalendarDays, CalendarX, CheckCircle2, Copy, FolderInput, Pencil, RotateCcw, Trash2, ArrowRightLeft, Flag,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger, CONTEXT_MENU_DANGER,
} from "@/components/ui/context-menu";
import { useCairnStore } from "@/store";
import { DATE_KEY } from "@/components/calendar/calendar-utils";
import { PRIORITY_CSS_COLORS, PRIORITY_OPTIONS } from "@/lib/constants";
import type { Priority, TaskCard } from "@/types";

interface CardContextMenuProps {
  card: TaskCard;
  /** Opens the card detail (each surface owns its own detail modal). */
  onOpen?: (cardId: string) => void;
  children: ReactNode;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function CardContextMenu({ card, onOpen, children }: CardContextMenuProps) {
  const columns = useCairnStore((s) => s.columns);
  const projects = useCairnStore((s) => s.projects);
  const updateCard = useCairnStore((s) => s.updateCard);
  const moveCard = useCairnStore((s) => s.moveCard);
  const archiveCard = useCairnStore((s) => s.archiveCard);
  const deleteCard = useCairnStore((s) => s.deleteCard);
  const duplicateCard = useCairnStore((s) => s.duplicateCard);
  const moveCardToProject = useCairnStore((s) => s.moveCardToProject);

  const projectColumns = useMemo(
    () => columns.filter((c) => c.projectId === card.projectId).sort((a, b) => a.order - b.order),
    [columns, card.projectId],
  );
  const currentColumn = projectColumns.find((c) => c.id === card.columnId);
  const doneColumn = projectColumns.find((c) => c.type === "done");
  const reopenColumn =
    projectColumns.find((c) => c.type === "todo") ?? projectColumns.find((c) => c.type !== "done");
  const isDone = currentColumn?.type === "done";
  const otherProjects = projects.filter(
    (p) => p.workspaceId === card.workspaceId && p.id !== card.projectId && !p.archivedAt,
  );

  const moveTo = (columnId: string) => {
    // Read lazily: subscribing would re-render every card's menu on any card change.
    const count = useCairnStore.getState().cards.filter((c) => c.columnId === columnId && !c.archivedAt).length;
    moveCard(card.id, columnId, count);
  };
  const setDue = (date: Date | null) =>
    updateCard(card.id, { dueDate: date ? format(date, DATE_KEY) : undefined });

  const today = new Date();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        {onOpen && (
          <ContextMenuItem onSelect={() => onOpen(card.id)}>
            <Pencil size={13} /> Open card
          </ContextMenuItem>
        )}
        {isDone
          ? reopenColumn && (
              <ContextMenuItem onSelect={() => moveTo(reopenColumn.id)}>
                <RotateCcw size={13} /> Reopen
              </ContextMenuItem>
            )
          : doneColumn && (
              <ContextMenuItem onSelect={() => moveTo(doneColumn.id)}>
                <CheckCircle2 size={13} /> Mark done
              </ContextMenuItem>
            )}

        <ContextMenuSeparator />

        {projectColumns.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <ArrowRightLeft size={13} /> Move to column
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={card.columnId} onValueChange={moveTo}>
                {projectColumns.map((col) => (
                  <ContextMenuRadioItem key={col.id} value={col.id}>
                    {col.name}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Flag size={13} /> Priority
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={card.priority}
              onValueChange={(v) => updateCard(card.id, { priority: v as Priority })}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <ContextMenuRadioItem key={p} value={p}>
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: PRIORITY_CSS_COLORS[p] }}
                    aria-hidden
                  />
                  {cap(p)}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CalendarDays size={13} /> Due date
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => setDue(today)}>Today</ContextMenuItem>
            <ContextMenuItem onSelect={() => setDue(addDays(today, 1))}>Tomorrow</ContextMenuItem>
            <ContextMenuItem onSelect={() => setDue(addDays(today, 7))}>Next week</ContextMenuItem>
            {card.dueDate && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => setDue(null)}>
                  <CalendarX size={13} /> Clear due date
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {otherProjects.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput size={13} /> Move to project
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {otherProjects.map((p) => (
                <ContextMenuItem key={p.id} onSelect={() => moveCardToProject(card.id, p.id)}>
                  {p.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuItem onSelect={() => duplicateCard(card.id)}>
          <Copy size={13} /> Duplicate
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => archiveCard(card.id)}>
          <Archive size={13} /> Archive
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => deleteCard(card.id)} className={CONTEXT_MENU_DANGER}>
          <Trash2 size={13} /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
