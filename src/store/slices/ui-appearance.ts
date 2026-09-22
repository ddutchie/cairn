/**
 * UI appearance slice — theme, accent, font scale/family, chat theme.
 * Split out of `slices/ui.ts` (Phase 3); `slices/ui.ts` re-combines the
 * appearance + ai-config + layout slices with an identical store shape.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import { storage } from "@/lib/storage";
import { resolveAccentPreset, DEFAULT_ACCENT_ID } from "../../../shared/ui/accents";
import { resolveFontPreset, DEFAULT_FONT_ID } from "../../../shared/ui/fonts";
import { resolveChatTheme, chatThemeFontStack, chatThemeFontWeightValue, manifestToChatThemes, DEFAULT_CHAT_THEME_ID, type ChatThemePreset } from "../../../shared/ui/chat-themes";

// ── Theme ─────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark" | "system";
export const THEME_KEY = "theme";

// ── Font scale ────────────────────────────────────────────────────────────────

export type FontScale = 1 | 1.1 | 1.2 | 1.3 | 1.4;
export const FONT_SCALE_KEY = "fontScale";
export const DEFAULT_FONT_SCALE: FontScale = 1.2;

export function applyFontScale(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-scale", String(scale));
}

// ── Note-text font family ─────────────────────────────────────────────────────

export type FontFamilyId = "sans" | "serif" | "mono";
export const FONT_FAMILY_KEY = "fontFamily";

/**
 * Apply the note-text font by preset id. Sets `--font-note` on `<html>` so the
 * note editor + `.prose-cairn` preview switch fonts (UI chrome stays on
 * `--font-sans`). Reads the live `data-theme`-independent CSS var mechanism —
 * same override approach as `applyFontScale`.
 */
export function applyFontFamily(fontId: FontFamilyId): void {
  if (typeof document === "undefined") return;
  const preset = resolveFontPreset(fontId);
  document.documentElement.style.setProperty("--font-note", preset.cssFamily);
}

// ── Chat theme ────────────────────────────────────────────────────────────────

export const CHAT_THEME_KEY = "chatTheme";

/**
 * Cached community chat themes (fetched from the cairn-community themes.json
 * manifest). Populated by the theme picker when it loads the catalog; consulted
 * by `applyChatTheme`/`resolveChatTheme` so a stored community theme id resolves
 * even outside the picker (app boot, theme flip, ChatQuickSettings).
 */
let _communityChatThemes: ChatThemePreset[] = [];

/** Store the fetched community chat-theme presets for id resolution. */
export function setCommunityChatThemes(presets: ChatThemePreset[]): void {
  _communityChatThemes = presets;
}

/**
 * Fetch the community chat-themes catalog, cache it for id resolution, and
 * re-apply the active theme if it's a community id. Called at app boot (so a
 * stored community theme applies without opening a picker) and by the picker
 * after it refreshes. Soft-fails: no catalog, no problem.
 */
export async function fetchAndCacheCommunityChatThemes(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electron?.registry : undefined;
  if (!api?.fetchChatThemes) return;
  try {
    const cached = await api.fetchChatThemes();
    let manifest = cached?.manifest;
    try {
      const fresh = await api.refreshChatThemes?.();
      if (fresh?.manifest && fresh.manifest.themes.length > 0) {
        manifest = fresh.manifest;
      }
    } catch {
      /* soft — keep the cached result on a network failure */
    }
    if (!manifest) return;
    const presets = manifestToChatThemes(manifest.themes);
    setCommunityChatThemes(presets);
    // If the stored/active theme is a community id, re-apply it now that it can
    // resolve — otherwise it silently fell back to the default.
    const active = typeof document !== "undefined"
      ? (storage.get<string>(CHAT_THEME_KEY) ?? DEFAULT_CHAT_THEME_ID)
      : DEFAULT_CHAT_THEME_ID;
    if (presets.some((p) => p.id === active)) {
      applyChatTheme(active, presets);
    }
  } catch {
    /* soft — community themes are optional */
  }
}

/**
 * Apply the chat theme by preset id. Sets the chat CSS vars + a `data-chat-theme`
 * attribute on `<html>` so the chat surface (panel bg, bubbles, composer, chat
 * font) switches look while the rest of the app stays on global tokens.
 * `extras` overlays fetched community themes for id resolution (merged with the
 * module-level community cache, so callers that don't have the catalog handy —
 * app boot, theme flip — still resolve community ids).
 *
 * The mode (dark/light) is read from the live `data-theme` attribute (same as
 * `applyAccent`), so it must be re-run after `applyTheme` flips modes.
 */
export function applyChatTheme(themeId: string, extras: ChatThemePreset[] = []): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = resolveChatTheme(themeId, [..._communityChatThemes, ...extras]);
  const mode: "dark" | "light" = root.getAttribute("data-theme") === "light" ? "light" : "dark";
  const v = preset[mode];

  root.style.setProperty("--chat-bg", v.bg);
  // The default preset's user bubble IS the accent colour (byte-matches today's
  // rendering), so it must track the user's chosen accent — not the hardcoded
  // default-accent palette in the preset. Non-default themes use their static
  // palette.
  if (preset.id === DEFAULT_CHAT_THEME_ID) {
    root.style.setProperty("--chat-user", "var(--accent)");
    root.style.setProperty("--chat-user-fg", "var(--accent-fg)");
  } else {
    root.style.setProperty("--chat-user", v.userBubble);
    root.style.setProperty("--chat-user-fg", v.userBubbleFg);
  }
  root.style.setProperty("--chat-ai", v.aiBubble);
  root.style.setProperty("--chat-ai-text", v.aiText);
  root.style.setProperty("--chat-font", chatThemeFontStack(preset));
  root.style.setProperty("--chat-font-weight", String(chatThemeFontWeightValue(preset)));
  root.style.setProperty("--chat-tracking", `${preset.tracking}px`);
  root.style.setProperty("--chat-line-height", String(preset.lineHeight));

  // Multi-stop gradient: the two old vars are replaced by a single stop-list
  // string (`--chat-gradient`) so any number of stops renders.
  if (preset.bgType === "gradient" && v.stops.length >= 2) {
    root.style.setProperty("--chat-gradient", v.stops.join(", "));
  } else {
    root.style.removeProperty("--chat-gradient");
  }

  // data attributes drive the gradient/pattern/bubble/radius/shadow CSS.
  root.setAttribute("data-chat-bgtype", preset.bgType);
  root.setAttribute("data-chat-pattern", preset.pattern);
  root.setAttribute("data-chat-bubble", preset.bubbleStyle);
  root.setAttribute("data-chat-radius", preset.radius);
  root.setAttribute("data-chat-shadow", preset.shadow);
}

// ── Accent colour ─────────────────────────────────────────────────────────────

export const ACCENT_KEY = "accentColor";

/**
 * Apply an accent preset by id. The accent trio depends on BOTH the preset and
 * the current theme (dark vs light), which plain CSS `[data-theme]` selectors
 * can't express — so we resolve the right variant here and inject the four
 * accent CSS variables inline on `<html>` (same override mechanism as
 * `applyFontScale`). Reads the live `data-theme` attribute so it must run after
 * `applyTheme`.
 */
export function applyAccent(accentId: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = resolveAccentPreset(accentId);
  const mode = root.getAttribute("data-theme") === "light" ? "light" : "dark";
  const v = preset[mode];
  root.style.setProperty("--accent", v.accent);
  root.style.setProperty("--accent-hover", v.hover);
  root.style.setProperty("--accent-fg", v.fg);
  root.style.setProperty("--accent-dim", v.dim);
}

// Single MQ listener — stored so we can remove it before re-adding
let _systemMqHandler: ((e: MediaQueryListEvent) => void) | null = null;
let _systemMq: MediaQueryList | null = null;

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;

  // Always tear down the previous system listener first
  if (_systemMq && _systemMqHandler) {
    _systemMq.removeEventListener("change", _systemMqHandler);
    _systemMqHandler = null;
    _systemMq = null;
  }

  if (theme === "system") {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.setAttribute("data-theme", e.matches ? "light" : "dark");
      // Accent variants differ per theme — re-resolve when the OS flips.
      applyAccent(storage.get<string>(ACCENT_KEY) ?? DEFAULT_ACCENT_ID);
      // Chat theme palettes are per-mode too.
      applyChatTheme(storage.get<string>(CHAT_THEME_KEY) ?? DEFAULT_CHAT_THEME_ID);
    };
    mq.addEventListener("change", handler);
    _systemMq = mq;
    _systemMqHandler = handler;
    document.documentElement.setAttribute("data-theme", mq.matches ? "light" : "dark");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }

  // The active data-theme just changed; re-resolve the accent trio for it.
  applyAccent(storage.get<string>(ACCENT_KEY) ?? DEFAULT_ACCENT_ID);
  // ...and the chat-theme palette for the new mode.
  applyChatTheme(storage.get<string>(CHAT_THEME_KEY) ?? DEFAULT_CHAT_THEME_ID);
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface AppearanceSlice {
  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;

  // Accent colour
  accentColor: string;
  setAccentColor: (accentId: string) => void;

  // Font scale
  fontScale: FontScale;
  setFontScale: (scale: FontScale) => void;

  // Note-text font family
  fontFamily: FontFamilyId;
  setFontFamily: (fontId: FontFamilyId) => void;

  // Chat theme (id string — may be a built-in or a community theme id)
  chatTheme: string;
  setChatTheme: (themeId: string) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createAppearanceSlice: StateCreator<CairnStore, [], [], AppearanceSlice> = (
  set,
) => ({
  theme: "dark" as Theme,
  accentColor: DEFAULT_ACCENT_ID,
  fontScale: DEFAULT_FONT_SCALE, // 1.2 = M (~16.8px)
  fontFamily: DEFAULT_FONT_ID, // note-text font: sans / serif / mono
  chatTheme: DEFAULT_CHAT_THEME_ID, // chat theme: built-in or community id

  // ── Theme ──────────────────────────────────────
  setTheme(theme: Theme) {
    set({ theme });
    storage.set(THEME_KEY, theme);
    applyTheme(theme);
    if (typeof window !== "undefined" && window.electron) {
      window.electron.setTheme(theme);
    }
  },

  // ── Accent colour ──────────────────────────────
  setAccentColor(accentId: string) {
    set({ accentColor: accentId });
    storage.set(ACCENT_KEY, accentId);
    applyAccent(accentId);
    if (typeof window !== "undefined" && window.electron?.setAccent) {
      window.electron.setAccent(accentId);
    }
  },

  // ── Font scale ─────────────────────────────────
  setFontScale(scale: FontScale) {
    set({ fontScale: scale });
    storage.set(FONT_SCALE_KEY, scale);
    applyFontScale(scale);
  },

  // ── Note-text font family ─────────────────────
  setFontFamily(fontId: FontFamilyId) {
    set({ fontFamily: fontId });
    storage.set(FONT_FAMILY_KEY, fontId);
    applyFontFamily(fontId);
  },

  // ── Chat theme ────────────────────────────────
  setChatTheme(themeId: string) {
    set({ chatTheme: themeId });
    storage.set(CHAT_THEME_KEY, themeId);
    applyChatTheme(themeId);
  },
});
