"use client";

import { useEffect, useState, useCallback, useRef } from "react";

/**
 * useIpcErrorToasts — listens for `cairn:ipc-error` custom events and surfaces
 * them as auto-dismissing toasts (5s timeout, max 5 visible).
 *
 * Extracted from `src/app/page.tsx` (P3-6 of the cleanup plan) where it was
 * defined inline and caused imports to appear mid-file (after the hook).
 */
export interface ErrorToast {
  id: number;
  message: string;
}

let _toastSeq = 0;

export function useIpcErrorToasts() {
  const [toasts, setToasts] = useState<ErrorToast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    function onIpcError(e: Event) {
      const message = (e as CustomEvent<{ message: string }>).detail.message;
      const id = ++_toastSeq;
      setToasts((prev) => {
        const next = [...prev.slice(-4), { id, message }]; // keep at most 5
        // Clear timers for evicted toasts to prevent leaks
        const evicted = prev.slice(0, -4);
        for (const t of evicted) {
          const timer = timers.current.get(t.id);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(t.id);
          }
        }
        return next;
      });
      timers.current.set(id, setTimeout(() => dismiss(id), 5000));
    }
    window.addEventListener("cairn:ipc-error", onIpcError);
    return () => {
      window.removeEventListener("cairn:ipc-error", onIpcError);
      // Clear all remaining timers on unmount
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
      timers.current.clear();
    };
  }, [dismiss]);

  return { toasts, dismiss };
}
