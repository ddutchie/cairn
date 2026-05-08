/**
 * Cairn Mobile — Zustand store
 *
 * Composed from domain slices. The store is the single source of truth
 * for in-memory state; all persistence goes through db/queries.ts.
 */

import { create } from "zustand";
import type { WorkspaceSlice } from "./slices/workspace";
import type { BoardSlice } from "./slices/board";
import type { NotesSlice } from "./slices/notes";
import type { ChatSlice } from "./slices/chat";
import type { UISlice } from "./slices/ui";
import { createWorkspaceSlice } from "./slices/workspace";
import { createBoardSlice } from "./slices/board";
import { createNotesSlice } from "./slices/notes";
import { createChatSlice } from "./slices/chat";
import { createUISlice } from "./slices/ui";

export type AppStore = WorkspaceSlice & BoardSlice & NotesSlice & ChatSlice & UISlice;

export const useStore = create<AppStore>()((...args) => ({
  ...createWorkspaceSlice(...args),
  ...createBoardSlice(...args),
  ...createNotesSlice(...args),
  ...createChatSlice(...args),
  ...createUISlice(...args),
}));
