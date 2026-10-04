/**
 * Shared React hooks for analytics canvas components.
 *
 * Canvas contract (cleanup Phase 6) — scope-filtered canvases derive their
 * inputs from these hooks, never ad hoc:
 * - useScopeSets — the single source for scope (project/card/node id sets)
 *   plus projects/cards/columns. Prefer it unless the canvas joins notes/tags.
 * - useScopedData — useScopeSets plus the notes/tags arrays (Matrix, Table).
 * Renderer-generic hooks (useFontScale, useContainerDims, useNow, …) live in
 * `@/lib/viz/hooks`; this file only holds the Insights store selectors.
 */
import { useMemo } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { GraphNode } from "@/types";

// ── useScopedData ─────────────────────────────────────────────────────────────

/**
 * Derives the sets of project/card/node IDs that are in scope for the current
 * graph node selection, plus the sorted active project list and the
 * project/card/column arrays. Notes/tags are NOT subscribed here — canvases
 * that join against them (Matrix, Table) use useScopedData instead — so
 * note/tag saves don't re-render canvases that never read them.
 */
export function useScopeSets(nodes: GraphNode[]) {
  const { projects, cards, columns } = useCairnStore(useShallow((s) => ({ projects: s.projects, cards: s.cards, columns: s.columns })));

  const scopedNodeIds = useMemo(
    () => new Set(nodes.map((n) => n.id)),
    [nodes]);

  const scopedProjectIds = useMemo(
    () => new Set(nodes.filter((n) => n.type === "project").map((n) => n.id)),
    [nodes]);

  const scopedCardIds = useMemo(
    () => new Set(nodes.filter((n) => n.type === "card").map((n) => n.id)),
    [nodes]);

  const activeProjects = useMemo(
    () => projects
      .filter((p) => !p.archivedAt && scopedProjectIds.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, scopedProjectIds]);

  const scopedCards = useMemo(
    () => cards.filter((c) => scopedCardIds.has(c.id)),
    [cards, scopedCardIds]);

  return { scopedNodeIds, scopedProjectIds, scopedCardIds, activeProjects, scopedCards, projects, cards, columns };
}

/**
 * Full-scope variant: useScopeSets plus the notes/tags arrays for canvases
 * that join node rows against them (Matrix, Table). Prefer useScopeSets
 * elsewhere to avoid re-rendering on note/tag saves.
 */
export function useScopedData(nodes: GraphNode[]) {
  const sets = useScopeSets(nodes);
  const { notes, tags } = useCairnStore(useShallow((s) => ({ notes: s.notes, tags: s.tags })));
  return { ...sets, notes, tags };
}
