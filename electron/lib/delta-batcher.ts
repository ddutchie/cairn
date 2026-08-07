/**
 * Delta batcher — coalesce high-frequency streamed deltas (content/reasoning
 * tokens) into a single emit per flush interval.
 *
 * The loops stream one delta per SSE chunk; shipping each as its own IPC event
 * floods the renderer (a store update + React render per token — hundreds per
 * second for reasoning models, doubled by subagents). The renderer only cares
 * about the accumulated text, so batching is invisible to it — but callers MUST
 * flush() on turn completion (done/error/abort) so no buffered bytes are lost.
 */

export interface DeltaBatcher {
  push: (delta: string) => void;
  flush: () => void;
}

/** Flush cadence. 50ms (~20 flushes/sec) is imperceptible for streaming. */
export const DELTA_FLUSH_MS = 50;

export function createDeltaBatcher(
  emit: (delta: string) => void,
  flushMs = DELTA_FLUSH_MS,
): DeltaBatcher {
  let buf = "";
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf) {
      const chunk = buf;
      buf = "";
      emit(chunk);
    }
  };

  return {
    push(delta) {
      buf += delta;
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
  };
}
