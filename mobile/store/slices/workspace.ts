import type { StateCreator } from "zustand";
import type { AppStore } from "../index";
import type { Workspace, Project } from "../../../src/types/index";
import * as queries from "../../db/queries";

export interface WorkspaceSlice {
  workspaces: Workspace[];
  projects: Project[];
  loadWorkspaces: () => Promise<void>;
  loadProjects: (workspaceId: string) => Promise<void>;
}

export const createWorkspaceSlice: StateCreator<AppStore, [], [], WorkspaceSlice> = (set) => ({
  workspaces: [],
  projects: [],

  loadWorkspaces: async () => {
    const workspaces = await queries.getWorkspaces();
    set({ workspaces });
  },

  loadProjects: async (workspaceId) => {
    const projects = await queries.getProjects(workspaceId);
    set({ projects });
  },
});
