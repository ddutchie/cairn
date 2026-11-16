/**
 * Shared store-slice test fixtures (A1/F19). The selector test files each
 * declared identical note/card/project factories — one home now.
 *
 * All factories return fully-typed objects (no assertions), so schema drift
 * breaks compilation here instead of silently producing wrong-shaped rows.
 */
import type { Note, TaskCard, Project, BoardColumn } from "@/types";

export const note = (id: string, projectId: string, extra: Partial<Note> = {}): Note => ({
  id,
  projectId,
  workspaceId: "ws-1",
  title: id,
  content: "",
  contentText: "",
  tagIds: [],
  linkedNoteIds: [],
  linkedCardIds: [],
  isPinned: false,
  type: "note",
  folder: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 0,
  ...extra,
});

export const cardItem = (id: string, projectId: string, extra: Partial<TaskCard> = {}): TaskCard => ({
  id,
  columnId: "c1",
  projectId,
  workspaceId: "ws-1",
  title: id,
  tagIds: [],
  priority: "medium",
  linkedNoteIds: [],
  blockedByIds: [],
  order: 0,
  createdAt: "",
  updatedAt: "",
  version: 0,
  ...extra,
});

export const project = (
  id: string,
  workspaceId: string,
  extra: Partial<Project> = {},
): Project => ({
  id,
  workspaceId,
  name: id,
  status: "active",
  priority: "medium",
  tagIds: [],
  codeDirectory: null,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

export const column = (id: string, projectId: string, order: number): BoardColumn => ({
  id,
  projectId,
  workspaceId: "ws-1",
  name: id,
  type: "todo",
  order,
  createdAt: "",
  updatedAt: "",
});
