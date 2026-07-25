/**
 * UI slice — active selections, sidebar/chat/search toggles, theme, AI config.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID, AppUIState, SettingsSection } from "@/types";
import { storage } from "@/lib/storage";
import { id as genId } from "@/lib/utils";
import { DEFAULT_AI_CONFIG, DEFAULT_AGENT_CONFIG, AI_CONFIG_KEY, AGENT_CONFIG_KEY, ACTIVE_PROJECT_KEY, CHAT_PANEL_WIDTH_KEY, NOTES_SIDEBAR_WIDTH_KEY, NOTES_COLLAPSED_FOLDERS_KEY } from "@/lib/constants";

// ── View visibility ───────────────────────────────────────────────────────────

/** Views that can be hidden. Overview and Notes are always visible. */
export type ToggleableView = "board" | "flow" | "calendar" | "calendar-all" | "agent" | "graph" | "insights" | "chat";

export const HIDDEN_VIEWS_KEY = "hiddenViews";
export const SEEN_FEATURES_KEY = "seenFeatures";



// ── AI / MCP config ───────────────────────────────────────────────────────────

/**
 * A named, reusable cloud/local API connection. Lets the user save several
 * OpenAI-compatible endpoints (e.g. "OpenAI", "OpenRouter", "Local Ollama") and
 * switch between them without retyping the base URL, key, and model each time.
 * Applies only to the cloud/local API provider — On-Device Llama is unaffected.
 */
export interface SavedProvider {
  /** Stable id (uuid). */
  id: string;
  /** User-facing label shown in the switcher. */
  name: string;
  /** OpenAI-compatible chat completions endpoint root. */
  baseUrl: string;
  /** API key. Empty = use the server-side OPENAI_API_KEY env var / keyless local. */
  apiKey: string;
  /** Default model id for this provider. */
  model: string;
}

/**
 * The connection-carrying subset shared by AIConfig and AgentConfig, so the
 * mirror-into-config helpers below can operate on either one generically. The
 * saved-provider *list* itself is shared and lives on aiConfig.savedProviders.
 */
type ProviderCarrier = {
  baseUrl: string;
  apiKey: string;
  model: string;
  activeProviderId?: string;
};

/** Mirror a provider's connection into a config + mark it that config's active. */
function mirrorProvider<C extends ProviderCarrier>(config: C, p: SavedProvider): C {
  return { ...config, activeProviderId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
}

/**
 * Reconcile a config after the shared provider list changed. Only touches a
 * config that had a provider selected: if its active provider still exists,
 * re-mirror it (picks up edits); if it was just deleted, fall back to the first
 * remaining provider. A config with NO active provider is left untouched — an
 * unselected surface must never inherit list[0] or the other surface's choice.
 */
function reconcileConfig<C extends ProviderCarrier>(config: C, list: SavedProvider[]): C {
  if (!config.activeProviderId) return config; // never auto-select for an unselected surface
  const active = list.find((p) => p.id === config.activeProviderId);
  if (active) return mirrorProvider(config, active);
  const fallback = list[0];
  return fallback ? mirrorProvider(config, fallback) : config;
}

/** Persist an AIConfig to localStorage + the Electron backend cache. */
function persistAi(next: AIConfig): void {
  storage.set(AI_CONFIG_KEY, next);
  if (typeof window !== "undefined" && window.electron?.saveAiSettings) {
    window.electron.saveAiSettings(next as unknown as Record<string, unknown>).catch(() => {});
  }
}

/** Persist an AgentConfig to localStorage + the Electron backend cache. */
function persistAgent(next: AgentConfig): void {
  storage.set(AGENT_CONFIG_KEY, next);
  if (typeof window !== "undefined" && window.electron?.saveAgentSettings) {
    window.electron.saveAgentSettings(next as unknown as Record<string, unknown>).catch(() => {});
  }
}


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
  /**
   * When true, `contextLimit` tracks the models.dev-detected value for the
   * current model automatically. Turned off the moment the user sets a manual
   * value (custom input or preset). Defaults to true.
   */
  contextAuto?: boolean;
  /** When false, all in-app AI features are hidden/disabled. Defaults to true. */
  aiEnabled: boolean;
  /**
   * Route chat through the dispatch → research/write subagent architecture.
   * Global preference. Ignored on the on-device Llama provider (small models are
   * unreliable with the multi-hop split).
   */
  subagentsEnabled: boolean;
  /**
   * Saved cloud/local API connections the user can switch between. This list is
   * the single, SHARED source of truth — the coding agent picks from the same
   * list (it only tracks its own `activeProviderId` on `agentConfig`). The
   * active one's baseUrl/apiKey/model are mirrored into the top-level fields
   * above so every existing consumer keeps working unchanged.
   */
  savedProviders?: SavedProvider[];
  /** Id of the AI Chat's active saved provider (matches an entry in `savedProviders`). */
  activeProviderId?: string;
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
  /**
   * When true, `contextLimit` tracks the models.dev-detected value for the
   * current model automatically. Turned off the moment the user sets a manual
   * value (custom input or preset). Defaults to true.
   */
  contextAuto?: boolean;
  /** Automatically approve tool execution without prompt. */
  autoApprove: boolean;
  /**
   * Id of the active saved provider for the coding agent. The saved-provider
   * *list* is shared and lives on `aiConfig.savedProviders` (single source of
   * truth); the agent only tracks which one it has selected. The active
   * provider's baseUrl/apiKey/model are mirrored into the fields above so every
   * existing consumer keeps working unchanged.
   */
  activeProviderId?: string;
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

  // Saved cloud/local API providers — one SHARED list (on aiConfig), with a
  // per-config active selection. add/update/delete mutate the shared list and
  // reconcile both configs; select* choose the active provider for one config.
  addSavedProvider: (provider: Omit<SavedProvider, "id">, selectFor?: "ai" | "agent" | "both") => string;
  updateSavedProvider: (id: string, patch: Partial<Omit<SavedProvider, "id">>) => void;
  deleteSavedProvider: (id: string) => void;
  selectSavedProvider: (id: string) => void;
  selectAgentProvider: (id: string) => void;

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

  // Notes folder tree collapse state. Keyed by `${projectId}:${lowercasedPath}`
  // so each project remembers its own tree and the key survives the
  // case-insensitive folder dedupe in buildFolderTree. Presence = collapsed;
  // absence = expanded (folders default open). Persisted to localStorage.
  notesCollapsedFolders: Record<string, boolean>;
  toggleNotesFolder: (projectId: ID, folderPath: string) => void;
  setNotesFolderCollapsed: (projectId: ID, folderPath: string, collapsed: boolean) => void;

  // Distraction-free note editing: hides the notes-list sidebar (and app rail)
  // so the editor fills the window. Session-scoped (not persisted).
  notesFullscreen: boolean;
  toggleNotesFullscreen: () => void;
  setNotesFullscreen: (on: boolean) => void;

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

  /** Optional target section for the Settings view (consumed once on open). */
  settingsSection: SettingsSection | null;
  setSettingsSection: (section: SettingsSection | null) => void;

  /** Project scope for the workspace-wide Calendar view ([] = all projects).
   *  Dedicated to the calendar so it doesn't affect the graph/insights scope. */
  calendarProjectIds: string[];
  setCalendarProjectIds: (ids: string[]) => void;

  // Seen features for What's New modal
  seenFeatures: string[];
  markFeatureAsSeen: (id: string) => void;

  // App tutorial state
  tutorialActive: boolean;
  tutorialStepIndex: number;
  setTutorialActive: (active: boolean) => void;
  setTutorialStepIndex: (index: number) => void;

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
  settingsSection: null,
  calendarProjectIds: [],
  seenFeatures: [],  tutorialActive: false,
  tutorialStepIndex: 0,

  aiConfig: DEFAULT_AI_CONFIG,
  agentConfig: DEFAULT_AGENT_CONFIG,
  theme: "dark" as Theme,
  fontScale: DEFAULT_FONT_SCALE, // 1.2 = M (~16.8px)
  hiddenViews: new Set<ToggleableView>(),
  chatPanelWidth: DEFAULT_CHAT_PANEL_WIDTH,
  notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  notesCollapsedFolders: {},
  chatPoppedOut: false,
  notesFullscreen: false,
  // ── AI config ──────────────────────────────────
  setAIConfig(patch) {
    set((s) => {
      const next = { ...s.aiConfig, ...patch };
      persistAi(next);
      return { aiConfig: next };
    });
  },

  // ── Saved cloud/local API providers (shared list, per-config active) ───
  //
  // The provider LIST is a single shared source of truth on aiConfig; both the
  // AI Chat and the coding agent pick from it, each keeping its own
  // activeProviderId. add/update/delete mutate the list and reconcile BOTH
  // configs; select*/persistence write only the touched config(s).
  addSavedProvider(provider, selectFor = "ai") {
    const id = genId();
    set((s) => {
      const list = [...(s.aiConfig.savedProviders ?? []), { id, ...provider }];
      const added: SavedProvider = { id, ...provider };
      // AI config always owns the list; select it there when asked.
      const nextAi: AIConfig =
        selectFor === "ai" || selectFor === "both"
          ? { ...mirrorProvider(s.aiConfig, added), savedProviders: list }
          : { ...s.aiConfig, savedProviders: list };
      const nextAgent: AgentConfig =
        selectFor === "agent" || selectFor === "both"
          ? mirrorProvider(s.agentConfig, added)
          : s.agentConfig;
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
    return id;
  },

  updateSavedProvider(id, patch) {
    set((s) => {
      const list = (s.aiConfig.savedProviders ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p));
      // Re-mirror into whichever config(s) have this provider active.
      const nextAi: AIConfig = { ...reconcileConfig(s.aiConfig, list), savedProviders: list };
      const nextAgent: AgentConfig = reconcileConfig(s.agentConfig, list);
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
  },

  deleteSavedProvider(id) {
    set((s) => {
      const list = (s.aiConfig.savedProviders ?? []).filter((p) => p.id !== id);
      const nextAi: AIConfig = { ...reconcileConfig(s.aiConfig, list), savedProviders: list };
      const nextAgent: AgentConfig = reconcileConfig(s.agentConfig, list);
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
  },

  selectSavedProvider(id) {
    set((s) => {
      const p = (s.aiConfig.savedProviders ?? []).find((x) => x.id === id);
      if (!p) return {};
      const nextAi = mirrorProvider(s.aiConfig, p);
      persistAi(nextAi);
      return { aiConfig: nextAi };
    });
  },

  selectAgentProvider(id) {
    set((s) => {
      // The list lives on aiConfig; read it there.
      const p = (s.aiConfig.savedProviders ?? []).find((x) => x.id === id);
      if (!p) return {};
      const nextAgent = mirrorProvider(s.agentConfig, p);
      persistAgent(nextAgent);
      return { agentConfig: nextAgent };
    });
  },

  // ── Agent config ───────────────────────────────
  setAgentConfig(patch) {
    set((s) => {
      const next = { ...s.agentConfig, ...patch };
      persistAgent(next);
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

  // ── Notes folder collapse state ────────────────
  toggleNotesFolder(projectId, folderPath) {
    const key = `${projectId}:${folderPath.toLowerCase()}`;
    set((s) => {
      const next = { ...s.notesCollapsedFolders };
      if (next[key]) delete next[key]; // collapsed → expanded (drop entry)
      else next[key] = true;           // expanded → collapsed
      storage.set(NOTES_COLLAPSED_FOLDERS_KEY, next);
      return { notesCollapsedFolders: next };
    });
  },
  setNotesFolderCollapsed(projectId, folderPath, collapsed) {
    const key = `${projectId}:${folderPath.toLowerCase()}`;
    set((s) => {
      const next = { ...s.notesCollapsedFolders };
      if (collapsed) next[key] = true;
      else delete next[key];
      storage.set(NOTES_COLLAPSED_FOLDERS_KEY, next);
      return { notesCollapsedFolders: next };
    });
  },

  // ── Distraction-free note editing ──────────────
  toggleNotesFullscreen() {
    set((s) => ({ notesFullscreen: !s.notesFullscreen }));
  },
  setNotesFullscreen(on) {
    set({ notesFullscreen: on });
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

  setSettingsSection(section) {
    set({ settingsSection: section });
  },

  setCalendarProjectIds(ids) {
    set({ calendarProjectIds: ids });
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

  markFeatureAsSeen(id) {
    set((s) => {
      const next = s.seenFeatures.includes(id) ? s.seenFeatures : [...s.seenFeatures, id];
      storage.set(SEEN_FEATURES_KEY, next);
      return { seenFeatures: next };
    });
  },

  setTutorialActive(active) {
    set({ tutorialActive: active, tutorialStepIndex: 0 });
  },

  setTutorialStepIndex(index) {
    set({ tutorialStepIndex: index });
  },
});
