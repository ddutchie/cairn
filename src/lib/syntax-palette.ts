/**
 * syntax-palette — re-export of the shared syntax-highlight palette.
 *
 * The canonical palette now lives in `shared/notes/syntax-palette.ts` so the
 * mobile app's CodeBlock renderer can share the exact same colours. This file
 * remains as the desktop import site (`@/lib/syntax-palette`) so the existing
 * consumers (CodeBlock, editor-theme, dashboard-view, PDF export) don't need to
 * change their import paths.
 */
export {
  SYNTAX_COLORS,
  DARK_TO_LIGHT,
  HLJS_TOKEN_MAP,
  buildHljsPalette,
  type SyntaxColor,
} from "../../shared/notes/syntax-palette";
