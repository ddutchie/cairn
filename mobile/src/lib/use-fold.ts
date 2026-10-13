import { useCallback, useEffect, useState } from "react";
import { useWindowDimensions, type HostInstance, type LayoutChangeEvent } from "react-native";
import { foldGeometry, type Fold } from "@/lib/fold";
import { useHingeStatus } from "@/lib/hinge";

/** The crease in the current window, or null when the display is flat/closed. */
export function useFold(): Fold | null {
  const { width, height } = useWindowDimensions();
  const status = useHingeStatus();
  return foldGeometry({ width, height }, status);
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
