"use client";

import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { NoteMarkdownPreview } from "./NoteMarkdownPreview";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";

interface MDPreviewPanelProps {
  text: string;
  onDismiss: () => void;
  /** Header label; defaults to "Preview". Used to show e.g. "table preview". */
  label?: string;
}

type PreviewSize = "s" | "m" | "l";
const PREVIEW_SIZE_KEY = "note-preview-size";
// Panel body max-height per size. The panel scrolls internally beyond this.
const SIZE_MAX_HEIGHT: Record<PreviewSize, string> = {
  s: "15vh",
  m: "30vh",
  l: "50vh",
};
// Type scale per size (drives --preview-scale; see globals.css). Small also
// gets denser text; medium/large keep full size and just grow taller.
const SIZE_SCALE: Record<PreviewSize, number> = {
  s: 0.82,
  m: 1,
  l: 1,
};
const SIZES: PreviewSize[] = ["s", "m", "l"];

export function MDPreviewPanel({ text, onDismiss, label = "Preview" }: MDPreviewPanelProps) {
  const [size, setSizeState] = useState<PreviewSize>(
    () => storage.get<PreviewSize>(PREVIEW_SIZE_KEY) ?? "m",
  );
  const setSize = (next: PreviewSize) => {
    setSizeState(next);
    storage.set(PREVIEW_SIZE_KEY, next);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onDismiss(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      data-md-preview-portal
      className="flex-shrink-0 border-t border-[var(--border)] animate-fade-in"
      style={{ background: "var(--surface)", ["--preview-scale" as string]: SIZE_SCALE[size] }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--surface-2)" }}>
        <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">{label}</span>
        <div className="flex items-center gap-1">
          {/* Size toggle — shrink/grow the preview panel */}
          <div className="flex items-center rounded bg-[var(--surface)] p-0.5" role="group" aria-label="Preview size">
            {SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                aria-label={`${s.toUpperCase()} preview`}
                aria-pressed={size === s}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[0.65rem] font-medium uppercase transition-colors",
                  size === s
                    ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={onDismiss}
            aria-label="Close preview"
            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      </div>
      <div style={{ maxHeight: SIZE_MAX_HEIGHT[size] }} className="overflow-y-auto">
        <NoteMarkdownPreview content={text} className="!py-3" />
      </div>
    </div>
  );
}
