"use client";

/**
 * WikilinkPicker — floating autocomplete for `[[Note Title]]` insertion.
 *
 * Rendered by NoteEditor when the user types `[[` or clicks the
 * "Insert link" toolbar button. Positioned relative to the editor container.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Note } from "@/types";

export interface WikilinkPickerProps {
  /** All notes available for linking (excluding the currently-open note) */
  notes: Note[];
  /** Projects list for showing project name alongside note title */
  projects: { id: string; name: string }[];
  /** Current search query (text typed after `[[`) */
  query: string;
  /** Called when the user selects a note — receives the note title */
  onSelect: (title: string) => void;
  /** Called when the picker should close without inserting */
  onClose: () => void;
  /** CSS top offset (px) for the floating panel, relative to editor container */
  top?: number;
  /** CSS left offset (px) */
  left?: number;
}

export function WikilinkPicker({
  notes,
  projects,
  query,
  onSelect,
  onClose,
  top,
  left,
}: WikilinkPickerProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  const filtered = query.trim() === ""
    ? notes.slice(0, 12)
    : notes
        .filter((n) => n.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 12);

  // Reset active index when filtered list changes
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[activeIdx]) onSelect(filtered[activeIdx].title);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, activeIdx, onSelect, onClose]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (filtered.length === 0) {
    return (
      <div
        data-wikilink-picker
        className="absolute z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-2 px-3"
        style={{ top, left }}
      >
        <p className="text-xs text-[var(--text-tertiary)]">No matching notes</p>
      </div>
    );
  }

  return (
    <div
      data-wikilink-picker
      className="absolute z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1 max-h-60 overflow-y-auto"
      style={{ top, left }}
    >
      <div ref={listRef}>
        {filtered.map((note, idx) => {
          const projectName = note.projectId ? projectMap.get(note.projectId) : undefined;
          return (
            <button
              key={note.id}
              onMouseDown={(e) => {
                // mousedown instead of click so editor doesn't lose focus
                e.preventDefault();
                onSelect(note.title);
              }}
              onMouseEnter={() => setActiveIdx(idx)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                idx === activeIdx
                  ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              )}
            >
              <FileText size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium truncate">{note.title}</span>
                {projectName && (
                  <span className="block text-[0.714rem] text-[var(--text-tertiary)] truncate">
                    {projectName}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
