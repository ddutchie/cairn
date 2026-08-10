import type { Tag } from "@/types";

interface Tagged {
  tagIds: string[];
}

/** Sort tags by combined usage across the given notes/cards collections (descending). */
export function sortTagsByUsage<T extends Tag>(tags: T[], ...collections: Tagged[][]): T[] {
  const counts = new Map<string, number>();
  for (const collection of collections) {
    for (const item of collection) {
      for (const id of item.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...tags].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
}

/** Split tags into the first `max` and the rest (for "+N" overflow pills). */
export function capTags<T extends Tag>(tags: T[], max: number): { shown: T[]; hidden: T[] } {
  return { shown: tags.slice(0, max), hidden: tags.slice(max) };
}
