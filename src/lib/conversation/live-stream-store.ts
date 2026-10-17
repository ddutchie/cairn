import { useSyncExternalStore } from "react";

/** Text of the in-flight assistant turn. A fresh object per change (snapshot identity). */
export interface LiveStreamSnapshot {
  content: string;
  thought: string;
}

/**
 * External store for the streaming text. The session controller flushes tokens
 * here (once per frame); only the live bubble subscribes, so the surrounding
 * panel (header, composer, transcript list) no longer re-renders per frame.
 */
export interface LiveStreamStore {
  get: () => LiveStreamSnapshot;
  set: (content: string, thought: string) => void;
  subscribe: (listener: () => void) => () => void;
}

const EMPTY: LiveStreamSnapshot = { content: "", thought: "" };

export function createLiveStreamStore(): LiveStreamStore {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set: (content, thought) => {
      if (content === snapshot.content && thought === snapshot.thought) return;
      snapshot = content === "" && thought === "" ? EMPTY : { content, thought };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Subscribe a component to the live text (re-renders per flush — use sparingly). */
export function useLiveStream(store: LiveStreamStore): LiveStreamSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
