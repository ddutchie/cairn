import { useSyncExternalStore } from "react";
import { getMeta, setMeta } from "@/db";

/**
 * The People layer switch on this device (`feature.people`, docs/plans/people-layer.md).
 *
 * The desktop keeps its flag in a per-workspace `app_kv` row that never syncs,
 * and mobile has no such table, so the flag here is a device setting in the
 * meta DB (like the accent). It is OFF unless this device turned it on:
 * Settings → Appearance → Developer in dev builds, or `EXPO_PUBLIC_CAIRN_PEOPLE=1`
 * baked into a preview build. While it is off nothing People-shaped shows
 * (screens, the attendee strip, menu rows) and the chat toolset leaves out the
 * `people` tool and its arguments. The People tables themselves always exist
 * and sync (schema release), flag or not.
 *
 * Read once per use site; the toolset reads it when a chat session starts
 * (`allTools`), so a session's tool list never changes mid-session.
 */

const KEY = "feature.people";

let value: boolean | null = null;
const listeners = new Set<() => void>();

/** True when the People layer is on for this device. */
export function isPeopleEnabled(): boolean {
  if (value === null) {
    try {
      value = process.env.EXPO_PUBLIC_CAIRN_PEOPLE === "1" || getMeta(KEY) === "1";
    } catch {
      value = false;
    }
  }
  return value;
}

export function setPeopleEnabled(on: boolean): void {
  value = on || process.env.EXPO_PUBLIC_CAIRN_PEOPLE === "1";
  try {
    setMeta(KEY, on ? "1" : "0");
  } catch {
    // best-effort; the in-memory value still drives this session
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Re-renders when the flag changes. */
export function usePeopleEnabled(): boolean {
  return useSyncExternalStore(subscribe, isPeopleEnabled, isPeopleEnabled);
}

// ── Preview-features unlock (hidden: tap the version line in Settings 7 times) ──

const UNLOCK_KEY = "preview.unlocked";
let unlocked: boolean | null = null;
const unlockListeners = new Set<() => void>();

/** True once this device unlocked preview features. Device-local meta, never synced. */
export function isPreviewUnlocked(): boolean {
  if (unlocked === null) {
    try {
      unlocked = getMeta(UNLOCK_KEY) === "1";
    } catch {
      unlocked = false;
    }
  }
  return unlocked;
}

export function unlockPreview(): void {
  unlocked = true;
  try {
    setMeta(UNLOCK_KEY, "1");
  } catch {
    // the in-memory value still drives this session
  }
  unlockListeners.forEach((l) => l());
}

const subscribeUnlock = (cb: () => void) => {
  unlockListeners.add(cb);
  return () => {
    unlockListeners.delete(cb);
  };
};

export function usePreviewUnlocked(): boolean {
  return useSyncExternalStore(subscribeUnlock, isPreviewUnlocked, isPreviewUnlocked);
}
