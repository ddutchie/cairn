/**
 * Shared React hooks for analytics canvas components.
 */
import { useEffect, useState, useMemo } from "react";
import { useCairnStore } from "@/store";
import type { GraphNode } from "@/types";

// ── useFontScale ──────────────────────────────────────────────────────────────

/**
 * Returns the current --font-scale value from the document root.
 * Re-renders the caller when the store's fontScale changes.
 */
export function useFontScale(): number {
  const fontScale = useCairnStore((s) => s.fontScale);
  // fontScale in the store is the source of truth; the CSS var is a side-effect.
  // Reading the store directly avoids a DOM read on every render.
  return fontScale;
}

// ── useContainerDims ──────────────────────────────────────────────────────────

/**
 * Observes a container element and returns its pixel dimensions,
 * updating whenever it resizes.
 */
export function useContainerDims(ref: React.RefObject<HTMLElement | null>) {
  const [dims, setDims] = useState({ width: 800, height: 500 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setDims({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);

  return dims;
}

// ── useScopedData ─────────────────────────────────────────────────────────────

/**
 * Derives the sets of project/card IDs that are in scope for the current
 * graph node selection, plus the sorted active project list.
 */
export function useScopedData(nodes: GraphNode[]) {
  const { projects, cards, columns } = useCairnStore();

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
    () => cards.filter((c) => scopedCardIds.has(c.id) && !c.archivedAt),
    [cards, scopedCardIds]);

  return { scopedProjectIds, scopedCardIds, activeProjects, scopedCards, projects, cards, columns };
}
