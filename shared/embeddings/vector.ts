/**
 * Vector math for on-device / local semantic search — pure, dependency-free, so
 * desktop (bge-small pipeline) and mobile (Apple on-device embeddings) score
 * vectors with identical arithmetic. The embedding VECTORS differ per platform
 * (different models/spaces), but the similarity math must not diverge.
 */

const EPS = 1e-9;

/** Cosine similarity of two equal-dimension vectors (normalises internally). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < EPS) return 0;
  return dot / denom;
}

/**
 * Top-K nearest items to `query` by cosine, above `threshold`, excluding
 * `excludeIds`. Generic over any pooled item carrying a `vector` + `noteId`.
 */
export function topK<T extends { vector: Float32Array; noteId: string }>(
  query: Float32Array,
  pool: readonly T[],
  k: number,
  threshold = 0,
  excludeIds: ReadonlySet<string> = new Set(),
): Array<{ item: T; score: number }> {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of pool) {
    if (excludeIds.has(item.noteId)) continue;
    const score = cosine(query, item.vector);
    if (score >= threshold) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Dot product of two vectors. When both are L2-normalised this IS the cosine
 * similarity — cheaper than `cosine` when you've pre-normalised the pool.
 * Returns 0 on a dimension mismatch rather than throwing.
 */
export function dotNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** L2 magnitude (Euclidean norm) of a vector. */
export function magnitude(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

/** Coerce a plain number[] (or pass through a Float32Array) to Float32Array. */
export function toFloat32(vec: number[] | Float32Array): Float32Array {
  if (vec instanceof Float32Array) return vec;
  return new Float32Array(vec);
}
