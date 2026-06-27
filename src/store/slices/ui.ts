/**
 * UI slice — active selections, sidebar/chat/search toggles, theme, AI config.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID, AppUIState } from "@/types";
import { storage } from "@/lib/storage";
import { DEFAULT_AI_CONFIG, DEFAULT_AGENT_CONFIG, AI_CONFIG_KEY, AGENT_CONFIG_KEY, ACTIVE_PROJECT_KEY, CHAT_PANEL_WIDTH_KEY, NOTES_SIDEBAR_WIDTH_KEY } from "@/lib/constants";

// ── View visibility ───────────────────────────────────────────────────────────

/** Views that can be hidden. Overview and Notes are always visible. */
export type ToggleableView = "board" | "flow" | "agent" | "graph" | "insights" | "chat";

export const HIDDEN_VIEWS_KEY = "hiddenViews";



// ── AI / MCP config ───────────────────────────────────────────────────────────

export interface AIConfig {
  /** The AI provider ('openai' or 'localllm') */
  provider?: "openai" | "localllm";
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
  /** Maximum tool-call rounds per chat message. Lower = fewer API calls = lower cost. */
  maxSteps: number;
  /** LLM sampling temperature (0–1). Lower = more deterministic. Applied to the agent loop. */
  temperature: number;
  /** Context window size in tokens. Used to render the context usage ring. */
  contextLimit: number;
  /** When false, all in-app AI features are hidden/disabled. Defaults to true. */
  aiEnabled: boolean;
}

export interface AgentConfig {
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
  /** Maximum tool-call rounds per chat message. */
  maxSteps: number;
  /** LLM sampling temperature (0–1). Lower = more deterministic. */
  temperature: number;
  /** Context window size in tokens. Used to render the context usage ring. */
  contextLimit: number;
  /** Automatically approve tool execution without prompt. */
  autoApprove: boolean;
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark" | "system";
export const THEME_KEY = "theme";

// ── Chat panel width ──────────────────────────────────────────────────────────

export const DEFAULT_CHAT_PANEL_WIDTH = 320; // px  (≈ w-80 at default font scale)
export const MIN_CHAT_PANEL_WIDTH     = 240; // px
export const MAX_CHAT_PANEL_WIDTH     = 600; // px

// ── Notes sidebar width ───────────────────────────────────────────────────────

export const DEFAULT_NOTES_SIDEBAR_WIDTH = 224; // px  (≈ w-56)
export const MIN_NOTES_SIDEBAR_WIDTH     = 160; // px
export const MAX_NOTES_SIDEBAR_WIDTH     = 400; // px

// ── Font scale ────────────────────────────────────────────────────────────────

export type FontScale = 1 | 1.1 | 1.2 | 1.3 | 1.4;
export const FONT_SCALE_KEY = "fontScale";
export const DEFAULT_FONT_SCALE: FontScale = 1.2;

export function applyFontScale(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-scale", String(scale));
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
    };
    mq.addEventListener("change", handler);
    _systemMq = mq;
    _systemMqHandler = handler;
    document.documentElement.setAttribute("data-theme", mq.matches ? "light" : "dark");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface UISlice extends AppUIState {
  // AI config
  aiConfig: AIConfig;
  setAIConfig: (patch: Partial<AIConfig>) => void;

  // Agent config
  agentConfig: AgentConfig;
  setAgentConfig: (patch: Partial<AgentConfig>) => void;

  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;

  // Font scale
  fontScale: FontScale;
  setFontScale: (scale: FontScale) => void;

  // View visibility
  hiddenViews: Set<ToggleableView>;
  toggleViewVisibility: (view: ToggleableView) => void;
  setHiddenViews: (views: ToggleableView[]) => void;

  // Chat panel width
  chatPanelWidth: number;
  setChatPanelWidth: (width: number) => void;

  // Notes sidebar width
  notesSidebarWidth: number;
  setNotesSidebarWidth: (width: number) => void;

  // Pop-out chat
  chatPoppedOut: boolean;
  setChatPoppedOut: (popped: boolean) => void;

  // Active preview item for chat-centric layout
  activePreviewItem: { type: "note" | "task"; id: ID } | null;
  setActivePreviewItem: (item: { type: "note" | "task"; id: ID } | null) => void;

  // Chat panel resizing state
  chatPanelResizing: boolean;
  setChatPanelResizing: (resizing: boolean) => void;

  // Last content view before entering chat or search mode
  lastContentView: AppUIState["lastContentView"];

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
  activePreviewItem: null,
  chatPanelResizing: false,
  lastContentView: "overview",

  aiConfig: DEFAULT_AI_CONFIG,
  agentConfig: DEFAULT_AGENT_CONFIG,
  theme: "dark" as Theme,
  fontScale: DEFAULT_FONT_SCALE, // 1.2 = M (~16.8px)
  hiddenViews: new Set<ToggleableView>(),
  chatPanelWidth: DEFAULT_CHAT_PANEL_WIDTH,
  notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  chatPoppedOut: false,

  // ── AI config ──────────────────────────────────
  setAIConfig(patch) {
    set((s) => {
      const next = { ...s.aiConfig, ...patch };
      storage.set(AI_CONFIG_KEY, next);
      if (typeof window !== "undefined" && window.electron && window.electron.saveAiSettings) {
        window.electron.saveAiSettings(next).catch(() => {});
      }
      return { aiConfig: next };
    });
  },

  // ── Agent config ───────────────────────────────
  setAgentConfig(patch) {
    set((s) => {
      const next = { ...s.agentConfig, ...patch };
      storage.set(AGENT_CONFIG_KEY, next);
      if (typeof window !== "undefined" && window.electron && window.electron.saveAgentSettings) {
        window.electron.saveAgentSettings(next).catch(() => {});
      }
      return { agentConfig: next };
    });
  },

  // ── View visibility ─────────────────────────────
  toggleViewVisibility(view) {
    set((s) => {
      const hidden = new Set(s.hiddenViews);
      if (hidden.has(view)) {
        hidden.delete(view);
      } else {
        hidden.add(view);
      }
      storage.set(HIDDEN_VIEWS_KEY, [...hidden]);
      // Close the chat panel if the chat view is being hidden while it's open
      if (view === "chat" && !s.hiddenViews.has("chat") && s.chatOpen) {
        return { hiddenViews: hidden, chatOpen: false };
      }
      return { hiddenViews: hidden };
    });
  },

  setHiddenViews(views) {
    const hidden = new Set<ToggleableView>(views);
    storage.set(HIDDEN_VIEWS_KEY, [...hidden]);
    set({ hiddenViews: hidden });
  },

  // ── Theme ──────────────────────────────────────
  setTheme(theme: Theme) {
    set({ theme });
    storage.set(THEME_KEY, theme);
    applyTheme(theme);
    if (typeof window !== "undefined" && window.electron) {
      window.electron.setTheme(theme);
    }
  },

  // ── Font scale ─────────────────────────────────
  setFontScale(scale: FontScale) {
    set({ fontScale: scale });
    storage.set(FONT_SCALE_KEY, scale);
    applyFontScale(scale);
  },

  // ── Chat panel width ───────────────────────────
  setChatPanelWidth(width) {
    const clamped = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, width));
    set({ chatPanelWidth: clamped });
    storage.set(CHAT_PANEL_WIDTH_KEY, clamped);
  },

  // ── Notes sidebar width ────────────────────────
  setNotesSidebarWidth(width) {
    const clamped = Math.min(MAX_NOTES_SIDEBAR_WIDTH, Math.max(MIN_NOTES_SIDEBAR_WIDTH, width));
    set({ notesSidebarWidth: clamped });
    storage.set(NOTES_SIDEBAR_WIDTH_KEY, clamped);
  },

  // ── Pop-out chat ───────────────────────────────
  setChatPoppedOut(popped) {
    set({ chatPoppedOut: popped });
  },

  // ── Selections ─────────────────────────────────
  setActiveWorkspace(wsId) {
    const projects = get().projects.filter((p) => p.workspaceId === wsId);
    set({
      activeWorkspaceId: wsId,
      activeProjectId: projects[0]?.id ?? null,
      activeView: "overview",
      activePreviewItem: null,
      lastContentView: "overview",
    });
  },

  setActiveProject(projId) {
    set({ activeProjectId: projId, activeView: "overview", activePreviewItem: null, lastContentView: "overview" });
    if (projId) storage.set(ACTIVE_PROJECT_KEY, projId);
  },

  setView(view) {
    if (view !== "chat" && view !== "search") {
      set({ activeView: view, lastContentView: view as AppUIState["lastContentView"] });
    } else {
      set({ activeView: view });
    }
  },

  setActivePreviewItem(item) {
    set({ activePreviewItem: item });
  },

  setChatPanelResizing(resizing) {
    set({ chatPanelResizing: resizing });
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
