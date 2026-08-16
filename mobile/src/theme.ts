/**
 * Cairn mobile theme — mirrors the desktop CSS custom properties
 * (src/app/globals.css) so the two apps share one visual language.
 *
 * Desktop uses CSS variables that flip on data-theme; RN has no cascade, so we
 * expose the same tokens as JS objects and pick one via useTheme() based on the
 * system colour scheme.
 */

import { Platform, useColorScheme } from "react-native";
import { useSyncExternalStore, useMemo } from "react";
import { getMeta, setMeta } from "@/db";
import { resolveAccentPreset, DEFAULT_ACCENT_ID, ACCENT_PRESETS, type AccentPreset } from "@cairn/shared/ui/accents";
import { FONT_PRESETS, resolveFontPreset, type FontPreset } from "@cairn/shared/ui/fonts";
import { resolveChatTheme, DEFAULT_CHAT_THEME_ID, type ChatThemePreset } from "@cairn/shared/ui/chat-themes";

export interface Theme {
  background: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderSubtle: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentFg: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  /** Knowledge-graph "Project" node colour — fixed (accent-independent) so it
   *  never collides with Card/success green when a green accent is chosen. */
  nodeProject: string;
  /** Modal/sheet backdrop dimming colour (already includes its own alpha). */
  scrim: string;
  /** Chat surface tokens (from the active chat theme). */
  chatBg: string;
  /** Gradient stops for the chat background when the theme uses one. */
  chatGradient?: [string, string];
  chatBgType: "solid" | "gradient" | "pattern";
  chatBubbleStyle: "filled" | "glass" | "outlined";
  chatUser: string;
  chatUserFg: string;
  chatAi: string;
  chatAiText: string;
  /** RN font-family string for chat text (theme's bundled font). */
  chatFont: string | undefined;
}

export const darkTheme: Theme = {
  background: "#0d0d0d",
  surface: "#141414",
  surface2: "#1a1a1a",
  surface3: "#222222",
  border: "#2a2a2a",
  borderSubtle: "#1f1f1f",
  accent: "#8faf6f",
  accentHover: "#a6c487",
  accentDim: "rgba(143, 175, 111, 0.15)",
  accentFg: "#131c0b",
  textPrimary: "#e8e4dc",
  textSecondary: "#9e9a94",
  textTertiary: "#66635f",
  success: "#3ecf8e",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#60a5fa",
  nodeProject: "#a78bfa",
  scrim: "rgba(0,0,0,0.5)",
  chatBg: "#141414",
  chatBgType: "solid",
  chatBubbleStyle: "filled",
  chatUser: "#8faf6f",
  chatUserFg: "#131c0b",
  chatAi: "#1a1a1a",
  chatAiText: "#9e9a94",
  chatFont: undefined,
};

export const lightTheme: Theme = {
  background: "#f5f4f1",
  surface: "#ffffff",
  surface2: "#f0eeeb",
  surface3: "#e8e5e1",
  // Bumped darker (was #dddad6) so a 1px border reads clearly against the light
  // surface/surface2 fills — the old value was ~1.1:1 against surface2 and made
  // bordered inputs/cards look like flat fills. borderSubtle stays lighter for
  // hairline row separators where a hard edge would be too heavy.
  border: "#cdc9c4",
  borderSubtle: "#e4e0dc",
  accent: "#5c7a3f",
  accentHover: "#4d6733",
  accentDim: "rgba(92, 122, 63, 0.12)",
  accentFg: "#ffffff",
  textPrimary: "#1a1917",
  textSecondary: "#4a4744",
  textTertiary: "#9e9a94",
  success: "#1a9e68",
  warning: "#d97706",
  danger: "#dc2626",
  info: "#2563eb",
  nodeProject: "#7c5cd6",
  scrim: "rgba(0,0,0,0.4)",
  chatBg: "#ffffff",
  chatBgType: "solid",
  chatBubbleStyle: "filled",
  chatUser: "#5c7a3f",
  chatUserFg: "#ffffff",
  chatAi: "#f0eeeb",
  chatAiText: "#4a4744",
  chatFont: undefined,
};

/** Priority colours — re-exported from shared so desktop + mobile match. */
export { PRIORITY_COLOR, PRIORITIES, type Priority } from "@cairn/shared/ui/constants";

/**
 * Elevation ladder — the RN analogue of the desktop shadow scale
 * (shadow-sm → shadow-xl in globals.css). Each level bundles the iOS shadow*
 * props with an Android `elevation` so cards/menus/modals read with depth
 * instead of flat 1px borders. Spread into a style object.
 *
 * Shadows are near-black with low opacity so they work on both themes; on dark
 * surfaces they read as a subtle darkening at the card's edge.
 */
export interface Elevation {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export const elevation: Record<"sm" | "md" | "lg" | "xl", Elevation> = {
  sm: { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2, elevation: 1 },
  md: { shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.1, shadowRadius: 6, elevation: 3 },
  lg: { shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 8 },
  xl: { shadowColor: "#000", shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.16, shadowRadius: 30, elevation: 16 },
};

/**
 * Shared typography scale — the single source of truth for text sizing/weight
 * across the app UI, so screens stop each picking their own 12/13/14/16. Spread
 * a token into a StyleSheet entry and override only `color` (and, rarely, a
 * one-off weight):
 *
 *   periodLabel: { ...type.title, color: t.textPrimary }
 *   preview:     { ...type.caption, color: t.textTertiary }
 *
 * Sizes are unscaled points; RN scales them with the OS text-size setting.
 *
 * Role guide (largest → smallest):
 *   display  24/700  screen & note titles, big inputs
 *   heading  20/700  section headings, empty-state titles
 *   title    17/600  list-item titles, prominent labels, period label
 *   subtitle 16/600  sheet titles, day-list titles
 *   control  15/600  toolbar buttons, toggles, pills, primary body-ish labels
 *   body     15/400  body copy / descriptions
 *   label    13/600  field labels, tab/segment labels, chips
 *   caption  13/400  meta, previews, timestamps, stat counts
 *   micro    11/500  dense keys — day-cell chips, legend, small tag chips
 *   overline 12/600  uppercase section/card labels (tracked)
 */
export interface TypeToken {
  fontSize: number;
  fontWeight: "400" | "500" | "600" | "700";
  lineHeight?: number;
  textTransform?: "uppercase";
  letterSpacing?: number;
}

export const type = {
  display: { fontSize: 24, fontWeight: "700" } as TypeToken,
  heading: { fontSize: 20, fontWeight: "700" } as TypeToken,
  title: { fontSize: 17, fontWeight: "600" } as TypeToken,
  subtitle: { fontSize: 16, fontWeight: "600" } as TypeToken,
  control: { fontSize: 15, fontWeight: "600" } as TypeToken,
  body: { fontSize: 15, fontWeight: "400", lineHeight: 22 } as TypeToken,
  label: { fontSize: 13, fontWeight: "600" } as TypeToken,
  caption: { fontSize: 13, fontWeight: "400" } as TypeToken,
  micro: { fontSize: 11, fontWeight: "500" } as TypeToken,
  // Uppercase, tracked section/card headers. Consolidates the ad-hoc
  // { fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:0.5 }
  // objects that had drifted across the app (11–12px, 600/700, 0.4/0.5).
  overline: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as TypeToken,
} as const;

/**
 * Icon sizing that pairs with the `type` scale so glyphs sit proportionally
 * next to their labels across the app.
 */
export const iconSize = {
  /** Inline with `type.control`/`type.label` (pill/toggle/segment icons). */
  control: 17,
  /** Nav chevrons and standalone tappable glyphs. */
  nav: 20,
  /** Small affordances (dropdown carets, inline meta glyphs). */
  hint: 14,
} as const;

/**
 * Standard UIKit tab bar content height (excludes the home-indicator inset).
 *
 * NOTE: on a tab screen the safe-area `insets.bottom` reported to the content
 * ALREADY INCLUDES the native tab bar (the bar is part of the bottom safe area),
 * so a fixed bottom overlay only needs `insets.bottom` + a small gap — adding
 * TAB_BAR_BASE on top double-counts and floats it too high (verified on device
 * with the note TOC button). Prefer plain `insets.bottom` for overlays.
 *
 * This constant remains only for cases that must reserve the bar's height
 * separately from the inset (e.g. reconstructing a keyboard-sticky offset where
 * no safe-area inset is in play — see the chat composer). NativeTabs doesn't
 * expose its height, so we reconstruct it.
 */
export const TAB_BAR_BASE = 49;

/**
 * How far a bottom-pinned floating control (chat composer, search scope bar)
 * should lift above the screen bottom when the keyboard is CLOSED, so it hugs
 * the native tab bar instead of the home indicator. Slightly more than the bar's
 * visible height — `insets.bottom * 0.5` accounts for the home-indicator area
 * without floating the control well above the bar. Shared so chat + search rest
 * at the same height. (Verified on device: this is the correct resting spot.)
 */
export function tabBarClosedLift(insetBottom: number): number {
  return TAB_BAR_BASE + insetBottom * 0.5;
}

/**
 * Gap between a keyboard-sticky floating control and the top of the keyboard
 * when it's OPEN. A small breathing space so the control doesn't touch the
 * keyboard. Shared by chat + search.
 */
export const KEYBOARD_OPEN_GAP = 8;

/**
 * Whether the OS renders the integrated search field inside the tab bar for a
 * `role="search"` NativeTabs tab.
 *
 * iOS ≤26 (via react-native-screens' legacy `UITabBarSystemItemSearch`) shows a
 * search field docked in the tab bar. The iOS 27 SDK dropped that behaviour for
 * the legacy system-item (it now needs the modern `UISearchTab`, which rn-screens
 * hasn't adopted — see the "iOS 27: search tab renders as plain tab" task), so
 * the search tab is just a normal tab with no extra field.
 *
 * Layout that reserved space for that field (padding, keyboard-sticky offsets)
 * must gate on this so iOS 27 doesn't leave a ~52pt gap where the field used to
 * be. Android and web never had it.
 */
export const hasTabBarSearchField =
  Platform.OS === "ios" && parseInt(String(Platform.Version), 10) < 27;


/** Returns the theme for the current system colour scheme, with the user's
 *  chosen accent preset + chat theme overlaid. Reactive to the system scheme
 *  and in-app accent/theme changes. */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  const accentId = useAccent();
  const chatThemeId = useChatTheme();
  return useMemo(() => {
    const base = scheme === "light" ? lightTheme : darkTheme;
    const withAccent = applyAccentToTheme(base, accentId, scheme === "light");
    return applyChatThemeToTheme(withAccent, chatThemeId, scheme === "light");
  }, [scheme, accentId, chatThemeId]);
}

/** True when the current system colour scheme is dark (default when unset). */
export function useIsDark(): boolean {
  return useColorScheme() !== "light";
}

// ── Accent preset (user choice, persisted in the device-global meta DB) ─────────

const ACCENT_META_KEY = "accentColor";

// ACCENT_PRESETS / DEFAULT_ACCENT_ID / AccentPreset are imported at the top and
// re-exported below so screens (the picker) can pull them from "@/theme".
export { ACCENT_PRESETS, DEFAULT_ACCENT_ID };
export type { AccentPreset };

// A tiny external store so changing the accent re-renders every useTheme()
// consumer. The value is cached in-memory (seeded lazily from meta) and mirrored
// to the meta DB on write.
let _accentId: string | null = null;
const _accentListeners = new Set<() => void>();

function readAccentFromMeta(): string {
  try {
    return getMeta(ACCENT_META_KEY) ?? DEFAULT_ACCENT_ID;
  } catch {
    return DEFAULT_ACCENT_ID;
  }
}

/** Current accent preset id (cached; reads meta once). */
export function getAccentId(): string {
  if (_accentId === null) _accentId = readAccentFromMeta();
  return _accentId;
}

/** Persist + broadcast a new accent preset id. No-op if unchanged. */
export function setAccentId(id: string): void {
  const next = resolveAccentPreset(id).id; // normalise unknown ids to default
  if (_accentId === next) return;
  _accentId = next;
  try {
    setMeta(ACCENT_META_KEY, next);
  } catch {
    // best-effort; in-memory value still drives the UI this session
  }
  for (const l of _accentListeners) l();
}

function subscribeAccent(cb: () => void): () => void {
  _accentListeners.add(cb);
  return () => _accentListeners.delete(cb);
}

/** Reactive hook: the current accent preset id. */
export function useAccent(): string {
  return useSyncExternalStore(subscribeAccent, getAccentId, getAccentId);
}

/** Overlay a preset's accent trio (for the given theme mode) onto a base theme. */
export function applyAccentToTheme(base: Theme, accentId: string, isLight: boolean): Theme {
  const preset: AccentPreset = resolveAccentPreset(accentId);
  const v = isLight ? preset.light : preset.dark;
  return {
    ...base,
    accent: v.accent,
    accentHover: v.hover,
    accentDim: v.dim,
    accentFg: v.fg,
  };
}

// ── Note-text font preset (user choice, persisted in the device-global meta DB) ─

const FONT_META_KEY = "fontFamily";

// FONT_PRESETS re-exported below so screens (the picker) pull them from "@/theme".
export { FONT_PRESETS };

let _fontId: string | null = null;
const _fontListeners = new Set<() => void>();

function readFontFromMeta(): string {
  try {
    return getMeta(FONT_META_KEY) ?? resolveFontPreset(undefined).id;
  } catch {
    return resolveFontPreset(undefined).id;
  }
}

/** Current note-font preset id (cached; reads meta once). */
export function getFontId(): string {
  if (_fontId === null) _fontId = readFontFromMeta();
  return _fontId;
}

/** Persist + broadcast a new note-font preset id. No-op if unchanged. */
export function setFontId(id: string): void {
  const next = resolveFontPreset(id).id; // normalise unknown ids to default
  if (_fontId === next) return;
  _fontId = next;
  try {
    setMeta(FONT_META_KEY, next);
  } catch {
    // best-effort; in-memory value still drives the UI this session
  }
  for (const l of _fontListeners) l();
}

function subscribeFont(cb: () => void): () => void {
  _fontListeners.add(cb);
  return () => _fontListeners.delete(cb);
}

/** Reactive hook: the current note-font preset id. */
export function useFont(): string {
  return useSyncExternalStore(subscribeFont, getFontId, getFontId);
}

/** Resolve the platform's concrete RN font-family string for a font preset id. */
export function resolveRNFontFamily(fontId: string): string | undefined {
  const preset: FontPreset = resolveFontPreset(fontId);
  return Platform.select(preset.rnFamily) ?? preset.rnFamily.default;
}

// ── Chat theme (user choice, persisted in the device-global meta DB) ──────────

const CHAT_THEME_META_KEY = "chatTheme";

// Re-exported below so screens (the picker) pull them from "@/theme".
export { DEFAULT_CHAT_THEME_ID };
export type { ChatThemePreset };

let _chatThemeId: string | null = null;
const _chatThemeListeners = new Set<() => void>();

function readChatThemeFromMeta(): string {
  try {
    return getMeta(CHAT_THEME_META_KEY) ?? DEFAULT_CHAT_THEME_ID;
  } catch {
    return DEFAULT_CHAT_THEME_ID;
  }
}

/** Current chat-theme id (cached; reads meta once). */
export function getChatThemeId(): string {
  if (_chatThemeId === null) _chatThemeId = readChatThemeFromMeta();
  return _chatThemeId;
}

/** Persist + broadcast a new chat-theme id. No-op if unchanged. */
export function setChatThemeId(id: string): void {
  const next = resolveChatTheme(id).id; // normalise unknown ids to default
  if (_chatThemeId === next) return;
  _chatThemeId = next;
  try {
    setMeta(CHAT_THEME_META_KEY, next);
  } catch {
    // best-effort; in-memory value still drives the UI this session
  }
  for (const l of _chatThemeListeners) l();
}

function subscribeChatTheme(cb: () => void): () => void {
  _chatThemeListeners.add(cb);
  return () => _chatThemeListeners.delete(cb);
}

/** Reactive hook: the current chat-theme id. */
export function useChatTheme(): string {
  return useSyncExternalStore(subscribeChatTheme, getChatThemeId, getChatThemeId);
}

/** Overlay a chat theme's palette + font onto a theme object. */
export function applyChatThemeToTheme(base: Theme, themeId: string, isLight: boolean): Theme {
  const preset: ChatThemePreset = resolveChatTheme(themeId);
  const v = isLight ? preset.light : preset.dark;
  return {
    ...base,
    chatBg: v.bg,
    chatGradient: v.gradient,
    chatBgType: preset.bgType,
    chatBubbleStyle: preset.bubbleStyle,
    chatUser: v.userBubble,
    chatUserFg: v.userBubbleFg,
    chatAi: v.aiBubble,
    chatAiText: v.aiText ?? (isLight ? "#4a4744" : "#9e9a94"),
    chatFont: resolveRNFontFamily(preset.font),
  };
}

/**
 * Apply an alpha to a hex colour → rgba() string. Mirrors the desktop's
 * color-mix / `/20` alpha usage (e.g. accent border at 20%).
 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse a 6-digit hex to an [r,g,b] triple, or null if not a plain hex. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Opaque tint: mix `pct` (0–1) of `color` over the `surface` colour, producing
 * a solid hex. Mirrors the desktop `color-mix(in srgb, {color} X%, var(--surface))`
 * used for callout fills — unlike withAlpha this is anchored to the surface
 * token (not transparent), so callouts read correctly on both themes regardless
 * of what sits behind them. Falls back to `color` if either input isn't hex.
 */
export function surfaceTint(color: string, pct: number, surface: string): string {
  const c = hexToRgb(color);
  const s = hexToRgb(surface);
  if (!c || !s) return color;
  const mix = (a: number, b: number) => Math.round(a * pct + b * (1 - pct));
  const r = mix(c[0], s[0]);
  const g = mix(c[1], s[1]);
  const b = mix(c[2], s[2]);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
