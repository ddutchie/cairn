/**
 * syntax-palette — the single source of truth for code syntax-highlight colours.
 *
 * These hex values are shared by four consumers that each need them in a
 * different shape, so the raw colours live here (framework-free, no CodeMirror
 * or lowlight imports) and each consumer maps them onto its own structure:
 *
 *  - `CodeBlock.tsx`      → lowlight/highlight.js `hljs-*` class → colour map
 *  - `lib/editor-theme.ts`→ CodeMirror `HighlightStyle` (lezer tags)
 *  - `dashboard-view.tsx` → CodeMirror `HighlightStyle` for the HTML editor
 *  - `note-editor.tsx`    → dark→light hex remap for white-background PDF export
 *
 * Palette is One Dark-style for dark themes with a softer, higher-contrast
 * light variant. Keys are semantic token names; each maps to `{ dark, light }`.
 */

export interface SyntaxColor {
  dark: string;
  light: string;
}

export const SYNTAX_COLORS = {
  keyword:     { dark: "#c678dd", light: "#7c3aed" },
  builtin:     { dark: "#e5c07b", light: "#b45309" },
  literal:     { dark: "#56b6c2", light: "#0891b2" },
  number:      { dark: "#d19a66", light: "#c2410c" },
  string:      { dark: "#98c379", light: "#16a34a" },
  comment:     { dark: "#5c6370", light: "#9ca3af" },
  variable:    { dark: "#e06c75", light: "#dc2626" },
  func:        { dark: "#61afef", light: "#1d4ed8" },
  punctuation: { dark: "#abb2bf", light: "#374151" },
  strong:      { dark: "#ffffff", light: "#111827" },
} as const satisfies Record<string, SyntaxColor>;

/**
 * Map of every dark palette hex → its light-theme counterpart. Used by the
 * PDF export path, which serialises DOM already coloured with the dark palette
 * and rewrites the token colours for a white page.
 */
export const DARK_TO_LIGHT: Record<string, string> = Object.fromEntries(
  Object.values(SYNTAX_COLORS).map(({ dark, light }) => [dark, light]),
);
