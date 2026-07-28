/**
 * Generic long-press drag-and-drop core (reanimated + gesture-handler).
 *
 * One implementation powers both the Kanban board (drag a card between columns)
 * and the Calendar (drag a task between day cells / the unscheduled tray). The
 * caller supplies the draggable payload type `T` and wires up:
 *
 *   1. a `useDragController<T>()` at the container, giving shared drag state, a
 *      `registerZone` ref callback for each drop target, a `remeasure()` to call
 *      when a drag begins, a `panGesture(item, sourceZoneId)` factory for each
 *      draggable, and the currently-`dragging` item (JS state, changes only at
 *      start/end so the list doesn't re-render per frame);
 *   2. `<DragOverlay>` once, rendering a caller-provided clone that follows the
 *      finger;
 *   3. optionally `useZoneHighlight(zoneId)` on each drop target to light it up
 *      while the finger hovers it — entirely on the UI thread.
 *
 * All hit-testing is a plain rectangle test in window coordinates, so zones can
 * be laid out any way (a horizontal column strip, a 7-wide calendar grid, a
 * tray) — the engine doesn't care about their arrangement.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedRef,
  useAnimatedScrollHandler,
  scrollTo,
  runOnJS,
  type SharedValue,
  type AnimatedScrollViewProps,
} from "react-native-reanimated";
import type Animated from "react-native-reanimated";
import type { GestureType } from "react-native-gesture-handler";
import { haptics } from "@/haptics";

/** Default long-press duration (ms) before a drag activates. */
export const DRAG_LONG_PRESS_MS = 220;

/** Absolute window rectangle of a registered drop zone. */
export interface ZoneFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DragController<T> {
  /** The lifted item (null when idle). Changes only at drag start/end. */
  dragging: T | null;
  /** Whether an outer scroll view should be locked (true while dragging). */
  scrollLocked: boolean;

  // ── shared values (UI thread) ──────────────────────────────────────────────
  /** Zone id currently under the finger (null = none). */
  hoverZoneId: SharedValue<string | null>;
  /** Zone id the drag started from. */
  sourceZoneId: SharedValue<string | null>;
  /** Window-space pointer position of the overlay's top-left. */
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  /** Overlay width. */
  dragW: SharedValue<number>;
  /** Window origin of the drag container (to convert to container-local). */
  originX: SharedValue<number>;
  originY: SharedValue<number>;

  /** Ref callback to register a drop zone's measurable node by id.
   *  Pass `scrollIndependent: true` for zones that live OUTSIDE the scroll view
   *  (e.g. action zones fixed below the list) so the hit-test doesn't shift them
   *  by the scroll delta. */
  registerZone: (zoneId: string, node: View | null, scrollIndependent?: boolean) => void;
  /** Ref callback for the drag container (its origin is measured on drag begin). */
  setContainer: (node: View | null) => void;
  /** Re-measure the container origin + every zone frame (call on drag begin). */
  remeasure: () => void;
  /**
   * Build the pan gesture for a draggable.
   * @param item          the payload handed back to onDrop
   * @param sourceZoneId  the zone this item currently lives in
   * @param overlayWidth  desired overlay width (defaults to the source zone width)
   */
  panGesture: (item: T, sourceZoneId: string, overlayWidth?: number) => GestureType;

  // ── auto-scroll wiring ──────────────────────────────────────────────────────
  /**
   * Attach to the scrollable that holds the drop zones (as an
   * `Animated.ScrollView`). Lets the controller auto-scroll it on the UI thread
   * when the finger nears an edge mid-drag, so off-screen zones stay reachable.
   */
  scrollRef: ReturnType<typeof useAnimatedRef<Animated.ScrollView>>;
  /** Spread onto the same `Animated.ScrollView` (`onScroll` + `scrollEventThrottle`). */
  scrollHandler: AnimatedScrollViewProps["onScroll"];
  /** Attach to the scrollable's `onLayout` — seeds the viewport extent. */
  onScrollLayout: (e: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  /** Attach to the scrollable's `onContentSizeChange` — seeds maxScroll before the first scroll. */
  onScrollContentSizeChange: (w: number, h: number) => void;
  /** Scroll axis of that scrollable ("x" = horizontal board, "y" = vertical grid). */
  scrollAxis: "x" | "y";
}

export interface UseDragControllerArgs<T> {
  /** Stable id for a payload (used to key the lifted item). */
  getId: (item: T) => string;
  /**
   * Commit a drop. `target` is the hovered zone id at release (or null if none),
   * `source` is where the drag began. Called on the JS thread. Only fired for a
   * real release (not cancellation, which passes target=null).
   */
  onDrop: (item: T, target: string | null, source: string | null) => void;
  /** Long-press activation delay; defaults to {@link DRAG_LONG_PRESS_MS}. */
  longPressMs?: number;
  /** Vertical finger offset for the overlay (defaults to 30). */
  liftOffsetY?: number;
  /**
   * Scroll axis of the scrollable holding the drop zones. "x" for a horizontal
   * strip (board), "y" for a vertical list (calendar grid). Enables
   * edge-triggered auto-scroll while dragging. Defaults to "y".
   */
  scrollAxis?: "x" | "y";
}

export function useDragController<T>({
  getId,
  onDrop,
  longPressMs = DRAG_LONG_PRESS_MS,
  liftOffsetY = 30,
  scrollAxis = "y",
}: UseDragControllerArgs<T>): DragController<T> {
  const hoverZoneId = useSharedValue<string | null>(null);
  const sourceZoneId = useSharedValue<string | null>(null);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragW = useSharedValue(240);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const frames = useSharedValue<Record<string, ZoneFrame>>({});
  // Ids of zones that live outside the scroll view — their measured frames must
  // NOT be scroll-corrected in the hit-test (see zoneAt). Mirrored into a shared
  // value so the UI-thread worklet can read it.
  const scrollIndependentZones = useSharedValue<Record<string, boolean>>({});

  // Auto-scroll state (all UI-thread). scrollOffset tracks the scrollable's live
  // position; offsetAtMeasure is the offset when `frames` were captured, so the
  // hit-test can shift stale rects by (scrollOffset - offsetAtMeasure) instead
  // of re-measuring. viewport is the scrollable's window rect; maxScroll bounds
  // programmatic scrollTo.
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useSharedValue(0);
  const offsetAtMeasure = useSharedValue(0);
  const viewport = useSharedValue({ x: 0, y: 0, width: 0, height: 0 });
  const maxScroll = useSharedValue(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollOffset.value = scrollAxis === "x" ? e.contentOffset.x : e.contentOffset.y;
      // Track the max scrollable distance so auto-scroll can't run past the end.
      const content = scrollAxis === "x" ? e.contentSize.width : e.contentSize.height;
      const frame = scrollAxis === "x" ? e.layoutMeasurement.width : e.layoutMeasurement.height;
      maxScroll.value = Math.max(0, content - frame);
    },
  });

  // Viewport extent (px on the scroll axis), set from the ScrollView's onLayout.
  // Combined with onContentSizeChange it lets us seed maxScroll BEFORE the first
  // scroll event — otherwise auto-scroll is clamped to 0 until the user scrolls
  // manually once (maxScroll only gets set inside onScroll).
  const viewportExtent = useRef(0);
  const onScrollLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      viewportExtent.current = scrollAxis === "x" ? e.nativeEvent.layout.width : e.nativeEvent.layout.height;
    },
    [scrollAxis],
  );
  const onScrollContentSizeChange = useCallback(
    (w: number, h: number) => {
      const content = scrollAxis === "x" ? w : h;
      maxScroll.value = Math.max(0, content - viewportExtent.current);
    },
    [scrollAxis, maxScroll],
  );

  const containerRef = useRef<View>(null);
  const zoneRefs = useRef<Record<string, View | null>>({});

  const [dragging, setDragging] = useState<T | null>(null);
  const [scrollLocked, setScrollLocked] = useState(false);

  const registerZone = useCallback((zoneId: string, node: View | null, scrollIndependent = false) => {
    if (node) {
      zoneRefs.current[zoneId] = node;
      if (scrollIndependent && !scrollIndependentZones.value[zoneId]) {
        scrollIndependentZones.value = { ...scrollIndependentZones.value, [zoneId]: true };
      }
    } else {
      delete zoneRefs.current[zoneId];
      if (scrollIndependentZones.value[zoneId]) {
        const next = { ...scrollIndependentZones.value };
        delete next[zoneId];
        scrollIndependentZones.value = next;
      }
    }
  }, [scrollIndependentZones]);

  const setContainer = useCallback((node: View | null) => {
    containerRef.current = node;
  }, []);

  // Re-measure the container origin + every zone's window frame. Runs on the JS
  // thread when a drag begins so hit-testing uses fresh, laid-out coords
  // (measuring in the ref callback alone reads stale x/y before layout flushes).
  // Also snapshots the scroll offset at measure time + the viewport rect, so the
  // auto-scroll hit-test can offset-correct the frames on the UI thread.
  const remeasure = useCallback(() => {
    offsetAtMeasure.value = scrollOffset.value;
    containerRef.current?.measureInWindow((x, y, width, height) => {
      originX.value = x;
      originY.value = y;
      // Use the container as the scroll viewport for edge detection. (Both
      // consumers make the drag container the scrollable's parent / itself.)
      viewport.value = { x, y, width, height };
    });
    const ids = Object.keys(zoneRefs.current);
    let pending = ids.length;
    if (pending === 0) return;
    const next: Record<string, ZoneFrame> = {};
    for (const id of ids) {
      const node = zoneRefs.current[id];
      if (!node) {
        pending -= 1;
        continue;
      }
      node.measureInWindow((x, y, width, height) => {
        next[id] = { x, y, width, height };
        pending -= 1;
        if (pending === 0) frames.value = next;
      });
    }
  }, [frames, originX, originY, offsetAtMeasure, scrollOffset, viewport]);

  const beginDrag = useCallback((item: T) => {
    haptics.impact(); // picked up
    setDragging(item);
    setScrollLocked(true);
  }, []);

  const endDrag = useCallback(
    (item: T, target: string | null, source: string | null) => {
      setDragging(null);
      setScrollLocked(false);
      if (target && target !== source) {
        haptics.impactMedium(); // committed into a new zone
        onDrop(item, target, source);
      }
    },
    [onDrop],
  );

  const panGesture = useCallback(
    (item: T, source: string, overlayWidth?: number): GestureType => {
      const active = { value: false };
      // Auto-scroll tuning (inlined below rather than imported, so the worklets
      // don't depend on cross-module worklet calls — those are fragile under
      // reanimated v4's bundling). The pure equivalents live in ./autoScroll for
      // JS use + unit tests.
      const EDGE = 64;
      const MAX_SPEED = 14;

      // Hit-test the finger against the zone frames, offset-corrected for how
      // far the list has auto-scrolled since the frames were measured (so drop
      // targets stay accurate mid-scroll without re-measuring every frame).
      const zoneAt = (absX: number, absY: number): string | null => {
        "worklet";
        const f = frames.value;
        const indep = scrollIndependentZones.value;
        const delta = scrollOffset.value - offsetAtMeasure.value;
        for (const id in f) {
          const r = f[id];
          // Zones outside the scroll view (action zones) don't move with the
          // scroll, so their frames must not be shifted by the scroll delta.
          const d = indep[id] ? 0 : delta;
          const rx = scrollAxis === "x" ? r.x - d : r.x;
          const ry = scrollAxis === "y" ? r.y - d : r.y;
          if (absX >= rx && absX <= rx + r.width && absY >= ry && absY <= ry + r.height) return id;
        }
        return null;
      };
      // Edge-triggered auto-scroll: nudge the scrollable toward the edge the
      // finger is near, so off-screen drop zones remain reachable during a drag.
      const autoScroll = (absX: number, absY: number) => {
        "worklet";
        const vp = viewport.value;
        const pos = scrollAxis === "x" ? absX : absY;
        const start = scrollAxis === "x" ? vp.x : vp.y;
        const end = scrollAxis === "x" ? vp.x + vp.width : vp.y + vp.height;
        const lo = start + EDGE;
        const hi = end - EDGE;
        if (hi <= lo) return;
        let d = 0;
        if (pos < lo) d = -(Math.min(lo - pos, EDGE) / EDGE) * MAX_SPEED;
        else if (pos > hi) d = (Math.min(pos - hi, EDGE) / EDGE) * MAX_SPEED;
        if (d === 0) return;
        let next = scrollOffset.value + d;
        if (next < 0) next = 0;
        else if (next > maxScroll.value) next = maxScroll.value;
        if (next === scrollOffset.value) return;
        scrollTo(scrollRef, scrollAxis === "x" ? next : 0, scrollAxis === "y" ? next : 0, false);
        // scrollTo updates the view but onScroll (which sets scrollOffset) may
        // lag a frame; advance our own estimate so the next hit-test is accurate.
        scrollOffset.value = next;
      };

      return Gesture.Pan()
        .activateAfterLongPress(longPressMs)
        .onBegin(() => {
          "worklet";
          runOnJS(remeasure)();
        })
        .onStart((e) => {
          "worklet";
          active.value = true;
          sourceZoneId.value = source;
          const srcW = frames.value[source]?.width;
          dragW.value = overlayWidth ?? (srcW ? srcW - 20 : 240);
          dragX.value = e.absoluteX - dragW.value / 2;
          dragY.value = e.absoluteY - liftOffsetY;
          hoverZoneId.value = zoneAt(e.absoluteX, e.absoluteY);
          runOnJS(beginDrag)(item);
        })
        .onUpdate((e) => {
          "worklet";
          dragX.value = e.absoluteX - dragW.value / 2;
          dragY.value = e.absoluteY - liftOffsetY;
          autoScroll(e.absoluteX, e.absoluteY);
          const z = zoneAt(e.absoluteX, e.absoluteY);
          if (z !== hoverZoneId.value) hoverZoneId.value = z;
        })
        .onEnd(() => {
          "worklet";
          active.value = false;
          runOnJS(endDrag)(item, hoverZoneId.value, sourceZoneId.value);
          hoverZoneId.value = null;
          sourceZoneId.value = null;
        })
        .onFinalize(() => {
          "worklet";
          if (active.value) {
            active.value = false;
            runOnJS(endDrag)(item, null, sourceZoneId.value);
            hoverZoneId.value = null;
            sourceZoneId.value = null;
          }
        });
    },
    [frames, longPressMs, liftOffsetY, remeasure, beginDrag, endDrag, sourceZoneId, hoverZoneId, dragX, dragY, dragW, scrollAxis, scrollOffset, offsetAtMeasure, scrollIndependentZones, viewport, maxScroll, scrollRef],
  );

  // getId is accepted for API symmetry / future keying; not needed internally
  // since dragging holds the whole item.
  void getId;

  return useMemo(
    () => ({
      dragging,
      scrollLocked,
      hoverZoneId,
      sourceZoneId,
      dragX,
      dragY,
      dragW,
      originX,
      originY,
      registerZone,
      setContainer,
      remeasure,
      panGesture,
      scrollRef,
      scrollHandler,
      onScrollLayout,
      onScrollContentSizeChange,
      scrollAxis,
    }),
    [dragging, scrollLocked, hoverZoneId, sourceZoneId, dragX, dragY, dragW, originX, originY, registerZone, setContainer, remeasure, panGesture, scrollRef, scrollHandler, onScrollLayout, onScrollContentSizeChange, scrollAxis],
  );
}

/**
 * Animated style for a drop zone's hover highlight. Returns an opacity that is 1
 * while the finger hovers `zoneId` (and it isn't the drag's source), else 0 —
 * apply it to an absolutely-filled overlay so the zone lights up on the UI
 * thread with no JS round-trip.
 */
export function useZoneHighlight<T>(ctrl: DragController<T>, zoneId: string) {
  // Capture only the two shared values (not the whole `ctrl`) so the worklet
  // doesn't try to copy non-serialisable members like `scrollHandler`
  // (a WorkletEventHandlerNative) to the UI thread.
  const { hoverZoneId, sourceZoneId } = ctrl;
  return useAnimatedStyle(() => {
    const active = hoverZoneId.value === zoneId && sourceZoneId.value !== zoneId;
    return { opacity: active ? 1 : 0 };
  });
}
