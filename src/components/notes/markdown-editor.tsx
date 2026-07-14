"use client";

/**
 * MarkdownEditor — CodeMirror 6 editor with inline markdown decorations.
 *
 * Renders headings, bold, italic, code etc. visually as you type — no
 * separate preview pane needed. Raw markdown is preserved in the data model.
 */

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorView, ViewUpdate, keymap, placeholder as cmPlaceholder, Decoration, type DecorationSet } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment } from "@codemirror/state";
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { buildSearchTheme } from "@/lib/editor-theme";

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
  onCursorActivity?: (cursorOffset: number) => void;
  placeholder?: string;
  className?: string;
  /** When true, the editor is read-only (used during AI writes). */
  readOnly?: boolean;
  /**
   * 1-indexed line numbers to highlight as "recently changed" (e.g. edited by
   * the AI while the user was away). Highlighted with a fading accent wash.
   * Pass an empty array (or omit) to clear.
   */
  changedLines?: number[];
}

// ── Changed-line highlight (StateField + effect) ───────────────────────────
// A line decoration that tints lines the AI/sync recently changed so the user
// can see "what's new" when they open the note. Set via the setChangedLines
// effect; the CSS class handles the fade-out animation.
const setChangedLines = StateEffect.define<number[]>();

const changedLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let lines: number[] | null = null;
    for (const e of tr.effects) {
      if (e.is(setChangedLines)) lines = e.value;
    }
    if (lines === null) {
      // No explicit change this transaction — map existing decorations through
      // any doc edits so they stay on the right lines.
      return deco.map(tr.changes);
    }
    if (lines.length === 0) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    const deco2 = Decoration.line({ class: "cm-changed-line" });
    const doc = tr.state.doc;
    // Line numbers must be sorted + in-range for RangeSetBuilder.
    const valid = Array.from(new Set(lines))
      .filter((ln) => ln >= 1 && ln <= doc.lines)
      .sort((x, y) => x - y);
    for (const ln of valid) {
      const line = doc.line(ln);
      builder.add(line.from, line.from, deco2);
    }
    return builder.finish();
  },
  provide: (f) => EditorView.decorations.from(f),
});

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

    // Recently-changed lines (AI / sync edits) — an accent wash that fades out.
    // The keyframe `cairn-changed-line-fade` is defined globally in globals.css
    // so it's shared with the read-mode markdown preview.
    ".cm-changed-line": {
      background: "color-mix(in srgb, var(--accent) 14%, transparent)",
      boxShadow: "inset 2px 0 0 0 var(--accent)",
      borderRadius: "2px",
      animation: "cairn-changed-line-fade 6s ease-out forwards",
    },

  }, { dark: false });
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  ({ initialValue, onChange, onSelectionChange, onCursorActivity, placeholder = "Write here…", className, readOnly = false, changedLines }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Compartment allows reconfiguring editability after the editor is created
    // without destroying and recreating the full EditorState.
    const editableCompartment = useRef(new Compartment());

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
        if (update.selectionSet) {
          if (onCursorActivity) {
            onCursorActivity(update.state.selection.main.head);
          }
          if (onSelectionChange) {
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
            const coordsFrom = update.view.coordsAtPos(from);
            if (coordsFrom) {
              onSelectionChange({
                text,
                coords: { top: coordsFrom.top, left: 0 },
              });
            } else {
              onSelectionChange(null);
            }
          }
        }
      });

      // Paste handler — intercepts image files from clipboard and uploads them
      // via the Electron IPC bridge, then inserts an asset:// markdown image.
      const pasteHandler = EditorView.domEventHandlers({
        paste(event, view) {
          const items = event.clipboardData?.items;
          if (!items) return false;

          const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
          if (imageItems.length === 0) return false;

          // Prevent the default paste (which would insert raw data)
          event.preventDefault();

          imageItems.forEach((item) => {
            const file = item.getAsFile();
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async () => {
              const buffer = reader.result as ArrayBuffer;
              const electron = (window as { electron?: { uploadAsset?: (filename: string, data: ArrayBuffer) => Promise<{ assetUrl: string }> } }).electron;
              if (!electron?.uploadAsset) return;

              try {
                const ext = file.type.split("/")[1]?.split("+")[0] ?? "png";
                const filename = file.name || `pasted-image.${ext}`;
                // Pass the ArrayBuffer directly — Electron structured-clone transfers
                // it natively, avoiding the overhead of a JSON number array.
                const result = await electron.uploadAsset(filename, buffer);
                // assetUrl is either "![[filename.png]]" (new) or "asset://hash.png" (legacy)
                const markdown = result.assetUrl.startsWith("![[")
                  ? result.assetUrl
                  : `![](${result.assetUrl})`;
                const { from, to } = view.state.selection.main;
                view.dispatch({
                  changes: { from, to, insert: markdown },
                  selection: { anchor: from + markdown.length },
                });
              } catch (err) {
                console.error("[cairn] Failed to upload pasted image:", err);
              }
            };
            reader.readAsArrayBuffer(file);
          });

          return true;
        },
      });

      const state = EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          keymap.of([
            // Markdown-aware list continuation + renumbering. Must precede
            // defaultKeymap so its Enter/Backspace bindings take priority;
            // both commands return false outside markdown markup and fall
            // through to the default newline/delete behaviour.
            { key: "Enter", run: insertNewlineContinueMarkup },
            { key: "Backspace", run: deleteMarkupBackward },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            ...searchKeymap,
          ]),
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
          }),
          search({ top: false }),
          buildTheme(),
          buildSearchTheme(),
          cmPlaceholder(placeholder),
          updateListener,
          pasteHandler,
          EditorView.lineWrapping,
          changedLineField,
          // Compartment-controlled editability — reconfigured via readOnly prop
          editableCompartment.current.of(EditorView.editable.of(true)),
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

    // Toggle read-only mode — used when the AI is actively writing this note.
    // Reconfigures the editable Compartment so the cursor and interactions are
    // disabled without destroying editor state or undo history.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: editableCompartment.current.reconfigure(
          EditorView.editable.of(!readOnly),
        ),
      });
    }, [readOnly]);

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

    // Push changed-line highlights into the editor whenever the prop changes.
    // Runs after the doc-sync effect above so line numbers resolve against the
    // freshly-set content.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: setChangedLines.of(changedLines ?? []) });
    }, [changedLines]);

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
