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
  AppUIState,
  ID,
  Priority,
  ProjectStatus,
  PendingAction,
} from "@/types";
import { storage } from "@/lib/storage";
import { id, now } from "@/lib/utils";


// ── AI / MCP config (persisted separately so it survives seed resets) ──

export interface AIConfig {
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
  /** Whether the in-app MCP HTTP server is enabled for external clients */
  mcpEnabled: boolean;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  baseUrl: "https://api.openai.com",
  model: "gpt-4o-mini",
  apiKey: "",
  mcpEnabled: false,
};

const AI_CONFIG_KEY = "ai-config";

// ── Theme ─────────────────────────────────────────────

export type Theme = "light" | "dark" | "system";
const THEME_KEY = "theme";

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

// ── Persisted shape ───────────────────────────

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

// ── Full store shape ──────────────────────────

interface CairnStore extends PersistedState, AppUIState {
  // ── Init ──────────────────────────────────
  hydrate: () => void;
  hydrateFromElectron: (isRefresh?: boolean) => Promise<void>;
  persist: () => void;

  // ── AI config ─────────────────────────────
  aiConfig: AIConfig;
  setAIConfig: (patch: Partial<AIConfig>) => void;

  // ── Theme ──────────────────────────────────
  theme: Theme;
  setTheme: (theme: Theme) => void;

  // ── UI ────────────────────────────────────
  setActiveWorkspace: (id: ID) => void;
  setActiveProject: (id: ID | null) => void;
  setView: (view: AppUIState["activeView"]) => void;
  toggleSidebar: () => void;
  toggleChat: () => void;
  toggleSearch: () => void;

  // ── Workspaces ────────────────────────────
  createWorkspace: (name: string, icon?: string) => Promise<Workspace>;

  // ── Projects ──────────────────────────────
  createProject: (workspaceId: ID, name: string) => Promise<Project>;
  updateProject: (id: ID, patch: Partial<Project>) => void;
  archiveProject: (id: ID) => void;
  deleteProject: (id: ID) => void;

  // ── Notes ─────────────────────────────────
  createNote: (projectId: ID, title: string) => Note;
  updateNote: (id: ID, patch: Partial<Note>) => void;
  deleteNote: (id: ID) => void;
  linkNoteToCard: (noteId: ID, cardId: ID) => void;

  // ── Board ─────────────────────────────────
  createColumn: (projectId: ID, name: string) => BoardColumn;
  createCard: (columnId: ID, projectId: ID, title: string) => TaskCard;
  updateCard: (id: ID, patch: Partial<TaskCard>) => void;
  moveCard: (cardId: ID, targetColumnId: ID, targetIndex: number) => void;
  deleteCard: (id: ID) => void;
  reorderCards: (columnId: ID, cardIds: ID[]) => void;

  // ── Chat ──────────────────────────────────
  getOrCreateThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  addMessage: (threadId: ID, role: ChatMessage["role"], content: string, contextRefs?: ChatMessage["contextRefs"]) => ChatMessage;
  confirmAction: (action: PendingAction) => void;

  // ── Server snapshot merge (MCP → browser sync) ───
  applyServerSnapshot: (snap: Pick<PersistedState, "workspaces" | "projects" | "notes" | "columns" | "cards" | "tags">) => void;

  // ── Derived helpers ───────────────────────
  getProjectNotes: (projectId: ID) => Note[];
  getProjectColumns: (projectId: ID) => BoardColumn[];
  getColumnCards: (columnId: ID) => TaskCard[];
  getProjectCards: (projectId: ID) => TaskCard[];
  getTagById: (id: ID) => Tag | undefined;
  createTag: (workspaceId: ID, name: string, color?: string) => Tag;
  getWorkspaceProjects: (workspaceId: ID) => Project[];
  searchAll: (query: string) => SearchResult[];
}

export interface SearchResult {
  type: "note" | "card";
  id: ID;
  title: string;
  snippet: string;
  projectId: ID;
  projectName: string;
}

const STORAGE_KEY = "state";

/** True when running inside Electron (window.electron is exposed by preload) */
function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

/**
 * Fire-and-forget IPC call. Use for updates/deletes where ordering doesn't matter.
 */
function ipc(fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined): void {
  if (!isElectron() || !window.electron) return;
  fn(window.electron)?.catch?.((err: unknown) => {
    console.error("[cairn:ipc]", err);
  });
}

/**
 * Awaitable IPC call. Use for creates where subsequent operations depend on
 * this record existing in SQLite (e.g. createProject depends on createWorkspace).
 */
function ipcAwait(fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined): Promise<void> {
  if (!isElectron() || !window.electron) return Promise.resolve();
  return (fn(window.electron) ?? Promise.resolve()).then(() => undefined).catch((err: unknown) => {
    console.error("[cairn:ipc]", err);
  });
}

function loadPersisted(): PersistedState | null {
  return storage.get<PersistedState>(STORAGE_KEY);
}

function savePersisted(state: PersistedState): void {
  // In Electron, SQLite is the source of truth — mutations go via IPC.
  // localStorage is still written as a fast cache / fallback.
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
}

export const useCairnStore = create<CairnStore>()(
  subscribeWithSelector((set, get) => ({
    // ── Initial state (empty; hydrate() fills it) ──
    workspaces: [],
    projects: [],
    notes: [],
    columns: [],
    cards: [],
    tags: [],
    chatThreads: [],
    chatMessages: [],

    // ── AI config (loaded from storage) ───────────
    aiConfig: DEFAULT_AI_CONFIG,

    // ── Theme (loaded from storage) ───────────────
    theme: "dark" as Theme,

    // ── UI state ──────────────────────────────────
    activeWorkspaceId: null,
    activeProjectId: null,
    activeView: "overview",
    sidebarCollapsed: false,
    chatOpen: false,
    searchOpen: false,

    // ── Theme ─────────────────────────────────────
    setTheme(theme: Theme) {
      set({ theme });
      storage.set(THEME_KEY, theme);
      applyTheme(theme);
      // Persist to a file the main process can read for window backgroundColor
      if (typeof window !== "undefined" && window.electron) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window.electron as any).setTheme?.(theme);
      }
      // Keep system preference in sync
      if (theme === "system") {
        const mq = window.matchMedia("(prefers-color-scheme: light)");
        const handler = (e: MediaQueryListEvent) => {
          document.documentElement.setAttribute("data-theme", e.matches ? "light" : "dark");
        };
        mq.addEventListener("change", handler);
      }
    },

    // ── Hydration ─────────────────────────────────
    hydrate() {
      // Load theme first so there's no flash
      const savedTheme = storage.get<Theme>(THEME_KEY);
      if (savedTheme) {
        set({ theme: savedTheme });
        applyTheme(savedTheme);
      } else {
        applyTheme("dark");
      }

      // Load AI config separately (survives seed resets)
      const savedConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      if (savedConfig) {
        set({ aiConfig: { ...DEFAULT_AI_CONFIG, ...savedConfig } });
      }

      const saved = loadPersisted();
      if (saved && saved.workspaces.length > 0) {
        set({
          ...saved,
          activeWorkspaceId: saved.workspaces[0]?.id ?? null,
          activeProjectId: saved.projects[0]?.id ?? null,
        });
      }
    },

    async hydrateFromElectron(isRefresh = false) {
      // Load theme on first hydration only (system watcher may already be active)
      if (!isRefresh) {
        const savedTheme = storage.get<Theme>(THEME_KEY);
        if (savedTheme) {
          set({ theme: savedTheme });
          applyTheme(savedTheme);
        } else {
          applyTheme("dark");
        }
      }

      // Load AI config from localStorage (still used for settings in Electron)
      const savedConfig = storage.get<AIConfig>(AI_CONFIG_KEY);
      if (savedConfig) {
        set({ aiConfig: { ...DEFAULT_AI_CONFIG, ...savedConfig } });
      }

      // Pull full snapshot from SQLite via IPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snap = await (window.electron as any).snapshot() as PersistedState & {
        chatThreads?: PersistedState["chatThreads"];
        chatMessages?: PersistedState["chatMessages"];
      };

      const current = get();

      set({
        // Domain data — always refresh
        workspaces: snap.workspaces ?? [],
        projects: snap.projects ?? [],
        notes: snap.notes ?? [],
        columns: snap.columns ?? [],
        cards: snap.cards ?? [],
        tags: snap.tags ?? [],
        // Chat state — only set on first load, not on db:changed refreshes
        // (re-hydrating chat would clear the active conversation)
        ...(!isRefresh && {
          chatThreads: snap.chatThreads ?? [],
          chatMessages: snap.chatMessages ?? [],
        }),
        // Active selections — preserve existing on refresh, set on first load
        activeWorkspaceId: isRefresh
          ? (current.activeWorkspaceId ?? snap.workspaces?.[0]?.id ?? null)
          : (snap.workspaces?.[0]?.id ?? null),
        activeProjectId: isRefresh
          ? (current.activeProjectId ?? snap.projects?.[0]?.id ?? null)
          : (snap.projects?.[0]?.id ?? null),
      });
    },

    persist() {
      const s = get();
      savePersisted(s);
    },

    // ── Server snapshot merge ─────────────────────
    // Called by useSnapshotSync when it detects the server has a newer
    // version than what the browser last pushed (i.e. an MCP agent wrote
    // something). We replace the domain collections wholesale and persist
    // so the next browser-push reflects the MCP-written state.
    applyServerSnapshot(snap) {
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

    // ── AI config ─────────────────────────────────
    setAIConfig(patch) {
      set((s) => {
        const next = { ...s.aiConfig, ...patch };
        storage.set(AI_CONFIG_KEY, next);
        return { aiConfig: next };
      });
    },

    // ── UI ────────────────────────────────────────
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

    // ── Workspaces ────────────────────────────────
    async createWorkspace(name, icon) {
      const ws: Workspace = {
        id: id(),
        name,
        icon,
        createdAt: now(),
        updatedAt: now(),
      };
      set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
      get().persist();
      await ipcAwait((e) => e.workspace.create(ws));
      return ws;
    },

    // ── Projects ──────────────────────────────────
    async createProject(workspaceId, name) {
      const proj: Project = {
        id: id(),
        workspaceId,
        name,
        status: "active",
        priority: "medium",
        tagIds: [],
        createdAt: now(),
        updatedAt: now(),
      };
      // Create default columns
      const defaultColumns: BoardColumn[] = [
        { id: id(), projectId: proj.id, workspaceId, name: "Backlog", type: "backlog", order: 0, createdAt: now(), updatedAt: now() },
        { id: id(), projectId: proj.id, workspaceId, name: "Todo", type: "todo", order: 1, createdAt: now(), updatedAt: now() },
        { id: id(), projectId: proj.id, workspaceId, name: "In Progress", type: "in_progress", order: 2, createdAt: now(), updatedAt: now() },
        { id: id(), projectId: proj.id, workspaceId, name: "Review", type: "review", order: 3, createdAt: now(), updatedAt: now() },
        { id: id(), projectId: proj.id, workspaceId, name: "Done", type: "done", order: 4, createdAt: now(), updatedAt: now() },
      ];
      set((s) => ({
        projects: [...s.projects, proj],
        columns: [...s.columns, ...defaultColumns],
      }));
      get().persist();
      // Await project insert before columns (foreign key dependency)
      await ipcAwait((e) => e.project.create({ ...proj, workspaceId }));
      for (const col of defaultColumns) {
        await ipcAwait((e) => e.column.create(col));
      }
      return proj;
    },

    updateProject(projId, patch) {
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projId ? { ...p, ...patch, updatedAt: now() } : p
        ),
      }));
      get().persist();
      ipc((e) => e.project.update(projId, patch));
    },

    archiveProject(projId) {
      get().updateProject(projId, { archivedAt: now(), status: "archived" });
    },

    deleteProject(projId) {
      const s = get();
      // Determine next active project before removing
      const remaining = s.projects.filter((p) => p.id !== projId && !p.archivedAt);
      const nextProject = remaining[0]?.id ?? null;
      set((st) => ({
        projects: st.projects.filter((p) => p.id !== projId),
        notes: st.notes.filter((n) => n.projectId !== projId),
        columns: st.columns.filter((c) => c.projectId !== projId),
        cards: st.cards.filter((c) => c.projectId !== projId),
        // If deleted project was active, switch to next
        activeProjectId: st.activeProjectId === projId ? nextProject : st.activeProjectId,
        activeView: st.activeProjectId === projId ? "overview" : st.activeView,
      }));
      get().persist();
      ipc((e) => (e.project as { delete: (id: string) => Promise<unknown> }).delete(projId));
    },

    // ── Notes ─────────────────────────────────────
    createNote(projectId, title) {
      const proj = get().projects.find((p) => p.id === projectId);
      const note: Note = {
        id: id(),
        projectId,
        workspaceId: proj?.workspaceId ?? "",
        title,
        content: "",
        contentText: "",
        tagIds: [],
        linkedNoteIds: [],
        linkedCardIds: [],
        isPinned: false,
        createdAt: now(),
        updatedAt: now(),
      };
      set((s) => ({ notes: [...s.notes, note] }));
      get().persist();
      ipc((e) => e.note.create(note));
      return note;
    },

    updateNote(noteId, patch) {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId ? { ...n, ...patch, updatedAt: now() } : n
        ),
      }));
      get().persist();
      ipc((e) => e.note.update(noteId, patch));
    },

    deleteNote(noteId) {
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== noteId),
        cards: s.cards.map((c) => ({
          ...c,
          linkedNoteIds: c.linkedNoteIds.filter((nId) => nId !== noteId),
        })),
      }));
      get().persist();
      ipc((e) => e.note.delete(noteId));
    },

    linkNoteToCard(noteId, cardId) {
      set((s) => ({
        notes: s.notes.map((n) =>
          n.id === noteId
            ? { ...n, linkedCardIds: Array.from(new Set([...n.linkedCardIds, cardId])), updatedAt: now() }
            : n
        ),
        cards: s.cards.map((c) =>
          c.id === cardId
            ? { ...c, linkedNoteIds: Array.from(new Set([...c.linkedNoteIds, noteId])), updatedAt: now() }
            : c
        ),
      }));
      get().persist();
      // Update both sides in SQLite
      const note = get().notes.find((n) => n.id === noteId);
      const card = get().cards.find((c) => c.id === cardId);
      if (note) ipc((e) => e.note.update(noteId, { linkedCardIds: note.linkedCardIds }));
      if (card) ipc((e) => e.card.update(cardId, { linkedNoteIds: card.linkedNoteIds }));
    },

    // ── Board ─────────────────────────────────────
    createColumn(projectId, name) {
      const proj = get().projects.find((p) => p.id === projectId);
      const cols = get().columns.filter((c) => c.projectId === projectId);
      const col: BoardColumn = {
        id: id(),
        projectId,
        workspaceId: proj?.workspaceId ?? "",
        name,
        type: "custom",
        order: cols.length,
        createdAt: now(),
        updatedAt: now(),
      };
      set((s) => ({ columns: [...s.columns, col] }));
      get().persist();
      return col;
    },

    createCard(columnId, projectId, title) {
      const col = get().columns.find((c) => c.id === columnId);
      const cards = get().cards.filter((c) => c.columnId === columnId);
      const card: TaskCard = {
        id: id(),
        columnId,
        projectId,
        workspaceId: col?.workspaceId ?? "",
        title,
        tagIds: [],
        priority: "medium",
        linkedNoteIds: [],
        order: cards.length,
        createdAt: now(),
        updatedAt: now(),
      };
      set((s) => ({ cards: [...s.cards, card] }));
      get().persist();
      ipc((e) => e.card.create(card));
      return card;
    },

    updateCard(cardId, patch) {
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, ...patch, updatedAt: now() } : c
        ),
      }));
      get().persist();
      ipc((e) => e.card.update(cardId, patch));
    },

    moveCard(cardId, targetColumnId, targetIndex) {
      const cards = get().cards;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;

      // Remove from old column
      const oldColCards = cards
        .filter((c) => c.columnId === card.columnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order)
        .map((c, i) => ({ ...c, order: i }));

      // Insert into new column
      const newColCards = cards
        .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
        .sort((a, b) => a.order - b.order);

      newColCards.splice(targetIndex, 0, {
        ...card,
        columnId: targetColumnId,
        updatedAt: now(),
      });

      const reindexedNew = newColCards.map((c, i) => ({ ...c, order: i }));

      const untouched = cards.filter(
        (c) => c.columnId !== card.columnId && c.columnId !== targetColumnId
      );

      const isSameColumn = card.columnId === targetColumnId;

      set({
        cards: isSameColumn
          ? [...untouched, ...reindexedNew]
          : [...untouched, ...oldColCards, ...reindexedNew],
      });
      get().persist();
      // Persist column change and reordering to SQLite
      ipc((e) => e.card.update(cardId, { columnId: targetColumnId, order: targetIndex }));
    },

    deleteCard(cardId) {
      set((s) => ({
        cards: s.cards.filter((c) => c.id !== cardId),
        notes: s.notes.map((n) => ({
          ...n,
          linkedCardIds: n.linkedCardIds.filter((cId) => cId !== cardId),
        })),
      }));
      get().persist();
      ipc((e) => e.card.delete(cardId));
    },

    reorderCards(columnId, cardIds) {
      set((s) => ({
        cards: s.cards.map((c) => {
          if (c.columnId !== columnId) return c;
          const newOrder = cardIds.indexOf(c.id);
          return newOrder >= 0 ? { ...c, order: newOrder } : c;
        }),
      }));
      get().persist();
    },

    // ── Chat ──────────────────────────────────────
    getOrCreateThread(workspaceId, projectId) {
      const existing = get().chatThreads.find(
        (t) =>
          t.workspaceId === workspaceId &&
          (projectId ? t.projectId === projectId : !t.projectId)
      );
      if (existing) return existing;

      const thread: ChatThread = {
        id: id(),
        scope: projectId ? "project" : "workspace",
        workspaceId,
        projectId,
        createdAt: now(),
        updatedAt: now(),
      };
      set((s) => ({ chatThreads: [...s.chatThreads, thread] }));
      get().persist();
      // Persist to SQLite so thread survives restarts
      ipc((e) => e.chat.upsertThread(thread));
      return thread;
    },

    addMessage(threadId, role, content, contextRefs) {
      const msg: ChatMessage = {
        id: id(),
        threadId,
        role,
        content,
        contextRefs,
        createdAt: now(),
      };
      set((s) => ({
        chatMessages: [...s.chatMessages, msg],
        chatThreads: s.chatThreads.map((t) =>
          t.id === threadId ? { ...t, updatedAt: now() } : t
        ),
      }));
      get().persist();
      // Persist to SQLite so messages survive restarts
      ipc((e) => e.chat.addMessage(msg));
      // Also keep the thread's updatedAt current in SQLite
      const thread = get().chatThreads.find((t) => t.id === threadId);
      if (thread) ipc((e) => e.chat.upsertThread({ ...thread, updatedAt: now() }));
      return msg;
    },

    confirmAction(action) {
      // Dispatch write actions from AI chat
      const s = get();
      if (action.type === "create_note") {
        const { projectId, title } = action.payload as { projectId: ID; title: string };
        s.createNote(projectId, title);
      } else if (action.type === "create_task") {
        const { columnId, projectId, title } = action.payload as {
          columnId: ID;
          projectId: ID;
          title: string;
        };
        s.createCard(columnId, projectId, title);
      } else if (action.type === "update_task_status") {
        const { cardId, columnId } = action.payload as { cardId: ID; columnId: ID };
        s.moveCard(cardId, columnId, 0);
      }
    },

    // ── Derived ───────────────────────────────────
    getProjectNotes(projectId) {
      return get()
        .notes.filter((n) => n.projectId === projectId && !n.archivedAt)
        .sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
    },

    getProjectColumns(projectId) {
      return get()
        .columns.filter((c) => c.projectId === projectId)
        .sort((a, b) => a.order - b.order);
    },

    getColumnCards(columnId) {
      return get()
        .cards.filter((c) => c.columnId === columnId && !c.archivedAt)
        .sort((a, b) => a.order - b.order);
    },

    getProjectCards(projectId) {
      return get().cards.filter((c) => c.projectId === projectId && !c.archivedAt);
    },

    getTagById(tagId) {
      return get().tags.find((t) => t.id === tagId);
    },

    createTag(workspaceId, name, color = "#6366f1") {
      const tag: Tag = { id: id(), workspaceId, name, color };
      set((s) => ({ tags: [...s.tags, tag] }));
      get().persist();
      ipc((e) => e.tag.create(tag));
      return tag;
    },

    getWorkspaceProjects(workspaceId) {
      return get()
        .projects.filter((p) => p.workspaceId === workspaceId && !p.archivedAt)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    searchAll(query) {
      if (!query.trim()) return [];
      const q = query.toLowerCase();
      const s = get();
      const results: SearchResult[] = [];

      s.notes.forEach((n) => {
        if (n.archivedAt) return;
        if (n.title.toLowerCase().includes(q) || n.contentText.toLowerCase().includes(q)) {
          const proj = s.projects.find((p) => p.id === n.projectId);
          results.push({
            type: "note",
            id: n.id,
            title: n.title,
            snippet: n.contentText.slice(0, 120),
            projectId: n.projectId,
            projectName: proj?.name ?? "",
          });
        }
      });

      s.cards.forEach((c) => {
        if (c.archivedAt) return;
        if (
          c.title.toLowerCase().includes(q) ||
          (c.description ?? "").toLowerCase().includes(q)
        ) {
          const proj = s.projects.find((p) => p.id === c.projectId);
          results.push({
            type: "card",
            id: c.id,
            title: c.title,
            snippet: c.description?.slice(0, 120) ?? "",
            projectId: c.projectId,
            projectName: proj?.name ?? "",
          });
        }
      });

      return results.slice(0, 50);
    },
  }))
);
