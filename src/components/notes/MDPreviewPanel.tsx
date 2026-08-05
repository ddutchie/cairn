"use client";

import React, { useEffect } from "react";
import { X } from "lucide-react";
import { NoteMarkdownPreview } from "./NoteMarkdownPreview";

interface MDPreviewPanelProps {
  text: string;
  onDismiss: () => void;
  /** Header label; defaults to "Preview". Used to show e.g. "table preview". */
  label?: string;
}

export function MDPreviewPanel({ text, onDismiss, label = "Preview" }: MDPreviewPanelProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onDismiss(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      data-md-preview-portal
      className="flex-shrink-0 border-t border-[var(--border)] animate-fade-in"
      style={{ background: "var(--surface)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--surface-2)" }}>
        <span className="text-[0.714rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">{label}</span>
        <button
          onClick={onDismiss}
          aria-label="Close preview"
          className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
        >
          <X size={11} />
        </button>
      </div>
      <div style={{ maxHeight: "30vh" }} className="overflow-y-auto">
        <NoteMarkdownPreview content={text} className="!py-3" />
      </div>
    </div>
  );
}
