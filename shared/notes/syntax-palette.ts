/**
 * syntax-palette — the single source of truth for code syntax-highlight colours.
 *
 * These hex values are shared by every consumer that needs them in a different
 * shape, so the raw colours live here (framework-free, no CodeMirror, lowlight
 * or React-Native imports) and each consumer maps them onto its own structure:
 *
 *  - desktop `CodeBlock.tsx`      → lowlight/highlight.js `hljs-*` class → colour
 *  - desktop `lib/editor-theme.ts`→ CodeMirror `HighlightStyle` (lezer tags)
 *  - desktop `dashboard-view.tsx` → CodeMirror `HighlightStyle` for HTML editor
 *  - desktop `note-editor.tsx`    → dark→light hex remap for PDF export
 *  - mobile  `CodeBlock.tsx`      → lowlight `hljs-*` class → colour (RN <Text>)
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
 * desktop PDF export path, which serialises DOM already coloured with the dark
 * palette and rewrites the token colours for a white page.
 */
export const DARK_TO_LIGHT: Record<string, string> = Object.fromEntries(
  Object.values(SYNTAX_COLORS).map(({ dark, light }) => [dark, light]),
);

/**
 * highlight.js token class → semantic palette key. Shared by the desktop and
 * mobile CodeBlock renderers so both colour lowlight output identically.
 */
export const HLJS_TOKEN_MAP: Record<string, keyof typeof SYNTAX_COLORS> = {
  "hljs-keyword": "keyword",
  "hljs-built_in": "builtin",
  "hljs-literal": "literal",
  "hljs-number": "number",
  "hljs-string": "string",
  "hljs-template-tag": "string",
  "hljs-template-variable": "variable",
  "hljs-regexp": "string",
  "hljs-comment": "comment",
  "hljs-quote": "comment",
  "hljs-variable": "variable",
  "hljs-attr": "variable",
  "hljs-attribute": "variable",
  "hljs-title": "func",
  "hljs-title.class_": "builtin",
  "hljs-title.function_": "func",
  "hljs-type": "builtin",
  "hljs-class": "builtin",
  "hljs-operator": "literal",
  "hljs-punctuation": "punctuation",
  "hljs-tag": "variable",
  "hljs-name": "variable",
  "hljs-selector-tag": "variable",
  "hljs-selector-id": "func",
  "hljs-selector-class": "builtin",
  "hljs-meta": "func",
  "hljs-meta-keyword": "keyword",
  "hljs-meta-string": "string",
  "hljs-addition": "string",
  "hljs-deletion": "variable",
  "hljs-section": "func",
  "hljs-bullet": "builtin",
  "hljs-link": "string",
  "hljs-symbol": "func",
  "hljs-formula": "literal",
  "hljs-emphasis": "builtin",
  "hljs-strong": "strong",
};

/** Build a flat `hljs-*` class → hex map for the given theme variant. */
export function buildHljsPalette(variant: "dark" | "light"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cls in HLJS_TOKEN_MAP) {
    out[cls] = SYNTAX_COLORS[HLJS_TOKEN_MAP[cls]][variant];
  }
  return out;
}
