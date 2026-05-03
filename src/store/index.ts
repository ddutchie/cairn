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
import { DEFAULT_AI_CONFIG, AI_CONFIG_KEY, ACTIVE_PROJECT_KEY } from "@/lib/constants";

// ── Slice imports ─────────────────────────────────────────────────────────────
import { createUISlice } from "./slices/ui";
import type { UISlice, AIConfig, Theme } from "./slices/ui";
import { applyTheme, THEME_KEY, applyFontScale, FONT_SCALE_KEY, DEFAULT_FONT_SCALE } from "./slices/ui";
import type { FontScale } from "./slices/ui";
import { createWorkspaceSlice } from "./slices/workspace";
import type { WorkspaceSlice } from "./slices/workspace";
import { createNotesSlice } from "./slices/notes";
import type { NotesSlice } from "./slices/notes";
import { createBoardSlice } from "./slices/board";
import type { BoardSlice } from "./slices/board";
import { createTagsSlice } from "./slices/tags";
import type { TagsSlice } from "./slices/tags";
import { createChatSlice } from "./slices/chat";
import type { ChatSlice } from "./slices/chat";
import { createSelectorsSlice } from "./slices/selectors";
import type { SelectorsSlice } from "./slices/selectors";
import { createGraphSlice } from "./slices/graph";
import type { GraphSlice } from "./slices/graph";

// Re-export types used by consumers and constants.ts
export type { AIConfig, Theme, FontScale };
export { DEFAULT_AI_CONFIG } from "@/lib/constants";

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
    SelectorsSlice,
    GraphSlice,
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
    ...createSelectorsSlice(...a),
    ...createGraphSlice(...a),

    // ── Hydration (cross-slice; stays in index.ts) ──
    hydrate() {
      const [, get] = a;

      const savedTheme = storage.get<Theme>(THEME_KEY);
      if (savedTheme) {
        a[0]({ theme: savedTheme });
        applyTheme(savedTheme);
      } else {
        applyTheme("dark");
      }

      const savedFontScale = storage.get<FontScale>(FONT_SCALE_KEY);
      if (savedFontScale) {
        a[0]({ fontScale: savedFontScale });
        applyFontScale(savedFontScale);
      } else {
        applyFontScale(DEFAULT_FONT_SCALE);
      }

      const savedConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      if (savedConfig) {
        a[0]({ aiConfig: { ...DEFAULT_AI_CONFIG, ...savedConfig } });
      }

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

      if (!isRefresh) {
        const savedTheme = storage.get<Theme>(THEME_KEY);
        if (savedTheme) {
          set({ theme: savedTheme });
          applyTheme(savedTheme);
        } else {
          applyTheme("dark");
        }

        const savedFontScale = storage.get<FontScale>(FONT_SCALE_KEY);
        if (savedFontScale) {
          set({ fontScale: savedFontScale });
          applyFontScale(savedFontScale);
        } else {
          applyFontScale(DEFAULT_FONT_SCALE);
        }
      }

      const savedConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      if (savedConfig) {
        set({ aiConfig: { ...DEFAULT_AI_CONFIG, ...savedConfig } });
      }

      const snap = (await window.electron!.snapshot()) as PersistedState;

      const current = get();

      // External (MCP/AI) write refreshes invalidate the undo stack.
      if (isRefresh) historyManager.clear();

      set({
        workspaces: snap.workspaces ?? [],
        projects: snap.projects ?? [],
        notes: snap.notes ?? [],
        columns: snap.columns ?? [],
        cards: snap.cards ?? [],
        tags: snap.tags ?? [],
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
