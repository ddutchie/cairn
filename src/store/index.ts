/**
 * Cairn — Root Zustand store.
 * Combines workspace, project, notes, board, chat, and UI slices.
 * Persisted to localStorage via the storage abstraction.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  Workspace,
  Project,
  Note,
  BoardColumn,
  TaskCard,
  Tag,
  ChatThread,
  ChatMessage,
} from "@/types";
import { storage } from "@/lib/storage";
import { historyManager } from "@/lib/history";
import { isOwnNoteWrite, isAiNoteWrite } from "./ipc";
import { DEFAULT_AI_CONFIG, DEFAULT_AGENT_CONFIG, AI_CONFIG_KEY, AGENT_CONFIG_KEY, ACTIVE_PROJECT_KEY, CHAT_PANEL_WIDTH_KEY, NOTES_SIDEBAR_WIDTH_KEY, NOTES_COLLAPSED_FOLDERS_KEY, OVERVIEW_COLLAPSED_KEY } from "@/lib/constants";
import { MIN_NOTES_SIDEBAR_WIDTH, MAX_NOTES_SIDEBAR_WIDTH } from "./slices/ui";

// ── Slice imports ─────────────────────────────────────────────────────────────
import { createUISlice } from "./slices/ui";
import type { UISlice, AIConfig, AgentConfig, Theme, ToggleableView } from "./slices/ui";
import { applyTheme, THEME_KEY, applyFontScale, FONT_SCALE_KEY, DEFAULT_FONT_SCALE, HIDDEN_VIEWS_KEY, SEEN_FEATURES_KEY, FAVORITE_MODELS_KEY, MIN_CHAT_PANEL_WIDTH, MAX_CHAT_PANEL_WIDTH, migrateLlmKeysToKeychain, applyAccent, ACCENT_KEY, applyFontFamily, FONT_FAMILY_KEY } from "./slices/ui";
import type { FontScale, FontFamilyId } from "./slices/ui";
import { DEFAULT_ACCENT_ID } from "../../shared/ui/accents";
import { DEFAULT_FONT_ID } from "../../shared/ui/fonts";
import { createWorkspaceSlice } from "./slices/workspace";
import type { WorkspaceSlice } from "./slices/workspace";
import { createNotesSlice } from "./slices/notes";
import type { NotesSlice } from "./slices/notes";
import { createBoardSlice } from "./slices/board";
import type { BoardSlice } from "./slices/board";
import { createTagsSlice } from "./slices/tags";
import type { TagsSlice } from "./slices/tags";
import { createCommandsSlice } from "./slices/commands";
import type { CommandsSlice } from "./slices/commands";
import { createAutomationsSlice } from "./slices/automations";
import type { AutomationsSlice } from "./slices/automations";
import { createNotificationsSlice } from "./slices/notifications";
import type { NotificationsSlice } from "./slices/notifications";
import { createChatSlice } from "./slices/chat";
import type { ChatSlice } from "./slices/chat";
import { createSelectorsSlice } from "./slices/selectors";
import type { SelectorsSlice } from "./slices/selectors";
import { createGraphSlice } from "./slices/graph";
import type { GraphSlice } from "./slices/graph";
import { createCodingAgentsSlice } from "./slices/coding-agents";
import type { CodingAgentsSlice } from "./slices/coding-agents";
import { createToolsSlice } from "./slices/tools";
import type { ToolsSlice } from "./slices/tools";
import { createUserStyleSlice } from "./slices/user-style";
import type { UserStyleSlice } from "./slices/user-style";
import { createTerminalSessionsSlice } from "./slices/terminal-sessions";
import type { TerminalSessionsSlice } from "./slices/terminal-sessions";

// Re-export types used by consumers and constants.ts
export type { AIConfig, AgentConfig, Theme, FontScale, FontFamilyId };
export { DEFAULT_AI_CONFIG, DEFAULT_AGENT_CONFIG } from "@/lib/constants";

// ── SearchResult (used by SelectorsSlice and components) ─────────────────────

export interface SearchResult {
  type: "note" | "card";
  id: string;
  title: string;
  snippet: string;
  projectId: string;
  projectName: string;
}

// ── Persisted shape ───────────────────────────────────────────────────────────

interface PersistedState {
  workspaces: Workspace[];
  projects: Project[];
  notes: Note[];
  columns: BoardColumn[];
  cards: TaskCard[];
  tags: Tag[];
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
}

// ── Hydration + persistence actions (cross-slice, live in index) ──────────────

interface HydrationSlice {
  hydrate: () => void;
  hydrateFromElectron: (isRefresh?: boolean) => Promise<void>;
  persist: () => void;
  applyServerSnapshot: (
    snap: Pick<
      PersistedState,
      "workspaces" | "projects" | "notes" | "columns" | "cards" | "tags"
    >
  ) => void;
}

// ── Full store type ───────────────────────────────────────────────────────────
// CairnStore is declared here (and exported) so all slice StateCreator
// generics can reference it via `import type { CairnStore } from "../index"`.

export interface CairnStore
  extends UISlice,
    WorkspaceSlice,
    NotesSlice,
    BoardSlice,
    TagsSlice,
    ChatSlice,
    CommandsSlice,
    AutomationsSlice,
    NotificationsSlice,
    SelectorsSlice,
    GraphSlice,
    CodingAgentsSlice,
    ToolsSlice,
    UserStyleSlice,
    TerminalSessionsSlice,
    HydrationSlice {}

// ── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_KEY = "state";
// AI_CONFIG_KEY and ACTIVE_PROJECT_KEY imported from @/lib/constants





function loadPersisted(): PersistedState | null {
  return storage.get<PersistedState>(STORAGE_KEY);
}

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function savePersisted(state: PersistedState): void {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    storage.set<PersistedState>(STORAGE_KEY, {
      workspaces: state.workspaces,
      projects: state.projects,
      notes: state.notes,
      columns: state.columns,
      cards: state.cards,
      tags: state.tags,
      chatThreads: state.chatThreads,
      chatMessages: state.chatMessages,
    });
  }, 200);
}

type PartialSetter = (partial: Partial<CairnStore>) => void;

/**
 * Reconcile a freshly-loaded snapshot array against the current in-memory
 * array, preserving object identity for entities that haven't changed.
 *
 * hydrateFromElectron() fires on every `db:changed` event and replaces
 * cards/columns/etc wholesale with brand-new objects deserialized from SQLite.
 * That churns every object's identity, which defeats React.memo across the
 * board (every card re-renders + re-parses markdown) and causes drag hitches
 * when a move write triggers a re-hydration. By reusing the previous reference
 * whenever an entity is deep-equal, unchanged rows keep their identity and the
 * memoized components skip re-rendering. Also returns the SAME array reference
 * when nothing changed at all, so top-level selectors bail out too.
 */
function reconcileById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  let changed = next.length !== prev.length;
  const result = next.map((item, i) => {
    const existing = prevById.get(item.id);
    if (existing && shallowEqualEntity(existing, item)) {
      if (existing !== prev[i]) changed = true; // same data, different position
      return existing;
    }
    changed = true;
    return item;
  });
  return changed ? result : prev;
}

/** Shallow field-by-field equality for flat entity records (values may be
 *  arrays, which are compared element-wise one level deep). */
function shallowEqualEntity<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Restore theme + font scale from localStorage and apply them to the DOM.
 * Shared by both hydration paths (`hydrate` / `hydrateFromElectron`).
 */
function restorePersistedTheme(set: PartialSetter): void {
  const savedTheme = storage.get<Theme>(THEME_KEY);
  if (savedTheme) {
    set({ theme: savedTheme });
    applyTheme(savedTheme);
  } else {
    applyTheme("dark");
  }

  // Accent must resolve AFTER the theme (its trio depends on the active
  // data-theme). applyTheme already re-applies the stored accent, but we also
  // sync it into the store state so the settings picker reflects the choice.
  const savedAccent = storage.get<string>(ACCENT_KEY) ?? DEFAULT_ACCENT_ID;
  set({ accentColor: savedAccent });
  applyAccent(savedAccent);

  const savedFontScale = storage.get<FontScale>(FONT_SCALE_KEY);
  if (savedFontScale) {
    set({ fontScale: savedFontScale });
    applyFontScale(savedFontScale);
  } else {
    applyFontScale(DEFAULT_FONT_SCALE);
  }

  // Note-text font family: apply the stored preset (falls back to sans).
  const savedFontFamily = storage.get<FontFamilyId>(FONT_FAMILY_KEY);
  set({ fontFamily: savedFontFamily ?? DEFAULT_FONT_ID });
  applyFontFamily(savedFontFamily ?? DEFAULT_FONT_ID);
}

/**
 * Restore persisted UI preferences (hidden views, seen features, panel widths)
 * from localStorage. Shared by both hydration paths.
 */
function restorePersistedUiPrefs(set: PartialSetter): void {
  const savedHidden = storage.get<ToggleableView[]>(HIDDEN_VIEWS_KEY);
  if (savedHidden) {
    set({ hiddenViews: new Set(savedHidden) });
  }

  const savedSeenFeatures = storage.get<string[]>(SEEN_FEATURES_KEY);
  if (savedSeenFeatures) {
    set({ seenFeatures: savedSeenFeatures });
  }

  const savedFavoriteModels = storage.get<string[]>(FAVORITE_MODELS_KEY);
  if (savedFavoriteModels) {
    set({ favoriteModels: new Set(savedFavoriteModels) });
  }

  const savedChatWidth = storage.get<number>(CHAT_PANEL_WIDTH_KEY);
  if (savedChatWidth) {
    set({ chatPanelWidth: Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, savedChatWidth)) });
  }

  const savedNotesWidth = storage.get<number>(NOTES_SIDEBAR_WIDTH_KEY);
  if (savedNotesWidth != null) {
    set({ notesSidebarWidth: Math.min(MAX_NOTES_SIDEBAR_WIDTH, Math.max(MIN_NOTES_SIDEBAR_WIDTH, savedNotesWidth)) });
  }

  const savedCollapsedFolders = storage.get<Record<string, boolean>>(NOTES_COLLAPSED_FOLDERS_KEY);
  if (savedCollapsedFolders && typeof savedCollapsedFolders === "object") {
    set({ notesCollapsedFolders: savedCollapsedFolders });
  }

  const savedOverviewSections = storage.get<Record<string, boolean>>(OVERVIEW_COLLAPSED_KEY);
  if (savedOverviewSections && typeof savedOverviewSections === "object") {
    set({ overviewCollapsedSections: savedOverviewSections });
  }
}

// ── Store creation ────────────────────────────────────────────────────────────
export const useCairnStore = create<CairnStore>()(
  subscribeWithSelector((...a) => ({
    // ── Compose all domain slices ──────────────────
    ...createUISlice(...a),
    ...createWorkspaceSlice(...a),
    ...createNotesSlice(...a),
    ...createBoardSlice(...a),
    ...createTagsSlice(...a),
    ...createChatSlice(...a),
    ...createCommandsSlice(...a),
    ...createAutomationsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createSelectorsSlice(...a),
    ...createGraphSlice(...a),
    ...createCodingAgentsSlice(...a),
    ...createToolsSlice(...a),
    ...createUserStyleSlice(...a),
    ...createTerminalSessionsSlice(...a),

    // ── Hydration (cross-slice; stays in index.ts) ──
    hydrate() {
      const [, get] = a;

      restorePersistedTheme(a[0]);

      const savedConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      if (savedConfig) {
        if (savedConfig.provider === ("apple-fm" as unknown as "openai" | "localllm")) {
          savedConfig.provider = "localllm";
          storage.set(AI_CONFIG_KEY, savedConfig);
        }
        a[0]({ aiConfig: { ...DEFAULT_AI_CONFIG, ...savedConfig } });
      }

      const savedAgentConfig = storage.get<AgentConfig>(AGENT_CONFIG_KEY);
      if (savedAgentConfig) {
        a[0]({ agentConfig: { ...DEFAULT_AGENT_CONFIG, ...savedAgentConfig } });
      } else if (savedConfig && savedConfig.provider !== "localllm") {
        const migrated = {
          baseUrl: savedConfig.baseUrl || DEFAULT_AGENT_CONFIG.baseUrl,
          model: savedConfig.model || DEFAULT_AGENT_CONFIG.model,
          apiKey: savedConfig.apiKey || DEFAULT_AGENT_CONFIG.apiKey,
          maxSteps: savedConfig.maxSteps || DEFAULT_AGENT_CONFIG.maxSteps,
          temperature: savedConfig.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
          contextLimit: savedConfig.contextLimit || DEFAULT_AGENT_CONFIG.contextLimit,
          autoApprove: DEFAULT_AGENT_CONFIG.autoApprove,
        };
        a[0]({ agentConfig: migrated });
        storage.set(AGENT_CONFIG_KEY, migrated);
      }

      restorePersistedUiPrefs(a[0]);

      const saved = loadPersisted();
      if (saved && saved.workspaces.length > 0) {
        a[0]({
          ...saved,
          activeWorkspaceId: saved.workspaces[0]?.id ?? null,
          activeProjectId: saved.projects[0]?.id ?? null,
        });
      }

      void get; // suppress unused warning
    },

    async hydrateFromElectron(isRefresh = false) {
      const [set, get] = a;

      // Fetch configurations from backend cache first if window.electron is available
      let backendAiConfig = null;
      let backendAgentConfig = null;

      if (window.electron) {
        try {
          if (window.electron.getAiSettings)    backendAiConfig = await window.electron.getAiSettings();
          if (window.electron.getAgentSettings) backendAgentConfig = await window.electron.getAgentSettings();
        } catch (e) {
          console.warn("Failed to fetch backend cached settings:", e);
        }
      }

      if (!isRefresh) {
        restorePersistedTheme(set);
      }

      // Merge, don't shadow: an older backend cache may be missing behavioural
      // fields (maxSteps/temperature/contextLimit/aiEnabled). Layering
      // localStorage UNDER the backend config preserves those fields instead of
      // letting a field-poor backend object reset them to DEFAULT_AI_CONFIG on
      // every hydrate (the "maxSteps reverts to 30" bug).
      const localAiConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      // On a REFRESH hydrate (fired after write-tool turns and every db:changed
      // event) the in-memory aiConfig is the source of truth for the live
      // session — the user may have just changed the model, and the async
      // saveAiSettings write may not have landed in the backend cache yet.
      // Layering the (possibly stale) backend cache on top would silently revert
      // that selection, which is the "have to clear chat twice for the new model
      // to apply" bug. So on refresh we prefer the current in-memory config over
      // the backend cache; on the initial hydrate the backend cache wins.
      const currentAiConfig = isRefresh ? get().aiConfig : undefined;
      const savedConfig = backendAiConfig
        ? { ...localAiConfig, ...backendAiConfig, ...currentAiConfig }
        : (currentAiConfig ?? localAiConfig);
      if (savedConfig) {
        if (savedConfig.provider === ("apple-fm" as unknown as "openai" | "localllm")) {
          savedConfig.provider = "localllm";
        }
        const mergedAiConfig = { ...DEFAULT_AI_CONFIG, ...savedConfig };
        set({ aiConfig: mergedAiConfig });
        // Persist the FULLY-merged config so localStorage never loses fields.
        storage.set(AI_CONFIG_KEY, mergedAiConfig);
        // Also write the merged config back to the backend cache — even when a
        // backendAiConfig already existed, since it may have been field-poor
        // (missing maxSteps/temperature/…). This lets the backend cache
        // self-heal in one hydrate instead of staying stale.
        if (window.electron && window.electron.saveAiSettings) {
          window.electron.saveAiSettings(mergedAiConfig as unknown as Record<string, unknown>).catch(() => {});
        }
      } else if (window.electron && window.electron.ai && window.electron.ai.localLLMStatus) {
        try {
          const status = await window.electron.ai.localLLMStatus();
          if (status.available) {
            set({ aiConfig: { ...DEFAULT_AI_CONFIG, provider: "localllm" } });
          } else {
            set({ aiConfig: DEFAULT_AI_CONFIG });
          }
        } catch (e) {
          console.warn("Failed to check localLLM availability on startup:", e);
          set({ aiConfig: DEFAULT_AI_CONFIG });
        }
      } else {
        set({ aiConfig: DEFAULT_AI_CONFIG });
      }

      // Layer localStorage UNDER the backend config (mirroring the AI path) so
      // UI-only fields the backend cache doesn't track (e.g. contextAuto) survive
      // a hydrate instead of being dropped when a backend config exists.
      const localAgentConfig = storage.get<AgentConfig>(AGENT_CONFIG_KEY);
      const savedAgentConfig = backendAgentConfig
        ? { ...localAgentConfig, ...backendAgentConfig }
        : localAgentConfig;
      if (savedAgentConfig) {
        set({ agentConfig: { ...DEFAULT_AGENT_CONFIG, ...savedAgentConfig } });
        storage.set(AGENT_CONFIG_KEY, savedAgentConfig);
        if (!backendAgentConfig && window.electron && window.electron.saveAgentSettings) {
          window.electron.saveAgentSettings(savedAgentConfig as unknown as Record<string, unknown>).catch(() => {});
        }
      } else if (savedConfig && savedConfig.provider !== "localllm") {
        const configRecord = savedConfig as unknown as Record<string, string | number | undefined>;
        const migrated: AgentConfig = {
          baseUrl: (configRecord.baseUrl as string) || DEFAULT_AGENT_CONFIG.baseUrl,
          model: (configRecord.model as string) || DEFAULT_AGENT_CONFIG.model,
          apiKey: (configRecord.apiKey as string) || DEFAULT_AGENT_CONFIG.apiKey,
          maxSteps: (configRecord.maxSteps as number) || DEFAULT_AGENT_CONFIG.maxSteps,
          temperature: (configRecord.temperature as number) ?? DEFAULT_AGENT_CONFIG.temperature,
          contextLimit: (configRecord.contextLimit as number) || DEFAULT_AGENT_CONFIG.contextLimit,
          autoApprove: DEFAULT_AGENT_CONFIG.autoApprove,
        };
        set({ agentConfig: migrated });
        storage.set(AGENT_CONFIG_KEY, migrated);
      } else {
        set({ agentConfig: DEFAULT_AGENT_CONFIG });
      }

      // One-time: relocate any raw LLM API keys (legacy top-level or per-provider)
      // into the OS keychain, replacing them with reference tokens. Persists the
      // scrubbed configs so plaintext keys leave localStorage + the settings cache.
      try {
        const cur = get();
        const migrated = await migrateLlmKeysToKeychain(cur.aiConfig, cur.agentConfig);
        if (migrated.changed) {
          set({ aiConfig: migrated.ai, agentConfig: migrated.agent });
          storage.set(AI_CONFIG_KEY, migrated.ai);
          storage.set(AGENT_CONFIG_KEY, migrated.agent);
          if (window.electron?.saveAiSettings) {
            window.electron.saveAiSettings(migrated.ai as unknown as Record<string, unknown>).catch(() => {});
          }
          if (window.electron?.saveAgentSettings) {
            window.electron.saveAgentSettings(migrated.agent as unknown as Record<string, unknown>).catch(() => {});
          }
        }
      } catch (e) {
        console.warn("LLM key keychain migration failed:", e);
      }

      restorePersistedUiPrefs(set);

      const snap = (await window.electron!.snapshot()) as PersistedState;

      const current = get();

      // External (MCP/AI) write refreshes invalidate the undo stack.
      if (isRefresh) historyManager.clear();

      // Merge snapshot notes: preserve any note that was recently written by
      // the user (within the own-write window) so we don't overwrite optimistic
      // state with a stale snapshot triggered by the WAL poller.
      //
      // Exception: notes the AI just wrote (chat executor / MCP) always take the
      // snapshot content — the AI's edit isn't in our in-memory copy, so keeping
      // the local version would hide it from the open editor.
      const snapNotes: Note[] = snap.notes ?? [];
      const mergedNotes = isRefresh
        ? snapNotes.map((sn) => {
            if (isOwnNoteWrite(sn.id) && !isAiNoteWrite(sn.id)) {
              return current.notes.find((cn) => cn.id === sn.id) ?? sn;
            }
            return sn;
          })
        : snapNotes;

      // Record "what's new" marks: on an external refresh (AI / MCP / sync), when
      // a note we already had in memory arrives with DIFFERENT body content, stash
      // the pre-change content so the editor can highlight the new lines the next
      // time the user opens it (or immediately, if that note is already open). We
      // only mark notes whose content we're actually adopting from the snapshot
      // (i.e. not the own-write ones we just preserved above), so the user's own
      // live typing is never flagged as "new".
      let nextChangeMarks = current.noteChangeMarks;
      if (isRefresh) {
        const currentById = new Map(current.notes.map((n) => [n.id, n]));
        for (const merged of mergedNotes) {
          const prevNote = currentById.get(merged.id);
          if (!prevNote) continue; // brand-new note — nothing to diff against
          // Skip own-writes we preserved (merged === prevNote reference).
          if (merged === prevNote) continue;
          const prevContent = prevNote.content ?? "";
          const nextContent = merged.content ?? "";
          if (prevContent === nextContent) continue; // unchanged body
          if (nextChangeMarks === current.noteChangeMarks) {
            nextChangeMarks = { ...current.noteChangeMarks };
          }
          // Keep the EARLIEST previous content if a mark already exists, so a
          // burst of edits before the user looks shows the full delta.
          if (!nextChangeMarks[merged.id]) {
            nextChangeMarks[merged.id] = { previousContent: prevContent, changedAt: Date.now() };
          } else {
            nextChangeMarks[merged.id] = { ...nextChangeMarks[merged.id], changedAt: Date.now() };
          }
        }
      }

      set({
        workspaces: reconcileById(current.workspaces, snap.workspaces ?? []),
        projects: reconcileById(current.projects, snap.projects ?? []),
        notes: reconcileById(current.notes, mergedNotes),
        noteChangeMarks: nextChangeMarks,
        columns: reconcileById(current.columns, snap.columns ?? []),
        cards: reconcileById(current.cards, snap.cards ?? []),
        tags: reconcileById(current.tags, snap.tags ?? []),
        // Chat (threads + messages) lives in localStorage and is managed by the
        // store directly — never overwrite it from the SQLite snapshot, which
        // doesn't include chat data. Doing so would zero out in-flight messages.
        activeWorkspaceId: isRefresh
          ? (current.activeWorkspaceId ?? snap.workspaces?.[0]?.id ?? null)
          : (snap.workspaces?.[0]?.id ?? null),
        activeProjectId: isRefresh
          ? (current.activeProjectId ?? snap.projects?.[0]?.id ?? null)
          : (() => {
              const saved = storage.get<string>(ACTIVE_PROJECT_KEY);
              const valid =
                saved &&
                snap.projects?.find(
                  (p: { id: string }) => p.id === saved
                );
              return valid ? saved : (snap.projects?.[0]?.id ?? null);
            })(),
      });

      // Chat threads/messages live in SQLite (write path in the chat slice) but
      // aren't in the snapshot above. On the initial hydrate, read them back so
      // conversations survive restarts + app updates — Chromium localStorage
      // (the only other copy) can be cleared or relocated by an update. On a
      // refresh hydrate we skip this to avoid clobbering in-flight chat state.
      if (!isRefresh) {
        const wsId = get().activeWorkspaceId;
        if (wsId) {
          void get().loadChatFromDb(wsId);
        }
      }

      // Workspace-global slash commands live in SQLite (command:* IPC) and aren't
      // in the snapshot. Refetch on every hydrate (cheap) so commands created in
      // another window / after a workspace switch stay in sync.
      {
        const wsId = get().activeWorkspaceId;
        if (wsId) {
          void get().fetchCommands(wsId);
        }
      }
    },

    persist() {
      const [, get] = a;
      savePersisted(get());
    },

    applyServerSnapshot(snap) {
      const [set, get] = a;
      set({
        workspaces: snap.workspaces ?? [],
        projects: snap.projects ?? [],
        notes: snap.notes ?? [],
        columns: snap.columns ?? [],
        cards: snap.cards ?? [],
        tags: snap.tags ?? [],
      });
      get().persist();
    },
  }))
);
