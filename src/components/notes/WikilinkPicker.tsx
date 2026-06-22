"use client";

/**
 * WikilinkPicker — floating autocomplete for `[[Note Title]]` insertion.
 *
 * Rendered into a portal on document.body with `position: fixed` so scroll
 * inside the editor container does not affect placement. The picker flips
 * above the cursor when there is insufficient space below, and is always
 * clamped to the viewport on all four sides.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Note } from "@/types";

const PICKER_WIDTH  = 288; // w-72
const PICKER_HEIGHT = 240; // max-h-60
const GAP = 6;
const VIEWPORT_PAD = 8;

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
  /**
   * Viewport-relative position of the cursor (from `coordsAtPos`).
   * The picker positions itself near this point, flipping above/below
   * as needed to stay on screen.
   */
  anchorRect: { top: number; bottom: number; left: number };
}

export function WikilinkPicker({
  notes,
  projects,
  query,
  onSelect,
  onClose,
  anchorRect,
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
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setActiveIdx(0); }, [query]);

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
    [filtered, activeIdx, onSelect, onClose],
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

  // ── Position calculation ─────────────────────────────────────────────────
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Flip above cursor when there isn't enough space below
  const spaceBelow = vh - anchorRect.bottom - GAP - VIEWPORT_PAD;
  const spaceAbove = anchorRect.top       - GAP - VIEWPORT_PAD;
  const openUpward = spaceBelow < PICKER_HEIGHT && spaceAbove > spaceBelow;

  const top = openUpward
    ? anchorRect.top  - PICKER_HEIGHT - GAP
    : anchorRect.bottom + GAP;

  // Clamp left so picker never overflows viewport edges
  const left = Math.min(
    Math.max(anchorRect.left, VIEWPORT_PAD),
    vw - PICKER_WIDTH - VIEWPORT_PAD,
  );

  // ── Render ───────────────────────────────────────────────────────────────
  const content = (
    <div
      data-wikilink-picker
      data-dialog-portal
      className="fixed z-[9999] w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl py-1 overflow-y-auto"
      style={{ top, left, maxHeight: PICKER_HEIGHT }}
    >
      {filtered.length === 0 ? (
        <p className="text-xs text-[var(--text-tertiary)] px-3 py-2">No matching notes</p>
      ) : (
        <div ref={listRef}>
          {filtered.map((note, idx) => {
            const projectName = note.projectId ? projectMap.get(note.projectId) : undefined;
            return (
              <button
                key={note.id}
                onMouseDown={(e) => {
                  // mousedown so editor doesn't lose focus before onSelect fires
                  e.preventDefault();
                  onSelect(note.title);
                }}
                onMouseEnter={() => setActiveIdx(idx)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                  idx === activeIdx
                    ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
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
      )}
    </div>
  );

  return createPortal(content, document.body);
}
