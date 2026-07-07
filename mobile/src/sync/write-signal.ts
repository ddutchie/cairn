/**
 * Decoupled local-write signal. Write queries call notifyLocalWrite() after a
 * mutation; the sync controller subscribes to schedule a debounced sync. Kept
 * separate from the controller so db/queries.ts doesn't import the controller
 * (which imports queries) — avoids a circular dependency.
 */

type WriteListener = () => void;
const listeners = new Set<WriteListener>();

/** Called by write queries after a local mutation. */
export function notifyLocalWrite(): void {
  for (const l of listeners) l();
}

/** The controller subscribes here. Returns an unsubscribe fn. */
export function onLocalWrite(fn: WriteListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
