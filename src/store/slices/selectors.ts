/**
 * Selectors slice — pure derived/query functions over store state.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Note, BoardColumn, TaskCard, Project, ID } from "@/types";
import type { SearchResult } from "../index";
import { matchesQuery } from "../../../shared/notes/text";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface SelectorsSlice {
  getProjectNotes: (projectId: ID) => Note[];
  getProjectTemplates: (projectId: ID) => Note[];
  getArchivedProjectNotes: (projectId: ID) => Note[];
  getProjectColumns: (projectId: ID) => BoardColumn[];
  getColumnCards: (columnId: ID) => TaskCard[];
  getArchivedColumnCards: (columnId: ID) => TaskCard[];
  getProjectCards: (projectId: ID) => TaskCard[];
  getArchivedProjectCards: (projectId: ID) => TaskCard[];
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
      .notes.filter((n) => n.projectId === projectId && !n.archivedAt && n.type !== "template")
      .sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return (
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
  },

  getProjectTemplates(projectId) {
    return get()
      .notes.filter((n) => n.projectId === projectId && !n.archivedAt && n.type === "template")
      .sort((a, b) => a.title.localeCompare(b.title));
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

  getArchivedProjectCards(projectId) {
    return get()
      .cards.filter((c) => c.projectId === projectId && !!c.archivedAt)
      .sort((a, b) => new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime());
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
    const q = query;
    const s = get();
    const results: SearchResult[] = [];

    s.notes.forEach((n) => {
      if (n.archivedAt) return;
      if (matchesQuery(q, `${n.title}\n${n.contentText}`)) {
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
      if (matchesQuery(q, `${c.title}\n${c.description ?? ""}`)) {
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
