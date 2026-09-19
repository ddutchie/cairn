/**
 * Shared React hooks for analytics canvas components.
 *
 * Canvas contract (cleanup Phase 6) — scope-filtered canvases derive their
 * inputs from these hooks, never ad hoc:
 * - useScopeSets — the single source for scope (project/card/node id sets)
 *   plus projects/cards/columns. Prefer it unless the canvas joins notes/tags.
 * - useScopedData — useScopeSets plus the notes/tags arrays (Matrix, Table).
 * - useFontScale — multiply ALL SVG `fontSize` attributes by its return.
 *   HTML/rem-styled canvases don't need it (root font-size scales them).
 * - useContainerDims — ResizeObserver dims for measured layouts (SVG viewBox,
 *   canvas 2D + DPR sizing). HTML-flow canvases don't need it.
 * Other helpers in this file: useRelativePointer (SVG tooltip positioning),
 * useNow (render-time snapshot + optional refresh), useThemeRepaint (canvas
 * repaint after theme flips). ForceGraphCanvas / RadialTreeCanvas render the
 * full graph (legitimately unscoped) and additionally keep a dimsRef mirror
 * for their render loops — the observer itself still comes from
 * useContainerDims.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import type { RefObject } from "react";
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

// ── useThemeRepaint ───────────────────────────────────────────────────────────

/**
 * Repaints a canvas after a theme change. `resolveCssVar` reads the live
 * computed CSS custom properties, which only update once the browser has
 * applied the new `data-theme` attribute on <html> and recomputed styles.
 * This observes that attribute (covering both the explicit light/dark toggle
 * and OS-driven changes in "system" mode) and invokes the latest draw function
 * on the next frames, after the recalc — otherwise the canvas keeps the
 * previous theme's colours (artifacts).
 *
 * Pass a ref holding the current draw function (not the function itself) so the
 * observer always calls the freshest closure without re-subscribing.
 */
export function useThemeRepaint(drawRef: RefObject<() => void>) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    let raf1 = 0, raf2 = 0;
    const repaint = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => drawRef.current?.());
      });
    };
    const obs = new MutationObserver((muts) => {
      if (muts.some((m) => m.attributeName === "data-theme")) repaint();
    });
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [drawRef]);
}
