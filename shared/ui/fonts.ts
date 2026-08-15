/**
 * Shared font-family presets — pure data (no React, no platform deps) so the
 * desktop app, the mobile app, and PDF exports offer the SAME set of note-text
 * fonts and the SAME stacks.
 *
 * Scope is deliberately NOTE TEXT ONLY (editor + preview + PDF export), not the
 * whole UI chrome. Mirrors `accents.ts` in shape: a stable `id` persisted to
 * storage, a human `name`/`description` for the picker, and the concrete font
 * values each platform needs.
 *
 * IMPORTANT — PDF pass-through constraint: exported PDFs are rendered by the
 * OS print engine (Chromium on desktop, iOS/Android WebView on mobile), which
 * CANNOT load app-bundled webfonts like the desktop's `next/font` Geist. So
 * every preset's `cssFamily` must be a SYSTEM font stack that the print engine
 * can resolve on its own — the desktop-specific first entry (e.g. "Geist")
 * simply won't match in the print context and falls through to the system
 * stacks that follow. A preset is only usable if its stack renders sensibly
 * everywhere.
 */

/** Per-platform React Native font name. `undefined` = the platform default. */
export interface RNFontFamily {
  ios: string | undefined;
  android: string | undefined;
  /** Used when neither ios nor android matches. */
  default?: string | undefined;
}

export interface FontPreset {
  /** Stable id — persisted to storage; never reuse or rename. */
  id: string;
  /** Human label shown in the picker. */
  name: string;
  /** One-line description of the feel. */
  description: string;
  /** CSS font-family stack — used by the desktop editor/preview AND the PDF template. */
  cssFamily: string;
  /** React Native font name(s) — used by the mobile editor/preview. */
  rnFamily: RNFontFamily;
}

/**
 * The curated note-text font presets, in picker order.
 *
 * `sans` mirrors the desktop default (`var(--font-sans)` = Geist, then the
 * system stack). Selecting it keeps current behaviour everywhere; the PDF
 * simply falls back to the system stack (as it always has). `serif` reuses the
 * existing `--font-display` stack so desktop, mobile, and PDF share one serif.
 */
export const FONT_PRESETS: FontPreset[] = [
  {
    id: "sans",
    name: "Sans",
    description: "Geist / system sans — the default note font.",
    cssFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
    rnFamily: { ios: undefined, android: undefined },
  },
  {
    id: "serif",
    name: "Serif",
    description: "Editorial reading serif — Georgia on most platforms.",
    cssFamily: '"New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    rnFamily: { ios: "Georgia", android: "serif" },
  },
  {
    id: "mono",
    name: "Mono",
    description: "Fixed-width typewriter feel for focused writing.",
    cssFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
    rnFamily: { ios: "Menlo", android: "monospace" },
  },
];

/** The default note-text font id. */
export const DEFAULT_FONT_ID = "sans";

/** Fast lookup by id. */
export const FONT_PRESET_BY_ID: Record<string, FontPreset> = Object.fromEntries(
  FONT_PRESETS.map((p) => [p.id, p]),
);

/** Resolve a stored font id to a preset, falling back to the default. */
export function resolveFontPreset(id?: string | null): FontPreset {
  if (id && FONT_PRESET_BY_ID[id]) return FONT_PRESET_BY_ID[id];
  return FONT_PRESET_BY_ID[DEFAULT_FONT_ID];
}
