"use client";

import React, { useEffect, useRef, useState } from "react";
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
  const hadTextRef = useRef(Boolean(text));

  // Auto-collapse when companion content starts streaming.
  useEffect(() => {
    if (streaming && companionContent && !userOverride && open) {
      setOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, companionContent, userOverride]);

  // Re-expand only on the empty → non-empty transition (new reasoning stream),
  // but only if the answer hasn't started streaming yet.
  useEffect(() => {
    const hadText = hadTextRef.current;
    hadTextRef.current = Boolean(text);
    if (streaming && text && !hadText && !userOverride && !companionContent) {
      setOpen(true);
    }
  }, [text, streaming, userOverride, companionContent]);

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
        <div className="px-3 py-2 border-t text-[0.786rem] leading-relaxed text-[var(--text-tertiary)] max-h-[300px] overflow-y-auto" style={{ borderTopColor: "color-mix(in srgb, var(--border) 50%, transparent)" }}>
          <MarkdownContent content={text} />
          {streaming && open && (
            <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
          )}
        </div>
      )}
    </div>
  );
});
