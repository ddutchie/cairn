/**
 * Shared React hooks for analytics canvas components.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
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
  const { projects, cards, columns } = useCairnStore(useShallow((s) => ({ projects: s.projects, cards: s.cards, columns: s.columns })));

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

  return { scopedProjectIds, scopedCardIds, activeProjects, scopedCards, projects, cards, columns };
}

// ── useRelativePointer ────────────────────────────────────────────────────────

/**
 * Returns a callback that converts a mouse event's `clientX`/`clientY` into
 * coordinates relative to the given ref element. Used by SVG canvases for
 * tooltip positioning.
 */
export function useRelativePointer<T extends HTMLElement | SVGSVGElement>(ref: React.RefObject<T | null>) {
  return useCallback((e: { clientX: number; clientY: number }) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, [ref]);
}

// ── useNow ───────────────────────────────────────────────────────────────────

/**
 * Returns `Date.now()` snapshot at mount time (plus optional periodic refresh).
 * Safe to use in `useMemo` deps — the lint rule that flags `Date.now()` inside
 * memo does not fire on a hook return value. When `refreshMs` is provided,
 * the value updates on an interval (useful for canvases showing "today").
 */
export function useNow(refreshMs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return now;
}
