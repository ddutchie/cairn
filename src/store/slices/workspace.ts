/**
 * Workspace + Project slice.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Workspace, Project, BoardColumn, ID } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc, ipcAwait, ipcAwaitResult, isElectron } from "../ipc";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface WorkspaceSlice {
  workspaces: Workspace[];
  projects: Project[];

  createWorkspace: (
    name: string,
    icon?: string
  ) => Promise<Workspace>;
  updateWorkspace: (
    id: ID,
    patch: Partial<Pick<Workspace, "name" | "description" | "icon">>
  ) => void;

  createProject: (workspaceId: ID, name: string, icon?: string) => Promise<Project>;
  updateProject: (id: ID, patch: Partial<Project>) => void;
  archiveProject: (id: ID) => void;
  deleteProject: (id: ID) => void;
  /**
   * Merge every note, card, column, and idea-flow of `sourceId` into
   * `targetId`, then delete the (now empty) source project. Resolves with a
   * summary of what moved. Re-hydrates all slices from the DB afterwards.
   */
  mergeProject: (sourceId: ID, targetId: ID) => Promise<{ notes: number; cards: number } | null>;

  /**
   * Open the OS folder picker, persist the chosen path to workspace-config.json,
   * and reload the workspace. Returns the chosen path or null if cancelled.
   * No-op outside Electron.
   */
  selectAndInitWorkspace: () => Promise<string | null>;
  /**
   * Persist a workspace path (already known) to workspace-config.json.
   * Used by create-workspace.tsx when the folder was chosen in the same session.
   */
  initWorkspacePath: (workspacePath: string, excludedFolders?: string[]) => Promise<void>;
  /** Read the current workspace path from the Electron config. */
  getWorkspacePath: () => Promise<string | null>;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createWorkspaceSlice: StateCreator<
  CairnStore,
  [],
  [],
  WorkspaceSlice
> = (set, get) => ({
  workspaces: [],
  projects: [],

  // ── Workspaces ─────────────────────────────────
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

  updateWorkspace(wsId, patch) {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === wsId ? { ...w, ...patch, updatedAt: now() } : w
      ),
    }));
    get().persist();
    ipc((e) => e.workspace.update(wsId, patch));
  },

  // ── Projects ───────────────────────────────────
  async createProject(workspaceId, name, icon) {
    const proj: Project = {
      id: id(),
      workspaceId,
      name,
      ...(icon ? { icon } : {}),
      status: "active",
      priority: "medium",
      tagIds: [],
      codeDirectory: null,
      projectSettings: {},
      createdAt: now(),
      updatedAt: now(),
    };
    // Optimistic placeholders — server will return authoritative columns
    const placeholderColumns: BoardColumn[] = [
      { id: id(), projectId: proj.id, workspaceId, name: "Backlog",     type: "backlog",     order: 0, createdAt: now(), updatedAt: now() },
      { id: id(), projectId: proj.id, workspaceId, name: "Todo",        type: "todo",        order: 1, createdAt: now(), updatedAt: now() },
      { id: id(), projectId: proj.id, workspaceId, name: "In Progress", type: "in_progress", order: 2, createdAt: now(), updatedAt: now() },
      { id: id(), projectId: proj.id, workspaceId, name: "Review",      type: "review",      order: 3, createdAt: now(), updatedAt: now() },
      { id: id(), projectId: proj.id, workspaceId, name: "Done",        type: "done",        order: 4, createdAt: now(), updatedAt: now() },
    ];
    set((s) => ({
      projects: [...s.projects, proj],
      columns: [...s.columns, ...placeholderColumns],
    }));
    get().persist();

    // Single atomic IPC call — server creates project + 5 default columns together.
    // On success, replace optimistic columns with authoritative server rows.
    if (typeof window !== "undefined" && window.electron) {
      try {
        const result = await window.electron.project.create({
          ...proj, workspaceId, withDefaultColumns: true,
        }) as unknown as { data?: { project: Project; columns: BoardColumn[] }; error?: string } | undefined;
        const payload = result && "data" in result ? result.data : undefined;
        if (payload?.columns?.length) {
          set((s) => ({
            // Replace placeholder columns for this project with server columns
            columns: [
              ...s.columns.filter((c) => c.projectId !== proj.id),
              ...payload.columns,
            ],
          }));
          get().persist();
        }
      } catch (e) {
        console.error("[cairn:ipc] createProject failed", e);
      }
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
    const remaining = s.projects.filter(
      (p) => p.id !== projId && !p.archivedAt
    );
    const nextProject = remaining[0]?.id ?? null;
    set((st) => ({
      projects: st.projects.filter((p) => p.id !== projId),
      notes: st.notes.filter((n) => n.projectId !== projId),
      columns: st.columns.filter((c) => c.projectId !== projId),
      cards: st.cards.filter((c) => c.projectId !== projId),
      activeProjectId:
        st.activeProjectId === projId ? nextProject : st.activeProjectId,
      activeView:
        st.activeProjectId === projId ? "overview" : st.activeView,
    }));
    get().persist();
    ipc(
      (e) =>
        (e.project as { delete: (id: string) => Promise<unknown> }).delete(
          projId
        )
    );
  },

  async mergeProject(sourceId, targetId) {
    if (sourceId === targetId) return null;
    if (!isElectron() || !window.electron) return null;

    // If the source is the active project, switch to the target before the row
    // disappears so the UI doesn't land on a deleted project.
    if (get().activeProjectId === sourceId) {
      set({ activeProjectId: targetId, activeView: "overview" });
    }

    // The merge touches notes, cards, columns, idea-flow and more across three
    // slices; rather than surgically patching each, do the authoritative DB move
    // then re-hydrate every slice from the DB so local state matches exactly.
    const result = await ipcAwaitResult<{ counts: { notes: number; cards: number } }>(
      (e) =>
        (e.project as {
          merge: (s: string, t: string) => Promise<{ data: { counts: { notes: number; cards: number } } } | { error: string }>;
        }).merge(sourceId, targetId)
    );
    await get().hydrateFromElectron(true);
    return "data" in result ? { notes: result.data.counts.notes, cards: result.data.counts.cards } : null;
  },

  async selectAndInitWorkspace() {
    if (!isElectron() || !window.electron) return null;
    const folder = await window.electron.selectWorkspaceFolder();
    if (!folder) return null;
    // initWorkspace writes workspace-config.json, opens the new DB in-process,
    // restarts the file watcher, and fires db:changed — no relaunch needed.
    await ipcAwait((e) => e.initWorkspace(folder));
    return folder;
  },

  async initWorkspacePath(workspacePath, excludedFolders) {
    if (!isElectron() || !window.electron) return;
    // Route through the shared IPC helper so a database-affecting operation
    // respects the main-process access boundary and surfaces ipc errors.
    await ipcAwait((e) => e.initWorkspace(workspacePath, excludedFolders));
  },

  async getWorkspacePath() {
    if (!isElectron() || !window.electron) return null;
    return window.electron.getWorkspacePath();
  },
});
