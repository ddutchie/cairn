/**
 * Renderer-generic hooks for SVG / canvas visualisations (Insights, the agent
 * view's architecture charts, Usage, the Overview radar).
 *
 * - useFontScale — multiply ALL SVG `fontSize` attributes by its return.
 *   HTML/rem-styled content doesn't need it (root font-size scales it).
 * - useResizeObserver / useContainerDims — element size tracking.
 * - useRelativePointer — client → element coordinates (tooltip positioning).
 * - useNow — render-time snapshot with optional refresh.
 * - useThemeRepaint — repaint a canvas after a theme flip.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useCairnStore } from "@/store";

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

// ── useResizeObserver ─────────────────────────────────────────────────────────

/**
 * Calls `onResize(el)` once on mount and whenever `ref`'s element resizes.
 * The callback is read through a ref, so it may close over fresh state
 * without re-observing. Pass `deps` that change when the element remounts.
 */
export function useResizeObserver<T extends Element>(
  ref: RefObject<T | null>,
  onResize: (el: T) => void,
  deps: readonly unknown[] = [],
): void {
  const cb = useRef(onResize);
  useEffect(() => { cb.current = onResize; });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => cb.current(el));
    ro.observe(el);
    cb.current(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, [ref, ...deps]);
}

// ── useContainerDims ──────────────────────────────────────────────────────────

/**
 * Observes a container element and returns its pixel dimensions,
 * updating whenever it resizes.
 */
export function useContainerDims(ref: RefObject<HTMLElement | null>) {
  const [dims, setDims] = useState({ width: 800, height: 500 });
  useResizeObserver(ref, (el) => setDims({ width: el.clientWidth, height: el.clientHeight }));
  return dims;
}

// ── useRelativePointer ────────────────────────────────────────────────────────

/**
 * Returns a callback that converts a mouse event's `clientX`/`clientY` into
 * coordinates relative to the given ref element. Used by SVG canvases for
 * tooltip positioning.
 */
export function useRelativePointer<T extends HTMLElement | SVGSVGElement>(ref: RefObject<T | null>) {
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
