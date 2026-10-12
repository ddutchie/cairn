import { useSyncExternalStore } from "react";
import type { HingeStatus } from "@expo/ui/swift-ui/modifiers";

/**
 * Last hinge status any view observed (iPhone Duo). `onHingeChange` only reports
 * once a view appears, so a freshly mounted column would lay out one frame
 * without knowing about the fold; seeding its state from here avoids that jump.
 * Reactive too (`useHingeStatus`), so RN-drawn screens can lay out around the
 * fold without hosting a SwiftUI view of their own.
 */
let last: HingeStatus | null = null;
const listeners = new Set<() => void>();

export function lastHingeStatus(): HingeStatus | null {
  return last;
}

export function rememberHingeStatus(status: HingeStatus | null): HingeStatus | null {
  if (status !== last) {
    last = status;
    listeners.forEach((l) => l());
  }
  return status;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest hinge status, re-rendering on change. */
export function useHingeStatus(): HingeStatus | null {
  return useSyncExternalStore(subscribe, lastHingeStatus, lastHingeStatus);
}
