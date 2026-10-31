import { useSyncExternalStore } from "react";
import { getMeta, setMeta } from "@/db";

/**
 * Developer-only switches, persisted in the device-global meta DB like the accent.
 * Every flag is forced off outside dev builds (`__DEV__`), so a release never
 * shows debug UI or unprofiled features even if a flag was left on in a dev build's storage.
 */

function makeFlag(key: string) {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();

  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };

  const get = (): boolean => {
    if (!__DEV__) return false;
    if (value === null) {
      try {
        value = getMeta(key) === "1";
      } catch {
        value = false;
      }
    }
    return value;
  };

  const set = (on: boolean): void => {
    value = on;
    try {
      setMeta(key, on ? "1" : "0");
    } catch {
      // best-effort; the in-memory value still drives this session
    }
    listeners.forEach((l) => l());
  };

  const use = (): boolean => useSyncExternalStore(subscribe, get, get);

  return { get, set, use };
}

const foldOverlay = makeFlag("dev.foldOverlay");
const listeningOrb = makeFlag("dev.listeningOrb");

/** Whether the fold debug overlay (window/insets/hinge readout + crease band) is on. */
export const getFoldOverlay = foldOverlay.get;
export const setFoldOverlay = foldOverlay.set;
export const useFoldOverlay = foldOverlay.use;

/** Whether the Skia listening orb shows while dictating. Ships dark until profiled on older iPhones. */
export const getListeningOrb = listeningOrb.get;
export const setListeningOrb = listeningOrb.set;
export const useListeningOrb = listeningOrb.use;
