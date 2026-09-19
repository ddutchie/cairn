/**
 * UI layout slice — navigation/selections, panel widths, collapse states,
 * view visibility, tutorial, and other layout chrome.
 * Split out of `slices/ui.ts` (Phase 3); `slices/ui.ts` re-combines the
 * appearance + ai-config + layout slices with an identical store shape.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ContextPanel, ID, AppUIState, SessionPresentation, SettingsSection } from "@/types";
import { storage } from "@/lib/storage";
import { CHAT_PANEL_WIDTH_KEY, NOTES_SIDEBAR_WIDTH_KEY, NOTES_COLLAPSED_FOLDERS_KEY, OVERVIEW_COLLAPSED_KEY, DOCK_SIDEBAR_WORKSPACE_COLLAPSED_KEY, DOCK_SIDEBAR_CONVERSATIONS_COLLAPSED_KEY, ACTIVE_PROJECT_KEY } from "@/lib/constants";

// ── View visibility ───────────────────────────────────────────────────────────

/** Views that can be hidden. Overview and Notes are always visible. */
export type ToggleableView = "board" | "flow" | "calendar" | "calendar-all" | "agent" | "graph" | "insights" | "usage" | "chat";

export const HIDDEN_VIEWS_KEY = "hiddenViews";
export const SEEN_FEATURES_KEY = "seenFeatures";
export const FAVORITE_MODELS_KEY = "favoriteModels";

// ── Chat panel width ──────────────────────────────────────────────────────────

export const DEFAULT_CHAT_PANEL_WIDTH = 320; // px  (≈ w-80 at default font scale)
export const MIN_CHAT_PANEL_WIDTH     = 240; // px
export const MAX_CHAT_PANEL_WIDTH     = 1000; // px

// ── Notes sidebar width ───────────────────────────────────────────────────────

export const DEFAULT_NOTES_SIDEBAR_WIDTH = 224; // px  (≈ w-56)
export const MIN_NOTES_SIDEBAR_WIDTH     = 160; // px
export const MAX_NOTES_SIDEBAR_WIDTH     = 400; // px

// ── Slice interface ───────────────────────────────────────────────────────────

export interface LayoutSlice extends AppUIState {
  // View visibility
  hiddenViews: Set<ToggleableView>;
  toggleViewVisibility: (view: ToggleableView) => void;
  setHiddenViews: (views: ToggleableView[]) => void;

  // Favorited model ids (global, cross-provider). Favorited models sort to the
  // top of every model picker. Persisted to localStorage.
  favoriteModels: Set<string>;
  toggleFavoriteModel: (model: string) => void;

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

  // Project Overview section collapse state. Keyed by `${projectId}:${sectionId}`.
  // Presence = collapsed; absence = expanded (sections default open). Persisted
  // to localStorage.
  overviewCollapsedSections: Record<string, boolean>;
  toggleOverviewSection: (projectId: ID, sectionId: string) => void;

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
  activeContextPanel: ContextPanel | null;
  setActiveContextPanel: (panel: ContextPanel | null) => void;

  // Chat panel resizing state
  chatPanelResizing: boolean;
  setChatPanelResizing: (resizing: boolean) => void;

  // Last content view before entering chat or search mode
  lastContentView: AppUIState["lastContentView"];

  /** Transient placement of the selected conversation; intentionally not persisted. */
  sessionPresentation: SessionPresentation;
  setSessionPresentation: (presentation: SessionPresentation) => void;

  /** True for ~320ms after a drawer↔center switch. Committed atomically with
   *  the geometry change (unlike component-state flags, which land a frame
   *  late and make the slide snap instead of run). The panel includes
   *  left/width in its transition only while this is true, so sidebar
   *  collapse/expand tracking stays per-frame with no chasing lag. */
  chatSliding: boolean;
  setChatSliding: (sliding: boolean) => void;

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

  /** Notification center modal (openable from the title bar + sidebar bells). */
  notificationOpen: boolean;
  setNotificationOpen: (open: boolean) => void;

  /** Dock sidebar workspace tools collapsed (Automations → Notifications). Global, persisted, default expanded. */
  workspaceToolsCollapsed: boolean;
  toggleWorkspaceToolsCollapsed: () => void;
  setWorkspaceToolsCollapsed: (collapsed: boolean) => void;

  /** Dock sidebar conversations collapsed. Global, persisted, default expanded. */
  conversationsCollapsed: boolean;
  toggleConversationsCollapsed: () => void;
  setConversationsCollapsed: (collapsed: boolean) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createLayoutSlice: StateCreator<CairnStore, [], [], LayoutSlice> = (
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
  activeContextPanel: null,
  chatPanelResizing: false,
  lastContentView: "overview",
  sessionPresentation: "drawer",
  chatSliding: false,
  settingsSection: null,
  notificationOpen: false,
  calendarProjectIds: [],
  seenFeatures: [],  tutorialActive: false,
  tutorialStepIndex: 0,
  workspaceToolsCollapsed: false,
  conversationsCollapsed: false,

  hiddenViews: new Set<ToggleableView>(),
  favoriteModels: new Set<string>(),
  chatPanelWidth: DEFAULT_CHAT_PANEL_WIDTH,
  notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
  notesCollapsedFolders: {},
  overviewCollapsedSections: {},
  chatPoppedOut: false,
  notesFullscreen: false,

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

  // ── Favorite models ────────────────────────────
  toggleFavoriteModel(model) {
    set((s) => {
      const next = new Set(s.favoriteModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      storage.set(FAVORITE_MODELS_KEY, [...next]);
      return { favoriteModels: next };
    });
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

  // ── Project Overview section collapse state ─────
  toggleOverviewSection(projectId, sectionId) {
    const key = `${projectId}:${sectionId}`;
    set((s) => {
      const next = { ...s.overviewCollapsedSections };
      if (next[key]) delete next[key]; // collapsed → expanded (drop entry)
      else next[key] = true;           // expanded → collapsed
      storage.set(OVERVIEW_COLLAPSED_KEY, next);
      return { overviewCollapsedSections: next };
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
      activeContextPanel: null,
  lastContentView: "overview",
    });
    // Pull this workspace's chat threads/messages from SQLite (the durable
    // store) so switching workspaces surfaces their conversations.
    get().loadChatFromDb?.(wsId);
  },

  setActiveProject(projId) {
    set({ activeProjectId: projId, activeView: "overview", activePreviewItem: null, activeContextPanel: null, lastContentView: "overview" });
    if (projId) storage.set(ACTIVE_PROJECT_KEY, projId);
  },

  setView(view) {
    if (view !== "chat" && view !== "search") {
      const leavingCenter = get().sessionPresentation !== "drawer";
      set({
        activeView: view,
        lastContentView: view as AppUIState["lastContentView"],
        // The center presentation is a fullscreen overlay that only makes sense
        // for the chat view. Navigating anywhere else (sidebar, shortcuts,
        // topbar Chat toggle, ⌘/) must drop back to the drawer, otherwise the
        // overlay keeps covering the content it just navigated to.
        sessionPresentation: "drawer" as const,
        // Flag the geometry switch in the SAME commit so the panel's
        // left/width transition is armed before the values change.
        ...(leavingCenter ? { chatSliding: true } : {}),
      });
    } else {
      const enteringCenter = view === "chat" && get().sessionPresentation !== "center";
      set({
        activeView: view,
        ...(view === "chat" ? { sessionPresentation: "center" as const } : {}),
        ...(enteringCenter ? { chatSliding: true } : {}),
      });
    }
  },

  setSessionPresentation(presentation) {
    if (get().sessionPresentation === presentation) return;
    set({ sessionPresentation: presentation, chatSliding: true });
  },

  setChatSliding(sliding) {
    set({ chatSliding: sliding });
  },

  setSettingsSection(section) {
    set({ settingsSection: section });
  },

  setCalendarProjectIds(ids) {
    set({ calendarProjectIds: ids });
  },

  setActivePreviewItem(item) {
    set({ activePreviewItem: item, activeContextPanel: item });
  },

  setActiveContextPanel(panel) {
    set({ activeContextPanel: panel });
  },

  setChatPanelResizing(resizing) {
    set({ chatPanelResizing: resizing });
  },

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  },

  toggleChat() {
    set((s) => ({
      chatOpen: !s.chatOpen,
      // The global Chat affordance opens the drawer. The center view has its
      // own explicit setView("chat") transition.
      ...(s.chatOpen
        ? {}
        : {
            sessionPresentation: "drawer" as const,
            ...(s.sessionPresentation !== "drawer" ? { chatSliding: true } : {}),
          }),
    }));
  },

  toggleSearch() {
    set((s) => ({ searchOpen: !s.searchOpen }));
  },

  setNotificationOpen(open) {
    set({ notificationOpen: open });
  },

  toggleWorkspaceToolsCollapsed() {
    set((s) => {
      const next = !s.workspaceToolsCollapsed;
      storage.set(DOCK_SIDEBAR_WORKSPACE_COLLAPSED_KEY, next);
      return { workspaceToolsCollapsed: next };
    });
  },
  setWorkspaceToolsCollapsed(collapsed) {
    set({ workspaceToolsCollapsed: collapsed });
    storage.set(DOCK_SIDEBAR_WORKSPACE_COLLAPSED_KEY, collapsed);
  },

  toggleConversationsCollapsed() {
    set((s) => {
      const next = !s.conversationsCollapsed;
      storage.set(DOCK_SIDEBAR_CONVERSATIONS_COLLAPSED_KEY, next);
      return { conversationsCollapsed: next };
    });
  },
  setConversationsCollapsed(collapsed) {
    set({ conversationsCollapsed: collapsed });
    storage.set(DOCK_SIDEBAR_CONVERSATIONS_COLLAPSED_KEY, collapsed);
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
