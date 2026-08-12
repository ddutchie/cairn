type Handler = (result: unknown) => void;

/**
 * Result-return bus for native sheet routes.
 *
 * Native `presentation: "formSheet"` routes can't hand a value back through the
 * router, so a picker sheet hands its selection to a callback the *caller*
 * registered before pushing. The caller generates a unique key, registers a
 * handler, and passes the key in the route params; the sheet resolves it (then
 * pops itself) and the handler runs. Registered handlers are removed on resolve,
 * so a cancelled sheet (swipe-down) simply never fires.
 */
const handlers = new Map<string, Handler>();

/** Generate a unique result key for a sheet push. */
export function newSheetResultKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Register the handler that receives the sheet's result. Returns an unregister
 * function (the caller's cleanup).
 */
export function registerSheetResult<T>(key: string, handler: (result: T) => void): () => void {
  handlers.set(key, handler as Handler);
  return () => {
    handlers.delete(key);
  };
}

/** Deliver `result` to the handler registered for `key` (removing it). */
export function resolveSheetResult(key: string, result: unknown): void {
  const handler = handlers.get(key);
  if (handler) {
    handlers.delete(key);
    handler(result);
  }
}
