/**
 * Workspace + Project slice.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Workspace, Project, BoardColumn, ID } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc, ipcAwait } from "../ipc";

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

  createProject: (workspaceId: ID, name: string) => Promise<Project>;
  updateProject: (id: ID, patch: Partial<Project>) => void;
  archiveProject: (id: ID) => void;
  deleteProject: (id: ID) => void;
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
});
