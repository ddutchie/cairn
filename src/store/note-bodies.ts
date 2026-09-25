/**
 * Lazy note bodies (Electron renderer).
 *
 * The store holds METADATA for every note (title, preview excerpt, tags, …) but
 * a note's `content` is only present once something needs it: the open editor,
 * a dashboard, template instantiation, AI context, etc. Bodies are fetched via
 * `ensureNoteBodies` (notes slice) and kept in a small LRU; pinned ids (open
 * editors/panels) are never evicted. This keeps renderer memory proportional to
 * note COUNT rather than total note size (≈6MB vs ≈40MB+ at 10k notes).
 *
 * In the web build (no Electron) notes always carry their content and all of
 * this is a no-op.
 */

/** Unpinned bodies kept after use (recently opened notes stay instant). */
export const MAX_CACHED_BODIES = 50;

const pins = new Map<string, number>();
// Insertion-ordered: first entry = least recently used.
const lru = new Map<string, true>();

export function pinNoteBody(id: string): void {
  pins.set(id, (pins.get(id) ?? 0) + 1);
  touchNoteBody(id);
}

export function unpinNoteBody(id: string): void {
  const n = (pins.get(id) ?? 0) - 1;
  if (n > 0) pins.set(id, n);
  else pins.delete(id);
}

export function touchNoteBody(id: string): void {
  lru.delete(id);
  lru.set(id, true);
}

export function forgetNoteBody(id: string): void {
  lru.delete(id);
}

/**
 * Ids whose bodies should be dropped to get back under the cache limit:
 * least-recently-used first, never pinned ones, never ones `keep` vetoes
 * (e.g. a note with an in-flight own write).
 */
export function bodiesToEvict(keep: (id: string) => boolean): string[] {
  const out: string[] = [];
  let excess = lru.size - MAX_CACHED_BODIES;
  if (excess <= 0) return out;
  for (const id of lru.keys()) {
    if (excess <= 0) break;
    if (pins.has(id) || keep(id)) continue;
    out.push(id);
    excess--;
  }
  for (const id of out) lru.delete(id);
  return out;
}

/** True when note bodies are loaded lazily (Electron); false in the web build. */
export function lazyNoteBodies(): boolean {
  return typeof window !== "undefined" && !!window.electron?.note?.bodies;
}

/** Test hook. */
export function __resetNoteBodyCache(): void {
  pins.clear();
  lru.clear();
}
