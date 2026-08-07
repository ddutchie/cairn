"use client";

// Card detail metadata sidebar — extracted from card-detail.tsx (P5-3).
// Contains: priority buttons, column select, assignee input, blockers list,
// due date picker, created/updated meta, and action buttons (spawn agent,
// duplicate, archive, move to project, delete).

import React, { useState } from "react";
import {
  Calendar, Lock, Trash2, Flag, User, Archive, Copy, X,
  ArrowRight, FolderInput, Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { cn, formatRelative, PRIORITY_COLORS } from "@/lib/utils";
import type { TaskCard, BoardColumn, Project, Priority } from "@/types";

const PRIORITY_OPTIONS: Priority[] = ["low", "medium", "high", "urgent"];

export function CardDetailSidebar({
  card,
  columns,
  projectColumns,
  otherProjects,
  blockerCards,
  candidateBlockers,
  doneColumnIds,
  onUpdateCard,
  onAddBlocker,
  onRemoveBlocker,
  onMoveToProject,
  onArchive,
  onDuplicate,
  onDelete,
  onSpawnAgent,
}: {
  card: TaskCard;
  columns: BoardColumn[];
  projectColumns: BoardColumn[];
  otherProjects: Project[];
  blockerCards: TaskCard[];
  candidateBlockers: TaskCard[];
  doneColumnIds: Set<string>;
  onUpdateCard: (cardId: string, patch: Partial<TaskCard>) => void;
  onAddBlocker: (cardId: string, blockerCardId: string) => Promise<{ error?: string }>;
  onRemoveBlocker: (cardId: string, blockerCardId: string) => void;
  onMoveToProject: (cardId: string, projectId: string) => void;
  onArchive: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSpawnAgent: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveToProjectOpen, setMoveToProjectOpen] = useState(false);
  const [blockerError, setBlockerError] = useState<string | null>(null);

  return (
    <div className="w-44 flex-shrink-0 border-l border-[var(--border)] px-4 py-4 space-y-4 overflow-y-auto">
      {/* Priority */}
      <div>
        <label className="block text-[0.714rem] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
          Priority
        </label>
        <div className="space-y-1">
          {PRIORITY_OPTIONS.map((p) => (
            <button
              key={p}
              onClick={() => onUpdateCard(card.id, { priority: p })}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs transition-colors",
                card.priority === p
                  ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
              )}
            >
              <Flag size={10} className={PRIORITY_COLORS[p]} fill={card.priority === p ? "currentColor" : "none"} />
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Move to column */}
      <div>
        <label htmlFor="card-detail-column" className="block text-[0.714rem] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
          <ArrowRight size={10} className="inline mr-0.5" aria-hidden="true" />Column
        </label>
        <Select
          value={card.columnId}
          options={projectColumns.map((col) => ({ value: col.id, label: col.name }))}
          onChange={(v) => onUpdateCard(card.id, { columnId: v })}
          id="card-detail-column"
          ariaLabel="Move to column"
          className="w-full"
        />
      </div>

      {/* Assignee */}
      <div>
        <label className="block text-[0.714rem] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
          <User size={10} className="inline mr-0.5" aria-hidden="true" />Assignee
        </label>
        <input
          type="text"
          defaultValue={card.assignee ?? ""}
          onBlur={(e) => onUpdateCard(card.id, { assignee: e.target.value || undefined })}
          placeholder="Unassigned"
          className="w-full px-2 py-1.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Blocked by */}
      <div>
        <label className="block text-[0.714rem] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
          <Lock size={10} className="inline mr-0.5" aria-hidden="true" />Blocked By
        </label>
        {blockerCards.length > 0 && (
          <div className="space-y-1 mb-2">
            {blockerCards.map((blocker) => {
              const blockerCol = columns.find((c) => c.id === blocker.columnId);
              const isResolved = !!blocker.archivedAt || doneColumnIds.has(blocker.columnId);
              return (
                <div
                  key={blocker.id}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-[0.714rem]",
                    isResolved
                      ? "border-[var(--border)] bg-[var(--surface-2)] opacity-50"
                      : "border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_5%,transparent)]"
                  )}
                >
                  <Lock size={9} className={isResolved ? "text-[var(--text-tertiary)]" : "text-[var(--warning)]"} />
                  <span className="flex-1 truncate text-[var(--text-secondary)]" title={blocker.title}>
                    {blocker.title}
                  </span>
                  {blockerCol && (
                    <span className="text-[var(--text-tertiary)] shrink-0">{blockerCol.name}</span>
                  )}
                  <button
                    onClick={() => onRemoveBlocker(card.id, blocker.id)}
                    className="ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors shrink-0"
                    title="Remove blocker"
                  >
                    <X size={9} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {candidateBlockers.length > 0 && (
          <Select
            value=""
            options={candidateBlockers.map((c) => {
              const col = columns.find((col) => col.id === c.columnId);
              return { value: c.id, label: col ? `${c.title} (${col.name})` : c.title };
            })}
            onChange={async (v) => {
              if (!v) return;
              setBlockerError(null);
              const result = await onAddBlocker(card.id, v);
              if (result.error) setBlockerError(result.error);
            }}
            placeholder="+ Add blocker…"
            ariaLabel="Add blocker"
            className="w-full text-[var(--text-tertiary)]"
          />
        )}
        {blockerError && (
          <p className="text-[0.714rem] text-[var(--danger)] mt-1">{blockerError}</p>
        )}
        {blockerCards.length === 0 && candidateBlockers.length === 0 && (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">No other tasks in this project</p>
        )}
      </div>

      {/* Due date */}
      <div>
        <label className="block text-[0.714rem] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
          <Calendar size={10} className="inline mr-0.5" aria-hidden="true" />Due Date
        </label>
        <DatePicker
          value={card.dueDate}
          onChange={(v) => onUpdateCard(card.id, { dueDate: v })}
        />
      </div>

      {/* Meta */}
      <div className="pt-2 border-t border-[var(--border)] space-y-1">
        <div className="text-[0.714rem] text-[var(--text-tertiary)]">
          Created {formatRelative(card.createdAt)}
        </div>
        <div className="text-[0.714rem] text-[var(--text-tertiary)]">
          Updated {formatRelative(card.updatedAt)}
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 space-y-1.5">
        <Button
          variant="ghost" size="xs"
          className="w-full justify-start text-[var(--accent)] hover:bg-[var(--accent-dim)]"
          onClick={onSpawnAgent}
        >
          <Terminal size={10} /> Spawn Agent
        </Button>
        <Button
          variant="ghost" size="xs"
          className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          onClick={onDuplicate}
        >
          <Copy size={10} /> Duplicate
        </Button>
        <Button
          variant="ghost" size="xs"
          className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          onClick={onArchive}
        >
          <Archive size={10} /> Archive
        </Button>
        {otherProjects.length > 0 && (
          <div>
            <Button
              variant="ghost" size="xs"
              className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              onClick={() => setMoveToProjectOpen((o) => !o)}
            >
              <FolderInput size={10} /> Move to project
            </Button>
            {moveToProjectOpen && (
              <div className="mt-1 space-y-0.5 pl-1 border-l border-[var(--border)]">
                {otherProjects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onMoveToProject(card.id, p.id)}
                    className="w-full text-left px-2 py-1 rounded text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors truncate"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="border-t border-[var(--border)] pt-1.5">
          {confirmDelete ? (
            <div className="space-y-1">
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">Are you sure?</p>
              <div className="flex gap-1">
                <Button variant="danger" size="xs" onClick={onDelete}>Delete</Button>
                <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost" size="xs"
              className="w-full justify-start text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={10} /> Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
