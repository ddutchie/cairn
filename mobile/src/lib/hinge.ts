import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import { addHingeListener, getHinge } from "expo-hinge";
import { statusFromHinge } from "@/lib/hinge-status";
import type { HingeStatus } from "@expo/ui/swift-ui/modifiers";

/**
 * Last hinge status any view observed (iPhone Duo). `onHingeChange` only reports
 * once a view appears, so a freshly mounted column would lay out one frame
 * without knowing about the fold; seeding its state from here avoids that jump.
 * Reactive too (`useHingeStatus`), so RN-drawn screens can lay out around the
 * fold without hosting a SwiftUI view of their own.
 *
 * The source is `expo-hinge` (Expo SDK 58): its listener works from plain JS — no SwiftUI
 * host needed — and seeds the cache synchronously, so the first render already knows the
 * pose. It is a no-op (null) where the API or a hinge is missing. `rememberHingeStatus`
 * stays for anything else that learns the status.
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

// Feed the cache from expo-hinge for the app's lifetime (null-safe where unavailable).
try {
  const initial = statusFromHinge(getHinge(), Platform.OS);
  if (initial) last = initial;
  addHingeListener((event) => {
    rememberHingeStatus(statusFromHinge(event.hinge, Platform.OS));
  });
} catch {
  // Native module missing in this build: nothing reports, so useFold stays on its null path.
}
