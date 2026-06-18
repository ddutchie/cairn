const EPS = 1e-9;

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

export function dotNormalized(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function magnitude(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

export function toFloat32(vec: number[] | Float32Array): Float32Array {
  if (vec instanceof Float32Array) return vec;
  return new Float32Array(vec);
}
