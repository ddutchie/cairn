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
 * Calls `onResize(el)` when `ref`'s element mounts and whenever it resizes.
 *
 * The element is re-checked after every render, so a ref that moves to a
 * different node (an empty state that returns early, a loading branch that
 * renders its own wrapper) is re-observed without the caller passing deps.
 * The callback is read through a ref, so it may close over fresh state.
 * `deps` re-run the callback on the current element when they change, for
 * measurements that depend on content rather than size.
 */
export function useResizeObserver<T extends Element>(
  ref: RefObject<T | null>,
  onResize: (el: T) => void,
  deps: readonly unknown[] = [],
): void {
  const cb = useRef(onResize);
  const observed = useRef<{ el: T; ro: ResizeObserver } | null>(null);
  const measuredDeps = useRef(false);

  useEffect(() => {
    cb.current = onResize;
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => cb.current(el));
    ro.observe(el);
    observed.current = { el, ro };
    cb.current(el);
  });

  useEffect(() => {
    // The attach effect above already measured on mount.
    if (!measuredDeps.current) { measuredDeps.current = true; return; }
    if (observed.current) cb.current(observed.current.el);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, deps);

  useEffect(() => () => {
    observed.current?.ro.disconnect();
    observed.current = null;
  }, []);
}

// ── useContainerDims ──────────────────────────────────────────────────────────

/**
 * Observes a container element and returns its pixel dimensions,
 * updating whenever it resizes or the ref moves to a new element.
 */
export function useContainerDims(ref: RefObject<HTMLElement | null>) {
  const [dims, setDims] = useState({ width: 800, height: 500 });
  useResizeObserver(ref, (el) => setDims((d) =>
    d.width === el.clientWidth && d.height === el.clientHeight ? d : { width: el.clientWidth, height: el.clientHeight }));
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
