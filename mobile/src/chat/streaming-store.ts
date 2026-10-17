import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Lightweight pub/sub for the in-flight assistant text. Stream tokens land here
 * instead of in the screen's `messages` state, so only the streaming bubble's
 * subscriber re-renders per flush — not the whole chat screen and every sibling
 * bubble. The committed text still goes through `setMessages` once, at turn end.
 */
export interface StreamingStore {
  get: () => string;
  /** Replace the text and notify subscribers immediately. */
  set: (value: string) => void;
  /** Throttled `set`: at most one notification per `intervalMs`, trailing edge kept. */
  push: (value: string) => void;
  /** Apply any pending throttled value now. */
  flush: () => void;
  /** Clear the text and drop any pending throttled value. */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

/** ~30fps: smooth enough to read, cheap enough that markdown re-parse keeps up. */
export const STREAM_FLUSH_MS = 33;

export function createStreamingStore(intervalMs = STREAM_FLUSH_MS): StreamingStore {
  let text = "";
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;
  const listeners = new Set<() => void>();

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const emit = (value: string) => {
    lastEmit = Date.now();
    if (value === text) return;
    text = value;
    listeners.forEach((l) => l());
  };

  const store: StreamingStore = {
    get: () => text,
    set: (value) => {
      clearTimer();
      pending = null;
      emit(value);
    },
    push: (value) => {
      const wait = intervalMs - (Date.now() - lastEmit);
      if (wait <= 0 && timer === null) {
        pending = null;
        emit(value);
        return;
      }
      pending = value;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (pending !== null) {
            const v = pending;
            pending = null;
            emit(v);
          }
        }, Math.max(wait, 0));
      }
    },
    flush: () => {
      clearTimer();
      if (pending !== null) {
        const v = pending;
        pending = null;
        emit(v);
      }
    },
    reset: () => {
      clearTimer();
      pending = null;
      lastEmit = 0;
      emit("");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

const noopSubscribe = () => () => {};
const emptyText = () => "";
const noContent = () => false;

/** Provided by the chat screen; bubbles read the live text from it. */
export const StreamingStoreContext = createContext<StreamingStore | null>(null);

/** Live text of the in-flight reply ("" when `active` is false or no provider). */
export function useStreamingText(active: boolean): string {
  const store = useContext(StreamingStoreContext);
  return useSyncExternalStore(
    active && store ? store.subscribe : noopSubscribe,
    active && store ? store.get : emptyText,
    emptyText,
  );
}

/** Whether the in-flight reply has any text yet — re-renders only on flips. */
export function useStreamingHasText(active: boolean): boolean {
  const store = useContext(StreamingStoreContext);
  return useSyncExternalStore(
    active && store ? store.subscribe : noopSubscribe,
    active && store ? () => store.get().length > 0 : noContent,
    noContent,
  );
}
