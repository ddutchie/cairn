/**
 * Profile values the user saved a moment ago, before the people list has been
 * reloaded with them. A save lands after a round trip, so saving a time zone and
 * then a location right away would see the old (empty) time zone and let the
 * location's inferred zone replace the one just saved. Reads prefer a recent
 * write over the list; an entry is dropped after `TTL_MS`, by which time the
 * list has caught up.
 */

const TTL_MS = 10_000;
const writes = new Map<string, { value: string | null; at: number }>();

const keyOf = (personId: string, field: string) => `${personId}:${field}`;

/** Remember a value just saved (`null` = cleared). */
export function noteProfileWrite(personId: string, field: string, value: string | null, now = Date.now()): void {
  writes.set(keyOf(personId, field), { value, at: now });
}

/** The value to treat as current: a recent write, else `stored` from the list. */
export function latestProfileValue(personId: string, field: string, stored: string | undefined, now = Date.now()): string | undefined {
  const w = writes.get(keyOf(personId, field));
  if (!w) return stored;
  if (now - w.at > TTL_MS) { writes.delete(keyOf(personId, field)); return stored; }
  return w.value ?? undefined;
}

/** For tests. */
export function clearProfileWrites(): void {
  writes.clear();
}
