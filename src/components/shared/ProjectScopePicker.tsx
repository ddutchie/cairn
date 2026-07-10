"use client";

/**
 * ProjectScopePicker — a multi-select project filter dropdown ("All projects" /
 * "N projects"), shared by the Insights, Knowledge Graph and workspace Calendar
 * views so the filter control looks and behaves identically everywhere.
 *
 * Purely controlled: it owns only its open/closed state. The caller supplies the
 * project list, the currently-selected ids (`[]` = all), and an `onChange` that
 * receives the next id array. Toggling a project adds/removes it; the
 * "All projects" row clears the selection.
 */

import { useState } from "react";
import { LayoutGrid, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

interface ProjectScopePickerProps {
  projects: Project[];
  /** Selected project ids; empty array means "all projects". */
  selectedIds: string[];
  onChange: (next: string[]) => void;
  /** Optional per-project accent dot colour lookup (defaults to accent). */
  dotColor?: (project: Project) => string;
}

export function ProjectScopePicker({ projects, selectedIds, onChange, dotColor }: ProjectScopePickerProps) {
  const [open, setOpen] = useState(false);

  const toggle = (pid: string) => {
    onChange(selectedIds.includes(pid) ? selectedIds.filter((x) => x !== pid) : [...selectedIds, pid]);
  };

  const label =
    selectedIds.length === 0 ? "All projects" : `${selectedIds.length} project${selectedIds.length > 1 ? "s" : ""}`;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
      >
        <LayoutGrid size={12} />
        {label}
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          {/* Click-away scrim so the dropdown closes on any outside click. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg z-20 py-1 max-h-64 overflow-y-auto">
            <button
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              className={cn(
                "flex items-center w-full px-3 py-1.5 text-xs transition-colors",
                selectedIds.length === 0 ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
              )}
            >
              All projects
            </button>
            <div className="h-px bg-[var(--border)] my-1" />
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                className={cn(
                  "flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors",
                  selectedIds.includes(p.id)
                    ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
                )}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: dotColor ? dotColor(p) : "var(--accent)" }}
                />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
