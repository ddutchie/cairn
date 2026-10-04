"use client";

import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorMessage, IpcUnavailableError } from "@/lib/ipc/client";

export interface IpcQueryOptions<T> {
  /** Value before the first load resolves (also kept while reloading). */
  initialData?: T;
  /** Skip loading while false (e.g. no project selected). */
  enabled?: boolean;
  /** Re-fetch silently on this interval (ms). */
  pollMs?: number;
  /** Keep the previous object when the new one is equal, so polls don't re-render. */
  isEqual?: (prev: T, next: T) => boolean;
}

export interface IpcQuery<T> {
  data: T;
  /** Message of the last failed load; cleared by the next success. */
  error: string | null;
  /** True while a non-silent load is in flight. */
  loading: boolean;
  /** Re-run the loader. `silent` skips the loading flag (used by polls). */
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  clearError: () => void;
}

/**
 * Load data over IPC with loading / error state. A load that finishes after
 * `deps` changed (or after unmount) is dropped, so a slow response for the old
 * project can't overwrite the new one. Outside Electron the query stays idle
 * with its initial data.
 */
export function useIpcQuery<T>(loader: () => Promise<T>, deps: DependencyList, options: IpcQueryOptions<T> & { initialData: T }): IpcQuery<T>;
export function useIpcQuery<T>(loader: () => Promise<T>, deps: DependencyList, options?: IpcQueryOptions<T>): IpcQuery<T | undefined>;
export function useIpcQuery<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  options: IpcQueryOptions<T> = {},
): IpcQuery<T | undefined> {
  const { initialData, enabled = true, pollMs } = options;
  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  // Latest loader / comparator without making them effect dependencies —
  // `deps` decides when the query is stale.
  const loaderRef = useRef(loader);
  const isEqualRef = useRef(options.isEqual);
  useEffect(() => {
    loaderRef.current = loader;
    isEqualRef.current = options.isEqual;
  });

  // Bumped whenever deps change or the component unmounts; a load only
  // commits if the generation it started in is still current.
  const generationRef = useRef(0);
  const pendingLoudRef = useRef(0);

  const run = useCallback(async (generation: number, silent: boolean) => {
    if (!silent) {
      pendingLoudRef.current++;
      setLoading(true);
    }
    try {
      const next = await loaderRef.current();
      if (generation !== generationRef.current) return;
      setData((prev) => {
        const isEqual = isEqualRef.current;
        return prev !== undefined && isEqual?.(prev, next) ? prev : next;
      });
      setError((prev) => (prev === null ? prev : null));
    } catch (err) {
      if (generation !== generationRef.current || err instanceof IpcUnavailableError) return;
      setError(errorMessage(err));
    } finally {
      // The counter is reset per generation, so only current loads settle it.
      if (!silent && generation === generationRef.current && --pendingLoudRef.current === 0) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    pendingLoudRef.current = 0;
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the query is switched off
      setLoading(false);
      return;
    }
    void run(generation, false);
    const poll = pollMs ? setInterval(() => void run(generation, true), pollMs) : undefined;
    return () => {
      // Deliberately the live value: invalidate whatever generation is current.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generationRef.current++;
      if (poll) clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps decide staleness
  }, [enabled, pollMs, run, ...deps]);

  const reload = useCallback(
    (opts?: { silent?: boolean }) => (enabled ? run(generationRef.current, !!opts?.silent) : Promise.resolve()),
    [enabled, run],
  );
  const clearError = useCallback(() => setError(null), []);

  return { data, error, loading, reload, clearError };
}
