/**
 * Shared chat-theme catalog — built-in presets + resolution.
 *
 * Chat themes are FULL distinct looks for the chat surface (Telegram/WhatsApp
 * style), NOT hue swaps — the global accent preset already owns "pick a
 * highlight colour". Each preset bundles a chat font (from the fonts.ts presets,
 * applied to chat text only, independent of the note-font setting), a
 * background treatment (solid / gradient / scanline pattern), a bubble style
 * (filled / glass / outlined), and a dark/light palette.
 *
 * Distribution: built-ins below are always available (zero network). Additional
 * themes ship via cairn-community as a `themes.json` manifest (see
 * shared/chat/registry-schema.ts `parseChatThemesManifest`); the app unions the
 * built-ins with fetched community themes. Everything here is pure data —
 * rendering is data-driven on both platforms (CSS vars on desktop, theme fields
 * + LinearGradient on mobile).
 *
 * IMPORTANT — the theme is rendered by BOTH the app and PDF? No: chat themes are
 * on-screen only (PDF export stays theme-agnostic). Fonts are restricted to the
 * 3 system stacks (no webfont bundling), backgrounds to solid/gradient/scanline,
 * so a theme is pure JSON — safe to hot-load from the community catalog.
 */

import { FONT_PRESETS } from "./fonts";
import type { RegistryThemeEntry } from "../chat/registry-schema";

/** Background treatment a chat theme can use. */
export type ChatBgType = "solid" | "gradient" | "pattern";

/** Per-theme bubble treatment. */
export type ChatBubbleStyle = "filled" | "glass" | "outlined";

/** One mode's palette. `gradient` present only when bgType === "gradient". */
export interface ChatThemeMode {
  /** Solid background colour (or the scanline pattern's base colour). */
  bg: string;
  /** Gradient stops [from, to] when bgType === "gradient". */
  gradient?: [string, string];
  /** User-bubble fill. */
  userBubble: string;
  /** Text on the user bubble (AA-chosen per palette). */
  userBubbleFg: string;
  /** AI-bubble fill (may be an rgba/translucent value for glass themes). */
  aiBubble: string;
  /** Optional override for outlined/glass AI text (e.g. phosphor green). */
  aiText?: string;
}

export interface ChatThemePreset {
  /** Stable id — persisted to storage; never reuse or rename. */
  id: string;
  /** Human label shown in the picker. */
  name: string;
  /** One-line description. */
  description: string;
  /** The chat font this theme bundles (id from fonts.ts). Applied to chat
   *  text only — independent of the global note-font setting. */
  font: "sans" | "serif" | "mono";
  /** Background treatment. */
  bgType: ChatBgType;
  /** Bubble style. */
  bubbleStyle: ChatBubbleStyle;
  /** Whether this theme came from the community catalog (not a built-in). */
  community?: boolean;
  dark: ChatThemeMode;
  light: ChatThemeMode;
}

/**
 * The built-in chat themes, in picker order. `default` byte-matches today's
 * rendering (surface bg, accent user bubble, surface-2 AI bubble) so non-themers
 * see zero change. All light-mode userBubble fills verified ≥4.5:1 AA against
 * white userBubbleFg; secondary/tertiary text on light backgrounds uses the
 * dark textTertiary (#66635f), never the washed-out light one.
 */
export const CHAT_THEME_PRESETS: ChatThemePreset[] = [
  {
    id: "default",
    name: "Default",
    description: "System sans · solid · filled — the classic Cairn look.",
    font: "sans",
    bgType: "solid",
    bubbleStyle: "filled",
    dark: { bg: "#141414", userBubble: "#8faf6f", userBubbleFg: "#131c0b", aiBubble: "#1a1a1a" },
    light: { bg: "#ffffff", userBubble: "#5c7a3f", userBubbleFg: "#ffffff", aiBubble: "#f0eeeb" },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Serif · warm cream · soft filled — editorial reading.",
    font: "serif",
    bgType: "solid",
    bubbleStyle: "filled",
    dark: { bg: "#1c1915", userBubble: "#c9a06b", userBubbleFg: "#241608", aiBubble: "#26211a" },
    light: { bg: "#faf6ee", userBubble: "#9a6a1f", userBubbleFg: "#ffffff", aiBubble: "#f3ede1" },
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Mono · charcoal-green scanlines · outlined.",
    font: "mono",
    bgType: "pattern",
    bubbleStyle: "outlined",
    dark: {
      bg: "#0d1210", userBubble: "#7ba05a", userBubbleFg: "#0c1208", aiBubble: "#17211b",
      aiText: "#9fd47f",
    },
    light: {
      bg: "#eef2e8", userBubble: "#557a34", userBubbleFg: "#ffffff", aiBubble: "#e2e8d8",
      aiText: "#2f5d1e",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Sans · indigo→violet gradient · glass.",
    font: "sans",
    bgType: "gradient",
    bubbleStyle: "glass",
    dark: {
      bg: "#0b0d14", gradient: ["#0b0d14", "#1a1430"],
      userBubble: "#6b8fe0", userBubbleFg: "#0d1430", aiBubble: "rgba(38,44,78,0.75)",
    },
    light: {
      bg: "#eef1f8", gradient: ["#eef1f8", "#e4e7f7"],
      userBubble: "#3a5fd6", userBubbleFg: "#ffffff", aiBubble: "rgba(255,255,255,0.85)",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Sans · pink→purple gradient · vivid filled.",
    font: "sans",
    bgType: "gradient",
    bubbleStyle: "filled",
    dark: {
      bg: "#1a0f24", gradient: ["#1a0f24", "#2a0f33"],
      userBubble: "#ff5f8f", userBubbleFg: "#2a0f33", aiBubble: "#2a1a36",
    },
    light: {
      bg: "#fdf0f6", gradient: ["#fdf0f6", "#f5e4f4"],
      userBubble: "#c23373", userBubbleFg: "#ffffff", aiBubble: "#ffffff",
    },
  },
];

/** The default chat theme id. */
export const DEFAULT_CHAT_THEME_ID = "default";

/** Fast lookup by id. */
export const CHAT_THEME_PRESET_BY_ID: Record<string, ChatThemePreset> = Object.fromEntries(
  CHAT_THEME_PRESETS.map((p) => [p.id, p]),
);

/**
 * Resolve a stored chat-theme id to a preset, falling back to the default.
 * `extras` lets the renderer overlay fetched community themes so an id that
 * isn't a built-in resolves when present in the catalog.
 */
export function resolveChatTheme(
  id?: string | null,
  extras: ChatThemePreset[] = [],
): ChatThemePreset {
  if (id) {
    if (CHAT_THEME_PRESET_BY_ID[id]) return CHAT_THEME_PRESET_BY_ID[id];
    const extra = extras.find((p) => p.id === id);
    if (extra) return extra;
  }
  return CHAT_THEME_PRESET_BY_ID[DEFAULT_CHAT_THEME_ID];
}

/** All known themes: built-ins first, then community entries (deduped by id). */
export function allChatThemes(extras: ChatThemePreset[] = []): ChatThemePreset[] {
  const seen = new Set<string>();
  const out: ChatThemePreset[] = [];
  for (const p of [...CHAT_THEME_PRESETS, ...extras]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * The CSS font-family stack a chat theme uses for chat text. Reuses the
 * fonts.ts cssFamily for the theme's bundled font id so desktop, mobile, and
 * the PDF-capture path agree on one stack. (PDF export is theme-agnostic, but
 * chat text on screen uses this.)
 */
export function chatThemeFontStack(preset: ChatThemePreset): string {
  const font = FONT_PRESETS.find((f) => f.id === preset.font);
  return font ? font.cssFamily : (FONT_PRESETS[0]?.cssFamily ?? "system-ui, sans-serif");
}

/**
 * Convert a validated community registry theme entry into the renderer's
 * ChatThemePreset shape so `resolveChatTheme`/`allChatThemes` can consume
 * fetched catalog themes uniformly with built-ins.
 */
export function registryThemeToPreset(entry: RegistryThemeEntry): ChatThemePreset {
  const d = entry.definition;
  return {
    id: entry.id,
    name: d.name,
    description: d.description ?? entry.blurb ?? "",
    font: d.font,
    bgType: d.bgType,
    bubbleStyle: d.bubbleStyle,
    community: true,
    dark: d.dark,
    light: d.light,
  };
}

/** Convert a full themes manifest into preset form (validated entries only). */
export function manifestToChatThemes(
  themes: RegistryThemeEntry[] | undefined | null,
): ChatThemePreset[] {
  return (themes ?? []).map(registryThemeToPreset);
}
