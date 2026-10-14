/**
 * A stand-in object that builds the real one on first property access.
 *
 * Tool executors used to load the full workspace snapshot (every note body,
 * card, column, tag) before dispatching ANY tool, even ones answered with a
 * single SQL query. Passing `lazy(() => getSnapshot(db))` instead keeps the
 * same `snap.notes` / `snap.cards` call sites while only paying for the load
 * when a handler actually reads it — and then exactly once per call.
 */
export function lazy<T extends object>(load: () => T): T {
  let value: T | undefined;
  const get = (): T => (value ??= load());
  return new Proxy({} as T, {
    get: (_t, key) => Reflect.get(get(), key),
    has: (_t, key) => Reflect.has(get(), key),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(get(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
