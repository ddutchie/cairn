/**
 * Selectors slice — pure derived/query functions over store state.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Note, BoardColumn, TaskCard, Project, ID } from "@/types";
import type { SearchResult } from "../index";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface SelectorsSlice {
  getProjectNotes: (projectId: ID) => Note[];
  getArchivedProjectNotes: (projectId: ID) => Note[];
  getProjectColumns: (projectId: ID) => BoardColumn[];
  getColumnCards: (columnId: ID) => TaskCard[];
  getArchivedColumnCards: (columnId: ID) => TaskCard[];
  getProjectCards: (projectId: ID) => TaskCard[];
  getWorkspaceProjects: (workspaceId: ID) => Project[];
  searchAll: (query: string) => SearchResult[];
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createSelectorsSlice: StateCreator<
  CairnStore,
  [],
  [],
  SelectorsSlice
> = (_set, get) => ({
  getProjectNotes(projectId) {
    return get()
      .notes.filter((n) => n.projectId === projectId && !n.archivedAt)
      .sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return (
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
  },

  getArchivedProjectNotes(projectId) {
    return get()
      .notes.filter((n) => n.projectId === projectId && !!n.archivedAt)
      .sort(
        (a, b) =>
          new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime()
      );
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

  getArchivedColumnCards(columnId) {
    return get()
      .cards.filter((c) => c.columnId === columnId && !!c.archivedAt)
      .sort(
        (a, b) =>
          new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime()
      );
  },

  getProjectCards(projectId) {
    return get().cards.filter(
      (c) => c.projectId === projectId && !c.archivedAt
    );
  },

  getWorkspaceProjects(workspaceId) {
    return get()
      .projects.filter(
        (p) => p.workspaceId === workspaceId && !p.archivedAt
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  },

  searchAll(query) {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const s = get();
    const results: SearchResult[] = [];

    s.notes.forEach((n) => {
      if (n.archivedAt) return;
      if (
        n.title.toLowerCase().includes(q) ||
        n.contentText.toLowerCase().includes(q)
      ) {
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
});
