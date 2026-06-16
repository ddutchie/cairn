/**
 * editorTheme — shared CM6 theme and highlight style for the Agent editor.
 * Kept in a separate file so FileEditorInner doesn't bloat AgentEditor.tsx.
 */

import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// ── Syntax highlight style (mirrors CodeBlock.tsx dark/light palettes) ─────────
// CM6 HighlightStyle.define only accepts colour strings, not CSS variables, so
// these are intentionally static palette values matched to the CodeBlock palette.

export function buildHighlightStyle(isDark: boolean) {
  return syntaxHighlighting(
    HighlightStyle.define(
      isDark ? [
        { tag: [tags.keyword, tags.modifier],                    color: "#c678dd" },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#61afef" },
        { tag: [tags.definitionKeyword, tags.moduleKeyword],     color: "#c678dd" },
        { tag: [tags.typeName, tags.className, tags.typeOperator], color: "#e5c07b" },
        { tag: [tags.string, tags.special(tags.string)],         color: "#98c379" },
        { tag: [tags.number, tags.integer, tags.float],          color: "#d19a66" },
        { tag: [tags.bool, tags.null],                           color: "#56b6c2" },
        { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#5c6370", fontStyle: "italic" },
        { tag: tags.variableName,                                color: "#e06c75" },
        { tag: tags.propertyName,                                color: "#e06c75" },
        { tag: [tags.operator, tags.punctuation],                color: "#abb2bf" },
        { tag: [tags.tagName, tags.angleBracket],                color: "#e06c75" },
        { tag: tags.attributeName,                               color: "#d19a66" },
        { tag: tags.attributeValue,                              color: "#98c379" },
        { tag: [tags.meta, tags.processingInstruction],          color: "#61afef" },
        { tag: tags.regexp,                                      color: "#e06c75" },
      ] : [
        { tag: [tags.keyword, tags.modifier],                    color: "#7c3aed" },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#1d4ed8" },
        { tag: [tags.definitionKeyword, tags.moduleKeyword],     color: "#7c3aed" },
        { tag: [tags.typeName, tags.className, tags.typeOperator], color: "#b45309" },
        { tag: [tags.string, tags.special(tags.string)],         color: "#16a34a" },
        { tag: [tags.number, tags.integer, tags.float],          color: "#c2410c" },
        { tag: [tags.bool, tags.null],                           color: "#0891b2" },
        { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#9ca3af", fontStyle: "italic" },
        { tag: tags.variableName,                                color: "#dc2626" },
        { tag: tags.propertyName,                                color: "#dc2626" },
        { tag: [tags.operator, tags.punctuation],                color: "#374151" },
        { tag: [tags.tagName, tags.angleBracket],                color: "#dc2626" },
        { tag: tags.attributeName,                               color: "#1d4ed8" },
        { tag: tags.attributeValue,                              color: "#16a34a" },
        { tag: [tags.meta, tags.processingInstruction],          color: "#1d4ed8" },
        { tag: tags.regexp,                                      color: "#dc2626" },
      ]
    )
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
