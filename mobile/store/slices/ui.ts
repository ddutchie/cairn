import type { StateCreator } from "zustand";
import type { AppStore } from "../index";

export interface UISlice {
  // Active workspace + project selection
  activeWorkspaceId: string | null;
  activeProjectId: string | null;
  setActiveWorkspace: (id: string) => void;
  setActiveProject: (id: string | null) => void;

  // Colour scheme
  colorScheme: "light" | "dark";
  setColorScheme: (scheme: "light" | "dark") => void;

  // DB path (iCloud workspace SQLite file)
  dbPath: string | null;
  setDbPath: (path: string) => void;
}

export const createUISlice: StateCreator<AppStore, [], [], UISlice> = (set) => ({
  activeWorkspaceId: null,
  activeProjectId: null,
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setActiveProject: (id) => set({ activeProjectId: id }),

  colorScheme: "dark",
  setColorScheme: (scheme) => set({ colorScheme: scheme }),

  dbPath: null,
  setDbPath: (path) => set({ dbPath: path }),
});
