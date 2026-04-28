"use client";

/**
 * MarkdownEditor — CodeMirror 6 editor with inline markdown decorations.
 *
 * Renders headings, bold, italic, code etc. visually as you type — no
 * separate preview pane needed. Raw markdown is preserved in the data model.
 */

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorView, ViewUpdate, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";

// ── Public handle so parent can read selection for AI toolbar ──────────────
export interface MarkdownEditorHandle {
  getSelection: () => { from: number; to: number; text: string } | null;
  replaceSelection: (text: string) => void;
  focus: () => void;
  getView: () => EditorView | null;
}

interface MarkdownEditorProps {
  initialValue: string;
  onChange: (value: string) => void;
  onSelectionChange?: (sel: { text: string; coords: { top: number; left: number } } | null) => void;
  placeholder?: string;
  className?: string;
}

// ── Cairn theme ────────────────────────────────────────────────────────────
// Reads CSS variables so it automatically matches light/dark mode.
function buildTheme() {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "0.9rem",
      fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
      background: "transparent",
      color: "var(--text-primary)",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.8",
      overflow: "auto",
      padding: "20px 24px 80px",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      maxWidth: "680px",
      margin: "0 auto",
    },
    ".cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "var(--accent-dim) !important" },
    "&.cm-focused .cm-selectionBackground": { background: "var(--accent-dim) !important" },
    ".cm-line": { padding: "0" },

    // Placeholder
    ".cm-placeholder": {
      color: "var(--text-tertiary)",
      fontStyle: "italic",
    },

    // Headings — size + weight
    ".cm-line .tok-heading1": { fontSize: "1.6rem", fontWeight: "700", lineHeight: "1.3", color: "var(--text-primary)", letterSpacing: "-0.02em" },
    ".cm-line .tok-heading2": { fontSize: "1.25rem", fontWeight: "600", lineHeight: "1.4", color: "var(--text-primary)" },
    ".cm-line .tok-heading3": { fontSize: "1.05rem", fontWeight: "600", color: "var(--text-primary)" },
    ".cm-line .tok-heading4, .cm-line .tok-heading5, .cm-line .tok-heading6": { fontWeight: "600", color: "var(--text-secondary)" },

    // Heading punctuation (the # marks) — dimmed
    ".tok-headingMark": { color: "var(--text-tertiary)", fontWeight: "400", fontSize: "0.8em" },

    // Inline formatting
    ".tok-strong": { fontWeight: "700", color: "var(--text-primary)" },
    ".tok-emphasis": { fontStyle: "italic", color: "var(--text-primary)" },
    ".tok-strikethrough": { textDecoration: "line-through", color: "var(--text-tertiary)" },

    // Inline code
    ".tok-monospace, .tok-code": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: "0.82em",
      background: "var(--surface-2)",
      borderRadius: "3px",
      padding: "0.1em 0.3em",
      color: "var(--accent)",
    },

    // Code block fences
    ".tok-codeMark": { color: "var(--text-tertiary)", fontFamily: "var(--font-mono, monospace)", fontSize: "0.8em" },

    // Links
    ".tok-link, .tok-url": { color: "var(--accent)", textDecoration: "underline", textDecorationColor: "var(--accent-dim)" },
    ".tok-linkMark, .tok-processingInstruction": { color: "var(--text-tertiary)" },

    // Blockquote
    ".tok-quote": { color: "var(--text-secondary)", borderLeft: "none" },

    // List markers
    ".tok-list": { color: "var(--accent)" },

    // HR
    ".tok-contentSeparator": { color: "var(--border)", display: "block", textAlign: "center" },

    // Gutters off
    ".cm-gutters": { display: "none" },
    ".cm-activeLineGutter": { display: "none" },

    // Active line — very subtle highlight
    ".cm-activeLine": { background: "transparent" },
  }, { dark: false });
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  ({ initialValue, onChange, onSelectionChange, placeholder = "Write here…", className }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    useImperativeHandle(ref, () => ({
      getSelection() {
        const view = viewRef.current;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        return { from, to, text: view.state.sliceDoc(from, to) };
      },
      replaceSelection(text: string) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from, head: from + text.length },
        });
        view.focus();
      },
      focus() {
        viewRef.current?.focus();
      },
      getView() {
        return viewRef.current;
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }

        // Notify parent of selection changes for AI toolbar positioning
        if (update.selectionSet && onSelectionChange) {
          const { from, to } = update.state.selection.main;
          if (from === to) {
            onSelectionChange(null);
            return;
          }
          const text = update.state.sliceDoc(from, to).trim();
          if (text.length < 3) {
            onSelectionChange(null);
            return;
          }
          // Only need the vertical position — toolbar centres itself in the window
          const coordsFrom = update.view.coordsAtPos(from);
          if (coordsFrom) {
            onSelectionChange({
              text,
              coords: { top: coordsFrom.top, left: 0 },
            });
          }
        }
      });

      const state = EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
          }),
          buildTheme(),
          cmPlaceholder(placeholder),
          updateListener,
          EditorView.lineWrapping,
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Only run on mount — content updates handled below
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // When the note ID changes (different note selected), replace the full doc
    // without recreating the editor (preserves undo history isolation via key
    // on parent instead).
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current !== initialValue) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: initialValue },
        });
      }
    }, [initialValue]);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ height: "100%", overflow: "hidden" }}
      />
    );
  }
);

MarkdownEditor.displayName = "MarkdownEditor";
export { MarkdownEditor };
