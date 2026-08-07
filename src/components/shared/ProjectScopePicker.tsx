"use client";

/**
 * ProjectScopePicker — a multi-select project filter dropdown ("All projects" /
 * "N projects"), shared by the Insights, Knowledge Graph and workspace Calendar
 * views so the filter control looks and behaves identically everywhere.
 *
 * Built on the shared Radix dropdown primitives so it gets the same floating
 * panel, portal, keyboard handling, and theming as every other dropdown in the
 * app. Purely controlled: it owns only its open/closed state. The caller
 * supplies the project list, the currently-selected ids (`[]` = all), and an
 * `onChange` that receives the next id array. Toggling a project adds/removes
 * it (the menu stays open so several can be picked in one pass); the
 * "All projects" row clears the selection and closes the menu.
 */

import { LayoutGrid, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
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
  const toggle = (pid: string) => {
    onChange(selectedIds.includes(pid) ? selectedIds.filter((x) => x !== pid) : [...selectedIds, pid]);
  };

  const label =
    selectedIds.length === 0 ? "All projects" : `${selectedIds.length} project${selectedIds.length > 1 ? "s" : ""}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Project filter"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <LayoutGrid size={12} />
          {label}
          <ChevronDown size={11} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52 max-h-64 overflow-y-auto">
        <DropdownMenuItem
          onSelect={() => onChange([])}
          className={cn(
            "w-full",
            selectedIds.length === 0 ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-secondary)]"
          )}
        >
          All projects
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {projects.map((p) => {
          const active = selectedIds.includes(p.id);
          return (
            <DropdownMenuItem
              key={p.id}
              onSelect={(e) => {
                e.preventDefault();
                toggle(p.id);
              }}
              className={cn(
                "w-full",
                active ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-secondary)]"
              )}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: dotColor ? dotColor(p) : "var(--accent)" }}
              />
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
