import { useSyncExternalStore } from "react";

/**
 * A card the running turn is waiting on: a tool's run awaits `ask`, the chat
 * screen renders the card from `usePending`, and the card settles it. One card
 * per slot: a new ask settles the older one with `fallback` (as does `cancel`,
 * used on Clear chat and when the chat screen goes away).
 */
export function createPendingSlot<P, O>(fallback: O) {
  type Pending = P & { id: number };
  let pending: (Pending & { resolve: (o: O) => void }) | null = null;
  let view: Pending | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const set = (next: typeof pending) => {
    pending = next;
    view = next ? (({ resolve: _r, ...rest }) => rest as unknown as Pending)(next) : null;
    listeners.forEach((l) => l());
  };

  const ask = (payload: P): Promise<O> => {
    pending?.resolve(fallback);
    return new Promise((resolve) => set({ ...payload, id: ++seq, resolve }));
  };
  const settle = (outcome: O): boolean => {
    const p = pending;
    if (!p) return false;
    set(null);
    p.resolve(outcome);
    return true;
  };
  const cancel = (): boolean => settle(fallback);
  const snapshot = (): Pending | null => view;
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const usePending = (): Pending | null => useSyncExternalStore(subscribe, snapshot, snapshot);

  return { ask, settle, cancel, usePending };
}
