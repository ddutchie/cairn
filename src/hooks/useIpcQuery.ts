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
 * Load data over IPC with loading / error state. When `deps` change the data
 * resets to `initialData`, and a load that finishes after that (or after
 * unmount, or after a newer load already landed) is dropped, so a slow
 * response for the old project can't overwrite the new one. Outside Electron the query stays idle
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
  const initialDataRef = useRef(initialData);
  useEffect(() => {
    loaderRef.current = loader;
    isEqualRef.current = options.isEqual;
    initialDataRef.current = initialData;
  });

  // Bumped whenever deps change or the component unmounts; a load only
  // commits if the generation it started in is still current.
  const generationRef = useRef(0);
  const pendingLoudRef = useRef(0);
  // Within a generation, a poll and a reload can overlap: only a response
  // newer than the last one committed may land.
  const requestSeqRef = useRef(0);
  const committedSeqRef = useRef(0);
  const startedRef = useRef(false);

  const run = useCallback(async (generation: number, silent: boolean) => {
    const seq = ++requestSeqRef.current;
    const isCurrent = () => generation === generationRef.current && seq > committedSeqRef.current;
    if (!silent) {
      pendingLoudRef.current++;
      setLoading(true);
    }
    try {
      const next = await loaderRef.current();
      if (!isCurrent()) return;
      committedSeqRef.current = seq;
      setData((prev) => {
        const isEqual = isEqualRef.current;
        return prev !== undefined && isEqual?.(prev, next) ? prev : next;
      });
      setError((prev) => (prev === null ? prev : null));
    } catch (err) {
      if (!isCurrent() || err instanceof IpcUnavailableError) return;
      committedSeqRef.current = seq;
      setError(errorMessage(err));
    } finally {
      // The counter is reset per generation, so only current loads settle it.
      if (!silent && generation === generationRef.current && --pendingLoudRef.current === 0) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    pendingLoudRef.current = 0;
    // New inputs: the previous inputs' data and error no longer apply.
    if (startedRef.current) {
      setData(initialDataRef.current);
      setError(null);
    }
    startedRef.current = true;
    if (!enabled) {
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
