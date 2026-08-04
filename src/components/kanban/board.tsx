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
  pointerWithin,
  closestCorners,
  type CollisionDetection,
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
import { PRIORITY_OPTIONS, PRIORITY_CSS_COLORS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { ArchiveView } from "./archive-view";
import { KanbanColumn } from "./column";
import { KanbanCard } from "./card";
import { CardDetailModal } from "./card-detail";
import type { TaskCard, BoardColumn, Priority } from "@/types";
import { getZoneHit, resolveCardDrop } from "./board-dnd";
import { setActiveCrossProjectDrag } from "@/lib/cross-project-dnd";

/**
 * Cross-project drag bridge (board → project sidebar).
 *
 * The board uses dnd-kit (pointer sensor), while the leftmost project sidebar
 * uses native drop targets marked with `data-project-drop-id`. dnd-kit's `over`
 * is null outside its DndContext, so we hit-test the raw pointer position
 * against those sidebar rows via the DOM.
 */
const PROJECT_DROP_ATTR = "data-project-drop-id";
const SIDEBAR_DROP_CLASS = "cairn-cross-project-drop-active";

/** Returns the project id of the sidebar row under (x, y), or null. */
function projectDropTargetAt(x: number, y: number): string | null {
  if (typeof document === "undefined") return null;
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const id = el.getAttribute?.(PROJECT_DROP_ATTR);
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

/** Highlight the sidebar row under the pointer during a cross-project drag. */
function updateSidebarDropHighlight(x: number, y: number, sourceProjectId: string): void {
  if (typeof document === "undefined") return;
  const target = projectDropTargetAt(x, y);
  document.querySelectorAll(`.${SIDEBAR_DROP_CLASS}`).forEach((n) => n.classList.remove(SIDEBAR_DROP_CLASS));
  if (!target || target === sourceProjectId) return;
  const row = document.querySelector(`[${PROJECT_DROP_ATTR}="${target}"]`);
  row?.classList.add(SIDEBAR_DROP_CLASS);
}

function clearSidebarDropHighlight(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll(`.${SIDEBAR_DROP_CLASS}`).forEach((n) => n.classList.remove(SIDEBAR_DROP_CLASS));
}

/**
 * Collision detection for the board.
 *
 * We prefer `pointerWithin` because it resolves the drop target from the real
 * pointer position rather than the dragged item's *translated rect*. dnd-kit's
 * translated-rect tracking does not account for auto-scroll of the horizontal
 * board container (see the livePointer note below), which made rect-based
 * strategies like closestCorners resolve `over` to the wrong / furthest columns
 * while the board scrolled. `pointerWithin` sidesteps that entirely.
 *
 * When the pointer sits in a gap between columns (inside no droppable),
 * pointerWithin returns nothing — we fall back to closestCorners so a drop
 * still lands on the nearest column instead of being dropped.
 */
const boardCollision: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  return closestCorners(args);
};

interface BoardColumnItemProps {
  column: BoardColumn;
  cards: TaskCard[];
  archivedCards: TaskCard[];
  allCardsCount: number;
  activeProjectId: string;
  isDragOver: boolean;
  isColumnDragging: boolean;
  isHighlighted: boolean;
  onOpenCard: (cardId: string) => void;
  createCard: (columnId: string, projectId: string, title: string, extras?: { dueDate?: string; assignee?: string }) => void;
  updateColumn: (columnId: string, patch: { name?: string; cardLimit?: number }) => void;
  deleteColumn: (columnId: string) => void;
  restoreCard: (cardId: string) => void;
  archiveAllDoneCards: (columnId: string) => void;
}

/**
 * Per-column wrapper that memoizes the column and stabilizes its callbacks with
 * useCallback (keyed to the column id). Because the board re-renders on every
 * drag-hover (`overId` change), passing inline closures + fresh arrays straight
 * to KanbanColumn would re-render *every* column each pointer move → hitches.
 * With stable props, React.memo(KanbanColumn) only re-renders the column whose
 * isDragOver/isColumnDragging/isHighlighted/cards actually changed.
 */
const BoardColumnItem = React.memo(function BoardColumnItem({
  column, cards, archivedCards, allCardsCount, activeProjectId,
  isDragOver, isColumnDragging, isHighlighted,
  onOpenCard, createCard, updateColumn, deleteColumn, restoreCard, archiveAllDoneCards,
}: BoardColumnItemProps) {
  const columnId = column.id;
  const handleAddCard = useCallback(
    (data: { title: string; dueDate?: string; assignee?: string }) =>
      createCard(columnId, activeProjectId, data.title, { dueDate: data.dueDate, assignee: data.assignee }),
    [createCard, columnId, activeProjectId]
  );
  const handleRename   = useCallback((name: string) => updateColumn(columnId, { name }), [updateColumn, columnId]);
  const handleSetLimit = useCallback((limit: number | null) => updateColumn(columnId, { cardLimit: limit ?? undefined }), [updateColumn, columnId]);
  const handleDelete   = useCallback(() => deleteColumn(columnId), [deleteColumn, columnId]);
  const handleRestore  = useCallback((cardId: string) => restoreCard(cardId), [restoreCard]);
  const handleArchiveAllDone = useCallback(() => archiveAllDoneCards(columnId), [archiveAllDoneCards, columnId]);

  return (
    <KanbanColumn
      column={column}
      cards={cards}
      archivedCards={archivedCards}
      onCardClick={onOpenCard}
      onAddCard={handleAddCard}
      onRename={handleRename}
      onSetLimit={handleSetLimit}
      onDelete={handleDelete}
      onRestoreCard={handleRestore}
      onArchiveAllDone={column.type === "done" && allCardsCount > 0 ? handleArchiveAllDone : undefined}
      isDragOver={isDragOver}
      isColumnDragging={isColumnDragging}
      isHighlighted={isHighlighted}
    />
  );
}, arePropsEqual);

/** Shallow-equal check for a card list by element reference (store returns a
 *  fresh array each call, but unchanged card objects keep their identity). */
function cardsEqual(a: TaskCard[], b: TaskCard[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function arePropsEqual(prev: BoardColumnItemProps, next: BoardColumnItemProps): boolean {
  return (
    prev.column === next.column &&
    prev.activeProjectId === next.activeProjectId &&
    prev.allCardsCount === next.allCardsCount &&
    prev.isDragOver === next.isDragOver &&
    prev.isColumnDragging === next.isColumnDragging &&
    prev.isHighlighted === next.isHighlighted &&
    prev.onOpenCard === next.onOpenCard &&
    prev.createCard === next.createCard &&
    prev.updateColumn === next.updateColumn &&
    prev.deleteColumn === next.deleteColumn &&
    prev.restoreCard === next.restoreCard &&
    prev.archiveAllDoneCards === next.archiveAllDoneCards &&
    cardsEqual(prev.cards, next.cards) &&
    cardsEqual(prev.archivedCards, next.archivedCards)
  );
}

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
    moveCardToProject,
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
    moveCardToProject:        s.moveCardToProject,
  })));

  const [activeCard, setActiveCard]         = useState<TaskCard | null>(null);
  const [activeColumn, setActiveColumn]     = useState<BoardColumn | null>(null);
  const [detailCardId, setDetailCardId]     = useState<string | null>(null);
  const [overId, setOverId]                 = useState<string | null>(null);
  const [deleteFlashing, setDeleteFlashing] = useState(false);

  // Board filters — priority toggles + free-text search (⌘F focuses search)
  const [boardFilter, setBoardFilter]       = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Priority[]>([]);
  const filterInputRef                      = useRef<HTMLInputElement>(null);

  // Archive view
  const [archiveViewOpen, setArchiveViewOpen] = useState(false);
  const [archiveFilter, setArchiveFilter]     = useState("");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") {
        e.preventDefault();
        setTimeout(() => { filterInputRef.current?.focus(); filterInputRef.current?.select(); }, 0);
      }
      if (e.key === "Escape") {
        setBoardFilter("");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const columns = activeProjectId ? getProjectColumns(activeProjectId) : [];

  function togglePriority(p: Priority) {
    setPriorityFilter((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
  }

  /** True when a card passes the active priority toggles AND the search query. */
  const matchesFilters = useCallback((c: TaskCard) => {
    if (priorityFilter.length > 0 && !priorityFilter.includes(c.priority)) return false;
    if (boardFilter) {
      const q = boardFilter.toLowerCase();
      return c.title.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q);
    }
    return true;
  }, [priorityFilter, boardFilter]);

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
    else if (card) {
      setActiveCard(card);
      // Expose the drag to the project sidebar so it can be dropped onto another
      // project (cross-project move preserving column state).
      setActiveCrossProjectDrag({
        kind: "card",
        cardId: card.id,
        sourceProjectId: card.projectId,
        label: card.title,
      });
    }
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
    // Sidebar project-row highlighting is driven solely by the pointermove/
    // touchmove listeners in the activeCard effect (they have accurate,
    // auto-scroll-aware coordinates), so we don't duplicate it here.
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
    const rawOverId = event.over?.id as string | undefined;
    if (!rawOverId) { setOverId(null); return; }
    // `over` may be a column id or a card id (pointerWithin returns the card
    // when hovering one). Normalise to the containing column id so the column
    // highlight (isDragOver === column.id) works in both cases.
    const isColumn = columns.some((c) => c.id === rawOverId);
    if (isColumn) { setOverId(rawOverId); return; }
    const parentColumn = columns.find((c) =>
      getColumnCards(c.id).some((card) => card.id === rawOverId)
    );
    setOverId(parentColumn?.id ?? rawOverId);
  }

  function handleDragCancel() {
    setActiveCard(null);
    setActiveColumn(null);
    setOverId(null);
    hoverZoneRef.current = null;
    applyZoneHighlight(null);
    livePointer.current = null;
    clearSidebarDropHighlight();
    setActiveCrossProjectDrag(null);
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
        clearSidebarDropHighlight();
        setActiveCrossProjectDrag(null);
        archiveCard(draggedCard.id);
        return;
      }
      if (zone === "delete") {
        setDeleteFlashing(true);
        applyZoneHighlight("delete");
        clearSidebarDropHighlight();
        setActiveCrossProjectDrag(null);
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

    // ── Cross-project drop ────────────────────────────────────────────────
    // dnd-kit's `over` is null when the pointer is released outside the board's
    // DndContext (e.g. over the leftmost project sidebar). Hit-test the last
    // pointer position for a project row and, if it belongs to a DIFFERENT
    // project, move the card there (preserving its column state).
    if (draggedCard) {
      const targetProjectId = projectDropTargetAt(dropX, dropY);
      if (targetProjectId && targetProjectId !== draggedCard.projectId) {
        livePointer.current = null;
        clearSidebarDropHighlight();
        setActiveCrossProjectDrag(null);
        moveCardToProject(draggedCard.id, targetProjectId);
        return;
      }
    }
    clearSidebarDropHighlight();
    setActiveCrossProjectDrag(null);
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
    const sourceProjectId = activeCard.projectId;
    function onPointerMove(e: PointerEvent) {
      livePointer.current = { x: e.clientX, y: e.clientY };
      updateSidebarDropHighlight(e.clientX, e.clientY, sourceProjectId);
    }
    function onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (t) {
        livePointer.current = { x: t.clientX, y: t.clientY };
        updateSidebarDropHighlight(t.clientX, t.clientY, sourceProjectId);
      }
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("touchmove", onTouchMove);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchmove", onTouchMove);
      clearSidebarDropHighlight();
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
        collisionDetection={boardCollision}
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

          {/* Filter toolbar — priority toggles + search (always visible, KG-style) */}
          {!archiveViewOpen && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 flex-wrap">
              <div className="flex items-center gap-1">
                {PRIORITY_OPTIONS.map((p) => (
                  <PriorityChip key={p} p={p} active={priorityFilter.includes(p)} onClick={() => togglePriority(p)} />
                ))}
              </div>
              <div className="w-px h-5 bg-[var(--border)]" />
              <div className="relative flex items-center flex-1 max-w-xs">
                <Search size={12} className="absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
                <input
                  ref={filterInputRef}
                  type="text"
                  value={boardFilter}
                  onChange={(e) => setBoardFilter(e.target.value)}
                  placeholder="Search cards…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              {(boardFilter || priorityFilter.length > 0) && (() => {
                const matchCount = columns.reduce((n, col) =>
                  n + getColumnCards(col.id).filter(matchesFilters).length, 0);
                return (
                  <>
                    <span className="text-xs text-[var(--text-tertiary)]">
                      {matchCount} match{matchCount === 1 ? "" : "es"}
                    </span>
                    <button
                      onClick={() => { setBoardFilter(""); setPriorityFilter([]); }}
                      className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                      aria-label="Clear filters"
                    >
                      <X size={13} />
                    </button>
                  </>
                );
              })()}
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
                const filteredCards = allCards.filter(matchesFilters);
                return (
                  <div key={column.id} ref={(el) => { columnRefs.current[column.id] = el; }} className="flex-shrink-0 self-stretch">
                    <BoardColumnItem
                      column={column}
                      cards={filteredCards}
                      archivedCards={getArchivedColumnCards(column.id)}
                      allCardsCount={allCards.length}
                      activeProjectId={activeProjectId}
                      isDragOver={overId === column.id}
                      isColumnDragging={activeColumn?.id === column.id}
                      isHighlighted={highlightedColumnId === column.id}
                      onOpenCard={setDetailCardId}
                      createCard={createCard}
                      updateColumn={updateColumn}
                      deleteColumn={deleteColumn}
                      restoreCard={restoreCard}
                      archiveAllDoneCards={archiveAllDoneCards}
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
              <KanbanCard card={activeCard} isDragging onOpenCard={() => {}} />
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

/** Priority filter toggle chip — mirrors the Knowledge Graph's node-type chips. */
function PriorityChip({ p, active, onClick }: { p: Priority; active: boolean; onClick: () => void }) {
  const color = PRIORITY_CSS_COLORS[p];
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-[0.786rem] capitalize transition-colors border",
        active ? "border-transparent" : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50"
      )}
      style={active ? {
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
      } : undefined}
    >
      <span className="rounded-full flex-shrink-0" style={{ width: 8, height: 8, background: active ? color : "currentColor" }} />
      {p}
    </button>
  );
}
