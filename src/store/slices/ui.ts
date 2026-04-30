/**
 * UI slice — active selections, sidebar/chat/search toggles, theme, AI config.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID, AppUIState } from "@/types";
import { storage } from "@/lib/storage";
import { DEFAULT_AI_CONFIG, AI_CONFIG_KEY, ACTIVE_PROJECT_KEY } from "@/lib/constants";

// ── AI / MCP config ───────────────────────────────────────────────────────────

export interface AIConfig {
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark" | "system";
export const THEME_KEY = "theme";

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface UISlice extends AppUIState {
  // AI config
  aiConfig: AIConfig;
  setAIConfig: (patch: Partial<AIConfig>) => void;

  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;

  // Navigation / selections
  setActiveWorkspace: (id: ID) => void;
  setActiveProject: (id: ID | null) => void;
  setView: (view: AppUIState["activeView"]) => void;
  toggleSidebar: () => void;
  toggleChat: () => void;
  toggleSearch: () => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createUISlice: StateCreator<CairnStore, [], [], UISlice> = (
  set,
  get
) => ({
  // ── Initial state ──────────────────────────────
  activeWorkspaceId: null,
  activeProjectId: null,
  activeView: "overview",
  sidebarCollapsed: false,
  chatOpen: false,
  searchOpen: false,

  aiConfig: DEFAULT_AI_CONFIG,
  theme: "dark" as Theme,

  // ── AI config ──────────────────────────────────
  setAIConfig(patch) {
    set((s) => {
      const next = { ...s.aiConfig, ...patch };
      storage.set(AI_CONFIG_KEY, next);
      return { aiConfig: next };
    });
  },

  // ── Theme ──────────────────────────────────────
  setTheme(theme: Theme) {
    set({ theme });
    storage.set(THEME_KEY, theme);
    applyTheme(theme);
    if (typeof window !== "undefined" && window.electron) {
      window.electron.setTheme(theme);
    }
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const handler = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute(
          "data-theme",
          e.matches ? "light" : "dark"
        );
      };
      mq.addEventListener("change", handler);
    }
  },

  // ── Selections ─────────────────────────────────
  setActiveWorkspace(wsId) {
    const projects = get().projects.filter((p) => p.workspaceId === wsId);
    set({
      activeWorkspaceId: wsId,
      activeProjectId: projects[0]?.id ?? null,
      activeView: "overview",
    });
  },

  setActiveProject(projId) {
    set({ activeProjectId: projId, activeView: "overview" });
    if (projId) storage.set(ACTIVE_PROJECT_KEY, projId);
  },

  setView(view) {
    set({ activeView: view });
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  },

  toggleChat() {
    set((s) => ({ chatOpen: !s.chatOpen }));
  },

  toggleSearch() {
    set((s) => ({ searchOpen: !s.searchOpen }));
  },
});
