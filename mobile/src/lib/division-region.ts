import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { EventSubscription } from "expo-modules-core";
import { FoldRegion, type DivisionRegionPayload } from "@modules/fold-region";
import type { Frame } from "@/lib/fold";

/**
 * The real crease reported by the OS (iPhone Duo, iOS 27.1 division
 * `ReservedRegion`), via the local `fold-region` module. `undefined` means the
 * API isn't available (Android, older iOS, build without the module) so callers
 * infer the crease instead (`resolveFold`); `null` means "available, no active
 * region right now".
 */
let current: Frame | null | undefined;
let initialised = false;
const listeners = new Set<() => void>();
let subscription: EventSubscription | null = null;

function toState(p: DivisionRegionPayload): Frame | null | undefined {
  if (!p.supported) return undefined;
  if (!p.frame) return null;
  const [x, y, width, height] = p.frame;
  return { x, y, width, height };
}

function same(a: Frame | null | undefined, b: Frame | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function set(next: Frame | null | undefined) {
  initialised = true;
  if (same(current, next)) return;
  current = next;
  listeners.forEach((l) => l());
}

/** Re-query the OS now (the pose or window changed; the event usually beats this). */
export function refreshDivisionRegion() {
  if (Platform.OS !== "ios" || !FoldRegion) return;
  try {
    set(toState(FoldRegion.getDivisionRegion()));
  } catch {
    set(undefined);
  }
}

function snapshot(): Frame | null | undefined {
  if (!initialised) refreshDivisionRegion();
  if (!initialised) set(undefined);
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && FoldRegion && !subscription) {
    // Adding the first listener also starts the native observer (OnStartObserving).
    subscription = FoldRegion.addListener("onDivisionRegionChange", (p) => set(toState(p)));
    refreshDivisionRegion();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscription) {
      subscription.remove();
      subscription = null;
    }
  };
}

/** The OS-reported crease frame (window points); see the module doc for `undefined` vs `null`. */
export function useDivisionRegion(): Frame | null | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
