import { useCallback, useEffect, useState } from "react";
import { useWindowDimensions, type HostInstance, type LayoutChangeEvent } from "react-native";
import { resolveFold, type Fold } from "@/lib/fold";
import { refreshDivisionRegion, useDivisionRegion } from "@/lib/division-region";
import { useHingeStatus } from "@/lib/hinge";

/**
 * The crease in the current window, or null when the display is flat/closed or
 * the window doesn't touch it. Uses the OS-reported division region when the
 * native module has it; otherwise infers from hinge status + window shape.
 */
export function useFold(): Fold | null {
  const { width, height } = useWindowDimensions();
  const status = useHingeStatus();
  const region = useDivisionRegion();
  // The native observer publishes region changes itself; this re-query on a pose
  // or window change covers any beat the OS reports them in.
  useEffect(() => {
    refreshDivisionRegion();
  }, [status, width, height]);
  return resolveFold({ width, height }, status, region);
}

/**
 * Room above a horizontal crease (laptop pose), measured inside a container
 * that doesn't start at the window's top edge (headers push it down). `before`
 * is the container-relative height of the top half; null when there's no
 * horizontal crease, so callers keep their normal full-height layout. Attach
 * `onLayout` to the container view.
 */
export function useTopHalf() {
  const fold = useFold();
  // The container's own element comes from its onLayout event, so no ref object
  // is handed around (and re-measuring on fold changes reuses the kept node).
  const [node, setNode] = useState<HostInstance | null>(null);
  const [top, setTop] = useState(0);
  const measure = useCallback((n: HostInstance) => {
    n.measureInWindow((_x, y) => setTop(y));
  }, []);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const n = e.currentTarget as HostInstance | null;
      if (!n?.measureInWindow) return;
      setNode(n);
      measure(n);
    },
    [measure],
  );
  useEffect(() => {
    if (node) measure(node);
  }, [node, measure, fold?.position]);
  // A container that already starts below the crease (e.g. the body under a
  // stacked preview pane) is in the bottom half and needs no clamping.
  const room = fold?.axis === "horizontal" ? fold.position - fold.gutter / 2 - top : 0;
  const before = room > 0 ? room : null;
  // Distance from the bottom of the top half to the bottom of the window — what
  // keyboard-aware scroll views want as their `offset`, so the keyboard (which
  // only covers the flat half) isn't also counted as covering them.
  const { height: windowHeight } = useWindowDimensions();
  const gap = before != null && fold ? windowHeight - (fold.position - fold.gutter / 2) : 0;
  return { onLayout, before, gap };
}

/**
 * Book pose (vertical crease): extra side padding that keeps a container's centred
 * content on one side of the crease instead of straddling it. When the crease runs
 * through the container, content centres within the wider side (`shift` is how much
 * to add to that container's own left/right padding; `split` is the usable width either
 * side of the crease, for layouts that use both halves); otherwise both are 0 / null. Attach
 * `onLayout` to the container. Padding, not margin, so the measured frame doesn't
 * move when the shift is applied.
 */
export function useCreaseClearance() {
  const fold = useFold();
  const [node, setNode] = useState<HostInstance | null>(null);
  const [box, setBox] = useState<{ x: number; width: number } | null>(null);
  const measure = useCallback((n: HostInstance) => {
    n.measureInWindow((x, _y, width) => setBox((prev) => (prev && prev.x === x && prev.width === width ? prev : { x, width })));
  }, []);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const n = e.currentTarget as HostInstance | null;
      if (!n?.measureInWindow) return;
      setNode(n);
      measure(n);
    },
    [measure],
  );
  useEffect(() => {
    if (node) measure(node);
  }, [node, measure, fold?.position, fold?.axis]);
  let shift = { left: 0, right: 0 };
  let split: { before: number; after: number; gutter: number } | null = null;
  if (fold?.axis === "vertical" && box) {
    const half = fold.gutter / 2;
    const left = fold.position - half - box.x;
    const right = box.x + box.width - (fold.position + half);
    if (left > 0 && right > 0) {
      shift = right >= left ? { left: box.width - right, right: 0 } : { left: 0, right: box.width - left };
      split = { before: left, after: right, gutter: fold.gutter };
    }
  }
  return { onLayout, shift, split };
}
