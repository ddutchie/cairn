"use client";

import { Search, Trash2, ArchiveX, ArchiveRestore } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { stripMarkdown } from "@/components/notes/note-editor-utils";

interface ArchiveViewProps {
  projectId: string;
  filter: string;
  onFilterChange: (value: string) => void;
  /** Open the card detail surface. */
  onOpenCard: (cardId: string) => void;
}

/**
 * Archived-tasks view for the Kanban board — search toolbar + a grid of
 * archived cards with restore / delete-permanently actions. Extracted from
 * the inline IIFE that lived in board.tsx.
 */
export function ArchiveView({ projectId, filter, onFilterChange, onOpenCard }: ArchiveViewProps) {
  const { columns, getArchivedProjectCards, deleteCard, restoreCard } = useCairnStore(useShallow((s) => ({
    columns: s.columns,
    getArchivedProjectCards: s.getArchivedProjectCards,
    deleteCard: s.deleteCard,
    restoreCard: s.restoreCard,
  })));

  const allArchived = getArchivedProjectCards(projectId);
  const q = filter.toLowerCase();
  const filtered = q
    ? allArchived.filter((c) =>
        c.title.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q))
    : allArchived;
  const colMap = new Map(columns.map((c) => [c.id, c]));

  // Permanent deletion is irreversible — gate every path behind a confirm.
  const confirmDeleteAll = () => {
    if (filtered.length === 0) return;
    const msg = filter
      ? `Permanently delete ${filtered.length} matching archived task${filtered.length !== 1 ? "s" : ""}? This cannot be undone.`
      : `Permanently delete all ${filtered.length} archived task${filtered.length !== 1 ? "s" : ""}? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    filtered.forEach((c) => deleteCard(c.id));
  };
  const confirmDeleteOne = (cardId: string, title: string) => {
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    deleteCard(cardId);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Archive toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] flex-shrink-0">
        <div className="relative flex items-center flex-1 max-w-xs">
          <Search size={12} className="absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Search archived tasks…"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">
          {filtered.length} task{filtered.length !== 1 ? "s" : ""}
        </span>
        {filtered.length > 0 && (
          <Tooltip content={filter ? "Delete matching tasks permanently" : "Delete all archived tasks permanently"}>
            <button
              onClick={confirmDeleteAll}
              className="flex items-center gap-1.5 ml-auto px-2 py-1 rounded text-xs text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors"
            >
              <Trash2 size={11} />
              Delete all
            </button>
          </Tooltip>
        )}
      </div>
      {/* Archive card grid */}
      <div className="flex-1 overflow-y-auto p-5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <ArchiveX size={32} className="text-[var(--text-tertiary)] opacity-30" />
            <p className="text-sm text-[var(--text-tertiary)]">
              {filter ? "No archived tasks match your search" : "No archived tasks"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {filtered.map((card) => {
              const col = colMap.get(card.columnId);
              return (
                <div key={card.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] flex flex-col opacity-80 hover:opacity-100 transition-opacity">
                  {/*
                    Clickable body — opens the detail modal. Rendered as a div
                    (not a button) so the markdown preview, which may contain
                    links, isn't nested inside interactive content. Keyboard
                    activation is wired up explicitly. Clicks that originate on
                    a nested link/button are ignored so those keep working.
                  */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a, button")) return;
                      onOpenCard(card.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenCard(card.id);
                      }
                    }}
                    aria-label={`Open ${card.title}`}
                    className="flex-1 p-3 text-left flex flex-col gap-2 hover:bg-[var(--surface-2)] rounded-t-xl transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
                  >
                    <span className="text-xs font-medium text-[var(--text-primary)] leading-snug line-clamp-2">{card.title}</span>
                    {card.description && (
                      <div className="text-[0.714rem] text-[var(--text-tertiary)] line-clamp-2 whitespace-pre-wrap break-words">
                        {/* Plain-text preview — the card is clamped to 2 lines, so
                            running the full markdown pipeline (code fences, KaTeX,
                            callouts…) per archived card just to truncate it is pure
                            waste. Matches the collapsed-board-card convention. */}
                        {stripMarkdown(card.description)}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-auto pt-1">
                      {col && (
                        <span className="text-[0.643rem] px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-tertiary)]">
                          {col.name}
                        </span>
                      )}
                      {card.priority && card.priority !== "medium" && (
                        <span className={cn(
                          "text-[0.643rem] px-1.5 py-0.5 rounded",
                          card.priority === "urgent" && "bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)]",
                          card.priority === "high"   && "bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]",
                          card.priority === "low"    && "bg-[var(--surface-2)] text-[var(--text-tertiary)]",
                        )}>
                          {card.priority}
                        </span>
                      )}
                      {card.archivedAt && (
                        <span className="text-[0.643rem] text-[var(--text-tertiary)] ml-auto">
                          {new Date(card.archivedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Action row */}
                  <div className="flex items-center justify-end gap-0.5 px-2 py-1.5 border-t border-[var(--border)]">
                    <Tooltip content="Restore to board">
                      <button
                        onClick={() => restoreCard(card.id)}
                        aria-label={`Restore "${card.title}" to board`}
                        className="p-1 rounded hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
                      >
                        <ArchiveRestore size={12} aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete permanently">
                      <button
                        onClick={() => confirmDeleteOne(card.id, card.title)}
                        aria-label={`Delete "${card.title}" permanently`}
                        className="p-1 rounded hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
