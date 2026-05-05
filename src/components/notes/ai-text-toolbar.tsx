"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Loader2, Wand2, RefreshCw, AlignLeft, Expand, SpellCheck, MessageSquare, X,
  Bold, Italic, Strikethrough, Code, Code2, Link, Quote, List, ListOrdered,
  Heading1, Heading2, Heading3, Highlighter, CheckSquare, Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

// ── AI actions ────────────────────────────────────────────────────────────────

export type AITextAction =
  | "rephrase"
  | "summarize"
  | "expand"
  | "fix_grammar"
  | "change_tone"
  | "custom";

// ── Format actions ────────────────────────────────────────────────────────────
// Inline: wrap/unwrap the selection.
// Line:   toggle a prefix on every selected line.

export type FormatAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "highlight"
  | "link"
  | "h1" | "h2" | "h3"
  | "quote"
  | "bullet"
  | "ordered"
  | "task"
  | "codeblock"
  | "hr";

interface AITextToolbarProps {
  onAction: (action: AITextAction, customPrompt?: string) => void;
  onFormat: (action: FormatAction) => void;
  loading: boolean;
  onDismiss: () => void;
  hasSelection: boolean;
  aiEnabled: boolean;
}

// ── AI action definitions ─────────────────────────────────────────────────────

const AI_ACTIONS: { id: AITextAction; label: string; icon: React.ReactNode }[] = [
  { id: "rephrase",    label: "Rephrase",    icon: <RefreshCw size={11} /> },
  { id: "summarize",   label: "Summarize",   icon: <AlignLeft size={11} /> },
  { id: "expand",      label: "Expand",      icon: <Expand size={11} /> },
  { id: "fix_grammar", label: "Fix grammar", icon: <SpellCheck size={11} /> },
  { id: "change_tone", label: "Change tone", icon: <MessageSquare size={11} /> },
  { id: "custom",      label: "Custom…",     icon: <Wand2 size={11} /> },
];

// ── Format button definitions ─────────────────────────────────────────────────

const FORMAT_GROUPS: { id: FormatAction; label: string; icon: React.ReactNode }[][] = [
  // Inline formatting
  [
    { id: "bold",          label: "Bold (⌘B)",        icon: <Bold size={12} /> },
    { id: "italic",        label: "Italic (⌘I)",      icon: <Italic size={12} /> },
    { id: "strikethrough", label: "Strikethrough",     icon: <Strikethrough size={12} /> },
    { id: "highlight",     label: "Highlight ==text==",icon: <Highlighter size={12} /> },
    { id: "code",          label: "Inline code",       icon: <Code size={12} /> },
    { id: "link",          label: "Link",              icon: <Link size={12} /> },
  ],
  // Headings
  [
    { id: "h1", label: "Heading 1", icon: <Heading1 size={12} /> },
    { id: "h2", label: "Heading 2", icon: <Heading2 size={12} /> },
    { id: "h3", label: "Heading 3", icon: <Heading3 size={12} /> },
  ],
  // Block / list
  [
    { id: "quote",   label: "Blockquote",    icon: <Quote size={12} /> },
    { id: "bullet",  label: "Bullet list",   icon: <List size={12} /> },
    { id: "ordered", label: "Numbered list", icon: <ListOrdered size={12} /> },
    { id: "task",    label: "Task list",     icon: <CheckSquare size={12} /> },
  ],
  // Insert
  [
    { id: "codeblock", label: "Code block", icon: <Code2 size={12} /> },
    { id: "hr",        label: "Divider ---", icon: <Minus size={12} /> },
  ],
];

// ── Component ─────────────────────────────────────────────────────────────────

// Inline actions require a selection; line-level actions work on the cursor line
const REQUIRES_SELECTION = new Set<FormatAction>(["bold", "italic", "strikethrough", "highlight", "code", "link"]);

export function AITextToolbar({ onAction, onFormat, loading, onDismiss, hasSelection, aiEnabled }: AITextToolbarProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showCustom) inputRef.current?.focus();
  }, [showCustom]);

  function handleAction(action: AITextAction) {
    if (action === "custom") { setShowCustom(true); return; }
    onAction(action);
  }

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customPrompt.trim()) return;
    onAction("custom", customPrompt.trim());
    setCustomPrompt("");
    setShowCustom(false);
  }

  const btnBase = "flex items-center justify-center w-6 h-6 rounded transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]";

  return (
    <div
      data-ai-toolbar
      className="border-b border-[var(--border)] animate-fade-in shadow-md shadow-black/10"
      style={{ background: "var(--surface-2)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* ── AI action row — hidden when AI is disabled ── */}
      {aiEnabled && <><div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--border)]">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-[var(--text-tertiary)]">
            <Loader2 size={11} className="animate-spin" />
            <span>Writing…</span>
          </div>
        ) : (
          <>
            {AI_ACTIONS.map((action) => (
              <button
                key={action.id}
                onClick={() => handleAction(action.id)}
                disabled={!hasSelection}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-[0.786rem] transition-colors whitespace-nowrap",
                  hasSelection
                    ? "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]"
                    : "text-[var(--text-tertiary)] opacity-40 cursor-not-allowed",
                  showCustom && action.id === "custom" && "bg-[var(--surface)] text-[var(--text-primary)]"
                )}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
            <div className="flex-1" />
            <div className="w-px h-4 bg-[var(--border)] mx-0.5" />
            <Tooltip content="Dismiss" side="bottom">
              <button
                onClick={onDismiss}
                className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] transition-colors"
              >
                <X size={11} />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Custom prompt input */}
      {showCustom && !loading && (
        <form
          onSubmit={handleCustomSubmit}
          className="flex items-center gap-1.5 px-4 py-1.5 border-b border-[var(--border)]"
        >
          <Wand2 size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <input
            ref={inputRef}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setShowCustom(false), setCustomPrompt(""))}
            placeholder="Describe what to do with the text…"
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={!customPrompt.trim()}
            className="px-2 py-0.5 rounded text-[0.786rem] bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            Apply
          </button>
        </form>
      )}
      </>}

      {/* ── Formatting bar ── */}
      <div className="flex items-center gap-1 px-3 py-1.5">
        {FORMAT_GROUPS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <div className="w-px h-4 bg-[var(--border)] mx-0.5" />}
            {group.map((fmt) => {
              const needsSel = REQUIRES_SELECTION.has(fmt.id);
              const disabled = needsSel && !hasSelection;
              return (
                <Tooltip key={fmt.id} content={fmt.label} side="bottom">
                  <button
                    onClick={() => onFormat(fmt.id)}
                    disabled={disabled}
                    className={cn(
                      btnBase,
                      disabled && "opacity-40 cursor-not-allowed"
                    )}
                    onMouseDown={(e) => e.preventDefault()} // keep CM selection alive
                  >
                    {fmt.icon}
                  </button>
                </Tooltip>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ── AI prompt builder ─────────────────────────────────────────────────────────

export function buildAIActionPrompt(action: AITextAction, selectedText: string, customPrompt?: string): string {
  const base = `You are an AI writing assistant embedded in a note editor. The user has selected the following text:\n\n"${selectedText}"\n\n`;
  switch (action) {
    case "rephrase":     return base + "Rephrase this text to say the same thing in a different, clearer way. Return only the rewritten text, no commentary.";
    case "summarize":    return base + "Summarize this text concisely. Return only the summary, no commentary.";
    case "expand":       return base + "Expand this text with more detail and depth. Return only the expanded text, no commentary.";
    case "fix_grammar":  return base + "Fix any grammar, spelling, and punctuation errors in this text. Return only the corrected text, no commentary.";
    case "change_tone":  return base + "Rewrite this text in a more professional and polished tone. Return only the rewritten text, no commentary.";
    case "custom":       return base + `${customPrompt}. Return only the resulting text, no commentary.`;
  }
}

// ── Format logic ──────────────────────────────────────────────────────────────
// Exported so note-editor.tsx can call it directly with the CodeMirror view.

import type { EditorView } from "@codemirror/view";

/**
 * Apply a FormatAction to the current CodeMirror selection.
 *
 * Inline actions (bold, italic, strikethrough, code, link):
 *   - If selection is already wrapped, unwrap it.
 *   - Otherwise wrap it. If nothing is selected, insert a placeholder.
 *
 * Line actions (h1–h3, quote, bullet, ordered):
 *   - Toggle the prefix on every line touched by the selection.
 *   - If all lines already have the prefix, remove it; otherwise add it.
 */
/** Returns the doc range of the affected content after the dispatch, so callers
 *  can read the updated text for preview. Line actions expand the range to cover
 *  full lines; inline actions return the wrapped selection range. */
export function applyFormat(view: EditorView, action: FormatAction): { from: number; to: number } | null {
  const state = view.state;
  const { from, to } = state.selection.main;
  const selectedText = state.sliceDoc(from, to);

  // ── Inline wrapping ───────────────────────────────────────────────────────

  type WrapDef = { open: string; close: string; placeholder: string };
  const WRAP: Partial<Record<FormatAction, WrapDef>> = {
    bold:          { open: "**", close: "**", placeholder: "bold text" },
    italic:        { open: "_",  close: "_",  placeholder: "italic text" },
    strikethrough: { open: "~~", close: "~~", placeholder: "strikethrough" },
    highlight:     { open: "==", close: "==", placeholder: "highlighted text" },
    code:          { open: "`",  close: "`",  placeholder: "code" },
  };

  if (action in WRAP) {
    const { open, close, placeholder } = WRAP[action]!;
    const isWrapped =
      selectedText.startsWith(open) && selectedText.endsWith(close) && selectedText.length > open.length + close.length;

    const resultFrom = from; let resultTo = to;
    if (isWrapped) {
      const inner = selectedText.slice(open.length, selectedText.length - close.length);
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      });
      resultTo = from + inner.length;
    } else if (selectedText.length === 0) {
      const insert = open + placeholder + close;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + open.length, head: from + open.length + placeholder.length },
      });
      resultTo = from + insert.length;
    } else {
      const insert = open + selectedText + close;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from, head: from + insert.length },
      });
      resultTo = from + insert.length;
    }
    view.focus();
    return { from: resultFrom, to: resultTo };
  }

  // ── Link ──────────────────────────────────────────────────────────────────

  if (action === "link") {
    // Detect existing [text](url) — unwrap to just the link text
    const linkRe = /^\[(.+?)\]\(.+?\)$/;
    const linkMatch = selectedText.match(linkRe);
    if (linkMatch) {
      const inner = linkMatch[1];
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
      });
      view.focus();
      return { from, to: from + inner.length };
    }
    if (selectedText.length === 0) {
      const insert = "[link text](url)";
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + 1, head: from + 10 },
      });
      view.focus();
      return { from, to: from + insert.length };
    } else {
      const insert = `[${selectedText}](url)`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + selectedText.length + 3, head: from + insert.length - 1 },
      });
      view.focus();
      return { from, to: from + insert.length };
    }
  }

  // ── Line-level prefixes ───────────────────────────────────────────────────

  const LINE_PREFIX: Partial<Record<FormatAction, string>> = {
    h1:      "# ",
    h2:      "## ",
    h3:      "### ",
    quote:   "> ",
    bullet:  "- ",
    ordered: "1. ",
    task:    "- [ ] ",
  };

  if (action in LINE_PREFIX) {
    const prefix = LINE_PREFIX[action]!;

    // Collect all lines spanned by the selection
    const startLine = state.doc.lineAt(from);
    const endLine   = state.doc.lineAt(to);

    // Check if ALL touched lines already have this prefix (for toggle).
    // Ordered lists use a regex so "2. " / "10. " are recognised, not just "1. ".
    const hasPrefix = action === "ordered"
      ? (text: string) => /^\d+\.\s/.test(text)
      : (text: string) => text.startsWith(prefix);

    let allHave = true;
    for (let ln = startLine.number; ln <= endLine.number; ln++) {
      const line = state.doc.line(ln);
      if (!hasPrefix(line.text)) { allHave = false; break; }
    }

    // For ordered lists, rebuild numbering; for others, uniform prefix toggle
    const changes: { from: number; to: number; insert: string }[] = [];
    let orderedIndex = 1;

    for (let ln = startLine.number; ln <= endLine.number; ln++) {
      const line = state.doc.line(ln);

      // Strip any existing heading / list / quote prefix first so we don't
      // double-up when switching between formats (e.g. # → ## → # ).
      const stripped = line.text
        .replace(/^(#{1,6}\s)/, "")
        .replace(/^(>\s)/, "")
        .replace(/^(-\s\[[ x]\]\s)/, "")
        .replace(/^(-\s)/, "")
        .replace(/^(\d+\.\s)/, "");

      if (allHave) {
        // Remove prefix
        changes.push({ from: line.from, to: line.to, insert: stripped });
      } else {
        // Add prefix (with correct numbering for ordered lists)
        const p = action === "ordered" ? `${orderedIndex++}. ` : prefix;
        changes.push({ from: line.from, to: line.to, insert: p + stripped });
      }
    }

    view.dispatch({ changes });
    view.focus();
    // Return full line range from the post-dispatch state so the caller can
    // read the complete updated line text for the preview.
    const newState = view.state;
    const newStart = newState.doc.lineAt(startLine.from);
    const newEnd   = newState.doc.lineAt(
      Math.min(endLine.from, newState.doc.length)
    );
    return { from: newStart.from, to: newEnd.to };
  }

  // ── Block inserts (no prefix toggling) ───────────────────────────────────

  if (action === "codeblock") {
    const startLine = state.doc.lineAt(from);
    const endLine   = state.doc.lineAt(to);

    // ── Toggle off: find enclosing ``` fences anywhere around the selection ───
    // Walk upward from startLine to find an opening fence
    let openFenceLine: ReturnType<typeof state.doc.line> | null = null;
    for (let ln = startLine.number; ln >= 1; ln--) {
      const l = state.doc.line(ln);
      if (/^```/.test(l.text)) { openFenceLine = l; break; }
    }
    // Walk downward from endLine to find a closing fence
    let closeFenceLine: ReturnType<typeof state.doc.line> | null = null;
    for (let ln = endLine.number; ln <= state.doc.lines; ln++) {
      const l = state.doc.line(ln);
      if (/^```/.test(l.text)) { closeFenceLine = l; break; }
    }
    // Only treat as "already fenced" when the two fences are distinct lines
    const isFenced = openFenceLine !== null && closeFenceLine !== null &&
      openFenceLine.number !== closeFenceLine.number;

    if (isFenced) {
      // Content is everything between the fence lines (exclusive of the fence lines themselves)
      const contentFrom = openFenceLine!.to + 1;  // char after the \n on the ``` line
      const contentTo   = closeFenceLine!.from - 1; // char before the \n leading into the ``` line
      const content = contentTo >= contentFrom
        ? state.doc.sliceString(contentFrom, contentTo)
        : "";
      view.dispatch({
        changes: { from: openFenceLine!.from, to: closeFenceLine!.to, insert: content },
        selection: { anchor: openFenceLine!.from, head: openFenceLine!.from + content.length },
      });
      view.focus();
      return { from: openFenceLine!.from, to: openFenceLine!.from + content.length };
    }

    // ── Toggle on: wrap selection (or placeholder) in a fenced block ──────────
    const inner  = selectedText.length > 0 ? selectedText : "code here";
    const insert = `\`\`\`\n${inner}\n\`\`\``;
    const replaceFrom = startLine.from;
    const replaceTo   = selectedText.length > 0 ? endLine.to : startLine.to;
    view.dispatch({
      changes: { from: replaceFrom, to: replaceTo, insert },
      // Select the inner content (after the opening fence + newline)
      selection: { anchor: replaceFrom + 4, head: replaceFrom + 4 + inner.length },
    });
    view.focus();
    return { from: replaceFrom, to: replaceFrom + insert.length };
  }

  if (action === "hr") {
    const line   = state.doc.lineAt(from);
    const insert = (line.text.trim() === "" ? "" : "\n") + "---\n";
    const pos    = line.text.trim() === "" ? line.from : line.to;
    view.dispatch({
      changes: { from: pos, to: pos, insert },
      selection: { anchor: pos + insert.length },
    });
    view.focus();
    return { from: pos, to: pos + insert.length };
  }

  return null;
}
