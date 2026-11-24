import { useCallback, useRef } from "react";

/**
 * Counts quick clicks; the `n`th within `windowMs` of the first fires
 * `onUnlock`. Used for the arcade easter egg (five clicks on the workspace icon).
 */
export function useSecretTaps(onUnlock: () => void, n = 5, windowMs = 2000): () => void {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < windowMs), now];
    if (taps.current.length >= n) {
      taps.current = [];
      onUnlock();
    }
  }, [onUnlock, n, windowMs]);
}
