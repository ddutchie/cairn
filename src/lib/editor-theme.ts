/**
 * editorTheme — shared CM6 theme, syntax highlight style, and search panel theme.
 *
 * Used by both the agent editor (`src/components/agent/FileEditorInner.tsx`) and
 * the notes markdown editor (`src/components/notes/markdown-editor.tsx`), so
 * co-located in `src/lib/` rather than inside `agent/` (P3-3 of the cleanup
 * plan — the previous cross-feature import was `@/components/agent/editorTheme`).
 */

import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { SYNTAX_COLORS } from "./syntax-palette";

// ── Syntax highlight style ─────────────────────────────────────────────────────
// CM6 HighlightStyle.define only accepts colour strings, not CSS variables, so
// these are built from the shared `SYNTAX_COLORS` palette (see syntax-palette.ts),
// the single source of truth shared with CodeBlock and the PDF export path.

export function buildHighlightStyle(isDark: boolean) {
  const v = isDark ? "dark" : "light";
  const c = (name: keyof typeof SYNTAX_COLORS) => SYNTAX_COLORS[name][v];
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.modifier],                    color: c("keyword") },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c("func") },
      { tag: [tags.definitionKeyword, tags.moduleKeyword],     color: c("keyword") },
      { tag: [tags.typeName, tags.className, tags.typeOperator], color: c("builtin") },
      { tag: [tags.string, tags.special(tags.string)],         color: c("string") },
      { tag: [tags.number, tags.integer, tags.float],          color: c("number") },
      { tag: [tags.bool, tags.null],                           color: c("literal") },
      { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c("comment"), fontStyle: "italic" },
      { tag: tags.variableName,                                color: c("variable") },
      { tag: tags.propertyName,                                color: c("variable") },
      { tag: [tags.operator, tags.punctuation],                color: c("punctuation") },
      { tag: [tags.tagName, tags.angleBracket],                color: c("variable") },
      { tag: tags.attributeName,                               color: isDark ? c("number") : c("func") },
      { tag: tags.attributeValue,                              color: c("string") },
      { tag: [tags.meta, tags.processingInstruction],          color: c("func") },
      { tag: tags.regexp,                                      color: c("variable") },
    ])
  );
}

// ── CM6 base theme ─────────────────────────────────────────────────────────────
// fontScale mirrors the --font-scale CSS variable so the editor grows/shrinks
// with the user's font size setting (same as the xterm terminal in SessionPane).

export function buildTheme(fontScale = 1) {
  const fontSize = `calc(0.714rem * ${fontScale})`;
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize,
      fontFamily: "var(--font-mono, ui-monospace, 'Cascadia Code', monospace)",
      background: "var(--background)",
      color: "var(--text-primary)",
    },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "auto", padding: "12px 16px" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-selectionBackground": { background: "var(--accent-dim) !important" },
    "&.cm-focused .cm-selectionBackground": { background: "var(--accent-dim) !important" },
    ".cm-gutters": {
      background: "var(--surface)",
      borderRight: "1px solid var(--border-subtle)",
      color: "var(--text-tertiary)",
      minWidth: "2.5rem",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px" },
    ".cm-activeLine": { background: "color-mix(in srgb, var(--accent) 5%, transparent)" },
    ".cm-activeLineGutter": { background: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  }, { dark: false });
}

// ── Search panel theme ─────────────────────────────────────────────────────
// Must be appended after buildTheme() in the extensions array to win the
// source-order race against CM6's own .cm-button / .cm-textfield base styles.
export function buildSearchTheme() {
  return EditorView.theme({
    ".cm-search": {
      background: "var(--surface-1, var(--surface)) !important",
      borderTop: "1px solid var(--border) !important",
      padding: "5px 10px !important",
      display: "flex !important",
      alignItems: "center !important",
      gap: "4px !important",
      flexWrap: "wrap !important",
    },
    ".cm-search label": {
      fontSize: "0.75rem !important",
      color: "var(--text-secondary) !important",
      display: "inline-flex !important",
      alignItems: "center !important",
      gap: "4px !important",
      margin: "0 !important",
    },
    ".cm-search input[type=checkbox]": {
      margin: "0 !important",
      accentColor: "var(--accent) !important",
      width: "12px !important",
      height: "12px !important",
    },
    ".cm-textfield": {
      background: "var(--surface-2) !important",
      border: "1px solid var(--border) !important",
      borderRadius: "4px !important",
      color: "var(--text-primary) !important",
      fontSize: "0.8rem !important",
      padding: "3px 7px !important",
      outline: "none !important",
      boxShadow: "none !important",
      fontFamily: "inherit !important",
    },
    ".cm-textfield:focus": {
      borderColor: "var(--accent) !important",
    },
    ".cm-button": {
      background: "var(--surface-2) !important",
      backgroundImage: "none !important",
      border: "1px solid var(--border) !important",
      borderRadius: "4px !important",
      color: "var(--text-primary) !important",
      fontSize: "0.75rem !important",
      padding: "3px 8px !important",
      cursor: "pointer !important",
      fontFamily: "inherit !important",
      verticalAlign: "middle !important",
    },
    ".cm-button:hover": {
      background: "color-mix(in srgb, var(--accent) 12%, transparent) !important",
      backgroundImage: "none !important",
      borderColor: "var(--accent) !important",
      color: "var(--accent) !important",
    },
    ".cm-searchMatch": {
      background: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
      borderRadius: "2px !important",
      outline: "none !important",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      background: "color-mix(in srgb, var(--accent) 50%, transparent) !important",
    },
  });
}

export { lineNumbers };
