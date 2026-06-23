"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, Brain } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

interface ThinkingPanelProps {
  /** Reasoning text. When non-empty the panel renders; when empty it's null. */
  text: string;
  /**
   * If true, the panel starts expanded and auto-collapses as soon as
   * `companionContent` begins streaming in. If false, the panel renders
   * collapsed by default (used for persisted messages from history).
   */
  streaming?: boolean;
  /** Live content text — used to detect "answer has started" for auto-collapse. */
  companionContent?: string;
}

/**
 * Collapsible "Thinking" panel for model reasoning text.
 *
 * Behaviour:
 *  - Streaming: expanded by default so the user sees the reasoning flow live.
 *    Auto-collapses the instant the first content token arrives.
 *    User can re-expand at any time.
 *  - Final/persisted: rendered collapsed by default with a chevron toggle.
 *
 * The panel renders nothing when `text` is empty (models that don't expose
 * reasoning never produce a panel).
 */
export const ThinkingPanel = React.memo(function ThinkingPanel({
  text,
  streaming = false,
  companionContent,
}: ThinkingPanelProps) {
  const [open, setOpen] = useState(streaming);
  const [userOverride, setUserOverride] = useState(false);

  // Auto-collapse when companion content starts streaming.
  useEffect(() => {
    if (streaming && companionContent && !userOverride && open) {
      setOpen(false);
    }
  }, [streaming, companionContent, userOverride, open]);

  // Re-expand when a new reasoning stream begins (text went from empty to non-empty).
  useEffect(() => {
    if (streaming && text && !userOverride) {
      setOpen(true);
    }
  }, [text, streaming, userOverride, open]);

  // Reset user override when text is cleared (new turn).
  useEffect(() => {
    if (!text) setUserOverride(false);
  }, [text]);

  if (!text) return null;

  const handleToggle = () => {
    setUserOverride(true);
    setOpen((prev) => !prev);
  };

  const preview = streaming && open ? null : (
    <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[280px]">
      {text.slice(0, 80).trim()}{text.length > 80 ? "…" : ""}
    </span>
  );

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <Brain size={11} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] flex-shrink-0">
          {streaming && open ? "Thinking…" : "Thought process"}
        </span>
        {!open && preview}
        <ChevronDown
          size={11}
          className={`text-[var(--text-tertiary)] ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-[var(--border)]/50 text-[0.786rem] leading-relaxed text-[var(--text-tertiary)] max-h-[300px] overflow-y-auto">
          <MarkdownContent content={text} />
          {streaming && open && (
            <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      )}
    </div>
  );
});
