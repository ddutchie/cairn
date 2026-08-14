"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, Brain } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { StreamingCursor } from "./message-ui";

interface ThinkingPanelProps {
  /** Reasoning text. When non-empty the panel renders; when empty it's null. */
  text: string;
  /**
   * Condensed reasoning summary (Responses `reasoning.summary`). When present,
   * it is shown in the COLLAPSED state in place of the raw-reasoning preview —
   * so a collapsed Thinking panel reads as a concise summary, not a truncated
   * thought trace. Expanded state still shows the full raw `text`.
   */
  summary?: string;
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
  summary,
  streaming = false,
  companionContent,
}: ThinkingPanelProps) {
  // `override` is null (auto) or a user-forced expanded/collapsed value.
  // Whether the panel is expanded while thinking is DERIVED (`thinking`) when
  // no override is set, so a remount mid-stream can never flash it open — the
  // old `useState(streaming)` + auto-collapse/re-expand effects re-opened the
  // panel on every mount and flickered with each content token (Virtuoso
  // remounts items as their height changes).
  const [override, setOverride] = useState<boolean | null>(null);
  const hasText = Boolean(text);
  // Expanded while the model is actively thinking (reasoning present, answer
  // not yet started) unless the user has overridden it.
  const thinking = streaming && hasText && !companionContent;
  const expanded = override !== null ? override : thinking;

  // Reset the manual override when text clears (new turn) so a fresh thinking
  // cycle auto-expands again and auto-collapses with companionContent.
  useEffect(() => {
    if (!text) setOverride(null);
  }, [text]);

  // Nothing to render when the model produced neither raw reasoning nor a summary.
  if (!text && !(summary && summary.trim())) return null;

  const handleToggle = () => {
    // Set the override to the inverse of the current expanded state.
    setOverride(expanded ? false : true);
  };

  const collapsedText = summary && summary.trim() ? summary.trim() : text;
  // Expanded body prefers the raw trace; summary-only reasoning uses the summary.
  const bodyText = text || collapsedText;
  const preview = expanded ? null : (
    <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[280px]">
      {collapsedText.slice(0, 120).trim()}{collapsedText.length > 120 ? "…" : ""}
    </span>
  );

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
        aria-expanded={expanded}
      >
        <Brain size={11} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] flex-shrink-0">
          {thinking ? "Thinking…" : "Thought process"}
        </span>
        {!expanded && preview}
        <ChevronDown
          size={11}
          className={`text-[var(--text-tertiary)] ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t text-[0.786rem] leading-relaxed text-[var(--text-tertiary)] max-h-[300px] overflow-y-auto" style={{ borderTopColor: "color-mix(in srgb, var(--border) 50%, transparent)" }}>
          <MarkdownContent content={bodyText} />
          {thinking && <StreamingCursor />}
        </div>
      )}
    </div>
  );
});
