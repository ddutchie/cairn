"use client";

import { useState } from "react";
import { SlidersHorizontal, Bookmark, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import {
  UNASSIGNED,
  activeCriteriaCount,
  isFilterActive,
  type BoardFilter,
  type DueFilter,
} from "@/lib/board-filters";
import type { Tag } from "@/types";

const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "week", label: "Due within 7 days" },
  { value: "none", label: "No due date" },
];

const triggerClass = (active: boolean) =>
  cn(
    "flex items-center gap-1.5 px-2 py-1 rounded text-[0.786rem] border transition-colors",
    active
      ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
      : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
  );

/** Assignee / tag / due / blocked criteria in one menu. */
export function BoardFilterMenu({
  filter,
  onChange,
  assignees,
  tags,
}: {
  filter: BoardFilter;
  onChange: (next: BoardFilter) => void;
  assignees: string[];
  tags: Tag[];
}) {
  const count = activeCriteriaCount(filter);
  const set = (patch: Partial<BoardFilter>) => onChange({ ...filter, ...patch });
  // Keep the menu open while toggling several options.
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={triggerClass(count > 0)} aria-label="More filters">
          <SlidersHorizontal size={11} />
          Filters{count > 0 ? ` · ${count}` : ""}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto min-w-[200px]">
        <DropdownMenuLabel>Assignee</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={filter.assignee === UNASSIGNED}
          onSelect={keepOpen}
          onCheckedChange={(on) => set({ assignee: on ? UNASSIGNED : null })}
        >
          Unassigned
        </DropdownMenuCheckboxItem>
        {assignees.map((a) => (
          <DropdownMenuCheckboxItem
            key={a}
            checked={filter.assignee === a}
            onSelect={keepOpen}
            onCheckedChange={(on) => set({ assignee: on ? a : null })}
          >
            {a}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Due</DropdownMenuLabel>
        {DUE_OPTIONS.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={filter.due === o.value}
            onSelect={keepOpen}
            onCheckedChange={(on) => set({ due: on ? o.value : "any" })}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filter.blockedOnly}
          onSelect={keepOpen}
          onCheckedChange={(on) => set({ blockedOnly: on === true })}
        >
          Blocked by an open card
        </DropdownMenuCheckboxItem>

        {tags.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Tags (any of)</DropdownMenuLabel>
            {tags.map((t) => (
              <DropdownMenuCheckboxItem
                key={t.id}
                checked={filter.tagIds.includes(t.id)}
                onSelect={keepOpen}
                onCheckedChange={(on) =>
                  set({ tagIds: on ? [...filter.tagIds, t.id] : filter.tagIds.filter((x) => x !== t.id) })
                }
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color }} />
                {t.name}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Saved views for this project: apply, save current, delete. */
export function BoardViewsMenu({
  projectId,
  filter,
  onApply,
}: {
  projectId: string;
  filter: BoardFilter;
  onApply: (next: BoardFilter) => void;
}) {
  const { views, saveBoardView, deleteBoardView } = useCairnStore(useShallow((s) => ({
    views: s.boardViews[projectId],
    saveBoardView: s.saveBoardView,
    deleteBoardView: s.deleteBoardView,
  })));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const list = views ?? [];
  const canSave = isFilterActive(filter);

  const save = () => {
    if (!name.trim()) return;
    saveBoardView(projectId, name, filter);
    setName("");
    setNaming(false);
  };

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) { setNaming(false); setName(""); } }}>
      <DropdownMenuTrigger asChild>
        <button className={triggerClass(false)} aria-label="Saved views">
          <Bookmark size={11} />
          Views{list.length > 0 ? ` · ${list.length}` : ""}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {list.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">No saved views yet.</div>
        )}
        {list.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => onApply(v.filter)} className="group">
            <span className="flex-1 truncate">{v.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); deleteBoardView(projectId, v.id); }}
              className="opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)]"
              aria-label={`Delete view ${v.name}`}
            >
              <Trash2 size={11} />
            </button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {naming ? (
          <div className="px-2 py-1.5 flex items-center gap-1.5" onKeyDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              placeholder="View name"
              className="flex-1 min-w-0 px-2 py-1 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={save}
              disabled={!name.trim()}
              className="px-2 py-1 text-xs rounded-md bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-40"
            >
              Save
            </button>
          </div>
        ) : (
          <DropdownMenuItem
            disabled={!canSave}
            onSelect={(e) => { e.preventDefault(); setNaming(true); }}
            className={cn(!canSave && "opacity-50 cursor-default")}
          >
            Save current filters as view…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
