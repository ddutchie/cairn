/**
 * Selectors slice — pure derived/query functions over store state.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { Note, BoardColumn, TaskCard, Project, Workspace, ID } from "@/types";
import { matchesQuery } from "../../../shared/notes/text";
import { noteSearchText } from "@/lib/note-text";

// ── SearchResult (returned by searchAll; re-exported from the store root) ────

export interface SearchResult {
  type: "note" | "card";
  id: string;
  title: string;
  snippet: string;
  projectId: string;
  projectName: string;
}

// ── Memo helper ───────────────────────────────────────────────────────────────
// Selectors sort/filter on every call; several run per-column per-render
// (e.g. board columns). Cache per selector key on the source-array
// references — Zustand replaces arrays on every write, so reference equality
// is a correct and cheap change detector. Module-level (not in state) so it
// never triggers subscriptions; fresh arrays always recompute.

const memoCache = new Map<string, { deps: readonly unknown[]; result: unknown }>();

function memo<T>(key: string, deps: readonly unknown[], compute: () => T): T {
  const hit = memoCache.get(key);
  if (
    hit &&
    hit.deps.length === deps.length &&
    hit.deps.every((d, i) => d === deps[i])
  ) {
    return hit.result as T;
  }
  const result = compute();
  memoCache.set(key, { deps, result });
  // Bound the cache: params are part of the key, so churny ids could grow it.
  if (memoCache.size > 500) {
    const oldest = memoCache.keys().next();
    if (!oldest.done) memoCache.delete(oldest.value);
  }
  return result;
}

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
  /** Cards in any of the given projects (graph/insights scope filtering). */
  getScopedCards: (projectIds: readonly ID[]) => TaskCard[];
  /** The active project / workspace, or null/undefined when none selected. */
  getActiveProject: () => Project | undefined;
  getActiveWorkspace: () => Workspace | undefined;
  /**
   * Keyword search over notes + cards. Note bodies load lazily in Electron, so
   * callers pass `noteBodyMatches` — ids whose BODY matched, from the main
   * process (`window.electron.note.search`); titles and loaded bodies are
   * matched here.
   */
  searchAll: (query: string, noteBodyMatches?: ReadonlySet<string>) => SearchResult[];
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createSelectorsSlice: StateCreator<
  CairnStore,
  [],
  [],
  SelectorsSlice
> = (_set, get) => ({
  getProjectNotes(projectId) {
    const notes = get().notes;
    return memo(`notes:${projectId}`, [notes], () =>
      notes.filter((n) => n.projectId === projectId && !n.archivedAt && n.type !== "template")
        .sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return (
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        })
    );
  },

  getProjectTemplates(projectId) {
    const notes = get().notes;
    return memo(`templates:${projectId}`, [notes], () =>
      notes.filter((n) => n.projectId === projectId && !n.archivedAt && n.type === "template")
        .sort((a, b) => a.title.localeCompare(b.title))
    );
  },

  getArchivedProjectNotes(projectId) {
    const notes = get().notes;
    return memo(`archNotes:${projectId}`, [notes], () =>
      notes.filter((n) => n.projectId === projectId && !!n.archivedAt)
        .sort(
          (a, b) =>
            new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime()
        )
    );
  },

  getProjectColumns(projectId) {
    const columns = get().columns;
    return memo(`columns:${projectId}`, [columns], () =>
      columns.filter((c) => c.projectId === projectId)
        .sort((a, b) => a.order - b.order)
    );
  },

  getColumnCards(columnId) {
    const cards = get().cards;
    return memo(`colCards:${columnId}`, [cards], () =>
      cards.filter((c) => c.columnId === columnId && !c.archivedAt)
        .sort((a, b) => a.order - b.order)
    );
  },

  getArchivedColumnCards(columnId) {
    const cards = get().cards;
    return memo(`archColCards:${columnId}`, [cards], () =>
      cards.filter((c) => c.columnId === columnId && !!c.archivedAt)
        .sort(
          (a, b) =>
            new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime()
        )
    );
  },

  getProjectCards(projectId) {
    const cards = get().cards;
    return memo(`cards:${projectId}`, [cards], () =>
      cards.filter(
        (c) => c.projectId === projectId && !c.archivedAt
      )
    );
  },

  getArchivedProjectCards(projectId) {
    const cards = get().cards;
    return memo(`archCards:${projectId}`, [cards], () =>
      cards.filter((c) => c.projectId === projectId && !!c.archivedAt)
        .sort((a, b) => new Date(b.archivedAt!).getTime() - new Date(a.archivedAt!).getTime())
    );
  },

  getWorkspaceProjects(workspaceId) {
    const projects = get().projects;
    return memo(`wsProjects:${workspaceId}`, [projects], () =>
      projects.filter(
        (p) => p.workspaceId === workspaceId && !p.archivedAt
      )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
    );
  },

  getScopedCards(projectIds) {
    const cards = get().cards;
    const key = `scoped:${[...projectIds].sort().join(",")}`;
    return memo(key, [cards, key], () => {
      const scope = new Set(projectIds);
      return cards.filter((c) => scope.has(c.projectId) && !c.archivedAt);
    });
  },

  getActiveProject() {
    const s = get();
    return memo("activeProject", [s.projects, s.activeProjectId], () =>
      s.projects.find((p) => p.id === s.activeProjectId)
    );
  },

  getActiveWorkspace() {
    const s = get();
    return memo("activeWorkspace", [s.workspaces, s.activeWorkspaceId], () =>
      s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    );
  },

  searchAll(query, noteBodyMatches) {
    if (!query.trim()) return [];
    const q = query;
    const s = get();
    const results: SearchResult[] = [];

    s.notes.forEach((n) => {
      if (n.archivedAt) return;
      if (noteBodyMatches?.has(n.id) || matchesQuery(q, noteSearchText(n))) {
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
