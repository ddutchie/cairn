/**
 * UI slice — thin composer over the appearance + ai-config + layout slices.
 *
 * Split in cleanup Phase 3 for maintainability; the combined store shape is
 * byte-identical to the old monolithic `ui.ts`, so all existing subscribers
 * keep working unchanged. Import slice-specific symbols from
 * `./ui-appearance`, `./ui-ai-config`, or `./ui-layout` in new code — the
 * re-exports below exist only for the existing importers.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import { createAppearanceSlice, type AppearanceSlice } from "./ui-appearance";
import { createAiConfigSlice, type AiConfigSlice } from "./ui-ai-config";
import { createLayoutSlice, type LayoutSlice } from "./ui-layout";

export interface UISlice extends AppearanceSlice, AiConfigSlice, LayoutSlice {}

export const createUISlice: StateCreator<CairnStore, [], [], UISlice> = (
  set,
  get,
  api
) => ({
  ...createAppearanceSlice(set, get, api),
  ...createLayoutSlice(set, get, api),
  ...createAiConfigSlice(set, get, api),
});

// ── Re-exports (backwards compatibility for existing importers) ───────────────

export type { AppearanceSlice } from "./ui-appearance";
export type { AiConfigSlice } from "./ui-ai-config";
export type { LayoutSlice } from "./ui-layout";

export {
  type Theme,
  THEME_KEY,
  type FontScale,
  FONT_SCALE_KEY,
  DEFAULT_FONT_SCALE,
  applyFontScale,
  type FontFamilyId,
  FONT_FAMILY_KEY,
  applyFontFamily,
  CHAT_THEME_KEY,
  setCommunityChatThemes,
  fetchAndCacheCommunityChatThemes,
  applyChatTheme,
  ACCENT_KEY,
  applyAccent,
  applyTheme,
} from "./ui-appearance";

export {
  type SavedProvider,
  type ApiMode,
  type InstalledPersonality,
  type ReasoningEffort,
  type AIConfig,
  type AgentConfig,
  dedupeProviders,
  migrateLlmKeysToKeychain,
} from "./ui-ai-config";

export {
  type ToggleableView,
  HIDDEN_VIEWS_KEY,
  SEEN_FEATURES_KEY,
  FAVORITE_MODELS_KEY,
  DEFAULT_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
  MAX_CHAT_PANEL_WIDTH,
  DEFAULT_NOTES_SIDEBAR_WIDTH,
  MIN_NOTES_SIDEBAR_WIDTH,
  MAX_NOTES_SIDEBAR_WIDTH,
} from "./ui-layout";
