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
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
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

  /** Ref callback to register a drop zone's measurable node by id. */
  registerZone: (zoneId: string, node: View | null) => void;
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
}

export function useDragController<T>({
  getId,
  onDrop,
  longPressMs = DRAG_LONG_PRESS_MS,
  liftOffsetY = 30,
}: UseDragControllerArgs<T>): DragController<T> {
  const hoverZoneId = useSharedValue<string | null>(null);
  const sourceZoneId = useSharedValue<string | null>(null);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragW = useSharedValue(240);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const frames = useSharedValue<Record<string, ZoneFrame>>({});

  const containerRef = useRef<View>(null);
  const zoneRefs = useRef<Record<string, View | null>>({});

  const [dragging, setDragging] = useState<T | null>(null);
  const [scrollLocked, setScrollLocked] = useState(false);

  const registerZone = useCallback((zoneId: string, node: View | null) => {
    if (node) zoneRefs.current[zoneId] = node;
    else delete zoneRefs.current[zoneId];
  }, []);

  const setContainer = useCallback((node: View | null) => {
    containerRef.current = node;
  }, []);

  // Re-measure the container origin + every zone's window frame. Runs on the JS
  // thread when a drag begins so hit-testing uses fresh, laid-out coords
  // (measuring in the ref callback alone reads stale x/y before layout flushes).
  const remeasure = useCallback(() => {
    containerRef.current?.measureInWindow((x, y) => {
      originX.value = x;
      originY.value = y;
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
  }, [frames, originX, originY]);

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
      // A worklet closure that hit-tests the finger against the zone frames.
      const zoneAt = (absX: number, absY: number): string | null => {
        "worklet";
        const f = frames.value;
        for (const id in f) {
          const r = f[id];
          if (absX >= r.x && absX <= r.x + r.width && absY >= r.y && absY <= r.y + r.height) {
            return id;
          }
        }
        return null;
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
    [frames, longPressMs, liftOffsetY, remeasure, beginDrag, endDrag, sourceZoneId, hoverZoneId, dragX, dragY, dragW],
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
    }),
    [dragging, scrollLocked, hoverZoneId, sourceZoneId, dragX, dragY, dragW, originX, originY, registerZone, setContainer, remeasure, panGesture],
  );
}

/**
 * Animated style for a drop zone's hover highlight. Returns an opacity that is 1
 * while the finger hovers `zoneId` (and it isn't the drag's source), else 0 —
 * apply it to an absolutely-filled overlay so the zone lights up on the UI
 * thread with no JS round-trip.
 */
export function useZoneHighlight<T>(ctrl: DragController<T>, zoneId: string) {
  return useAnimatedStyle(() => {
    const active = ctrl.hoverZoneId.value === zoneId && ctrl.sourceZoneId.value !== zoneId;
    return { opacity: active ? 1 : 0 };
  });
}
