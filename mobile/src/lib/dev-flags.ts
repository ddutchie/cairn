import { useSyncExternalStore } from "react";
import { getMeta, setMeta } from "@/db";

/**
 * Developer-only switches, persisted in the device-global meta DB like the accent.
 * Every flag is forced off outside dev builds (`__DEV__`), so a release never
 * shows debug UI even if a flag was left on in a dev build's storage.
 */

const FOLD_OVERLAY_KEY = "dev.foldOverlay";

let foldOverlay: boolean | null = null;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Whether the fold debug overlay (window/insets/hinge readout + crease band) is on. */
export function getFoldOverlay(): boolean {
  if (!__DEV__) return false;
  if (foldOverlay === null) {
    try {
      foldOverlay = getMeta(FOLD_OVERLAY_KEY) === "1";
    } catch {
      foldOverlay = false;
    }
  }
  return foldOverlay;
}

export function setFoldOverlay(on: boolean): void {
  foldOverlay = on;
  try {
    setMeta(FOLD_OVERLAY_KEY, on ? "1" : "0");
  } catch {
    // best-effort; the in-memory value still drives this session
  }
  listeners.forEach((l) => l());
}

export function useFoldOverlay(): boolean {
  return useSyncExternalStore(subscribe, getFoldOverlay, getFoldOverlay);
}
