/**
 * Hybrid retrieval ranker — pure and dependency-free so desktop (bge-small +
 * FTS5 bm25) and mobile (Apple on-device embeddings + in-memory keyword score)
 * order results with identical logic. The dense/keyword SCORES come from each
 * platform; fusion, coverage boost, MMR diversification and the adaptive cutoff
 * live here.
 *
 * Pipeline: reciprocal rank fusion over the dense and keyword rankings → a
 * term-coverage boost → normalise to 0..1 → MMR re-rank (so near-duplicates of
 * one another, or sections of one note, don't crowd the list) → adaptive-k cut
 * on score gaps → floor that always keeps the top dense hits.
 */

export interface RetrievalCandidate {
  id: string;
  /** Entity the candidate belongs to (note id). Two candidates sharing a group are
   *  treated as identical by MMR, so only the strongest survives early. */
  group?: string;
  /** Dense similarity, higher is better. Omit when there is no embedding. */
  dense?: number;
  /** Keyword relevance (bm25-like), higher is better. Omit/≤0 when unmatched. */
  keyword?: number;
  /** Title + body, for term coverage and the text-similarity fallback in MMR. */
  title?: string;
  text?: string;
  /** Optional vector for MMR similarity (any scale; cosine is taken). */
  vector?: Float32Array;
}

export interface HybridOptions {
  /** Hard cap on results. Default: no cap. */
  maxK?: number;
  /** RRF constant. Default 60. */
  rrfK?: number;
  /** Max extra score for a candidate covering every query term, as a fraction of
   *  a rank-1 single-list RRF contribution (1/(k+1)). Default 0.25. */
  coverageWeight?: number;
  /** MMR relevance/diversity trade-off. 1 = pure relevance. Default 0.7. */
  lambda?: number;
  /** Adaptive-k: cut at the first drop ≥ gapRatio × top score, or when the score
   *  falls below minRelative × top score. Set adaptive:false to keep everything. */
  adaptive?: boolean;
  gapRatio?: number;
  minRelative?: number;
  /** Candidates (best by fused score) that go through MMR; the rest follow in
   *  fused order. MMR is O(pool²). Default 100. */
  poolSize?: number;
  /** Always keep at least this many of the best dense hits. Default 3. */
  floor?: number;
  /** Share of query terms a candidate's text must contain to count as a keyword
   *  hit when the query has 2+ terms. Default 0.6. */
  minKeywordCoverage?: number;
}

export interface RankedCandidate {
  id: string;
  /** Fused relevance in 0..1 (best possible candidate ≈ 1). */
  score: number;
  /** Position in the dense / keyword ranking (1-based), if present. */
  denseRank?: number;
  keywordRank?: number;
  coverage: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "how", "does", "did", "was", "were", "are", "you", "your",
  "with", "what", "why", "who", "can", "our", "this", "that", "into", "from",
  "work", "works", "use", "used", "using", "get", "got", "has", "have", "about",
  "when", "where", "which", "after", "before", "also", "just", "some", "any", "there", "their", "them", "then", "than", "not",
]);

/** Lowercased alphanumeric tokens (unicode-aware), length > 1. */
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((t) => t.length > 1) ?? [];
}

/** Distinct meaningful query terms: stopwords dropped, ≥3 chars unless the token
 *  has a digit (ids like "v2" or "42" stay searchable). */
export function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const t of tokenize(query)) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 3 && !/\d/.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** FTS5 MATCH expression OR-ing prefix terms (`"a"* OR "b"*`); "" when no terms.
 *  OR (not AND) so a natural-language query still retrieves partial matches —
 *  bm25 ranking and the coverage boost then favour notes matching more terms. */
export function ftsOrQuery(query: string): string {
  return queryTerms(query)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" OR ");
}

/** Fraction of `terms` found (substring, so prefixes/inflections count) in title+text. */
export function termCoverage(terms: string[], title = "", text = ""): number {
  if (terms.length === 0) return 0;
  const hay = `${title}\n${text}`.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.length;
}

/**
 * In-memory BM25 over a small candidate set, title weighted ×3. For platforms
 * with no FTS index to hand (mobile ranks the entities it already scored
 * densely). Returns one score per doc, 0 when nothing matched.
 */
export function bm25Scores(
  terms: string[],
  docs: { title?: string; text?: string }[],
  opts: { k1?: number; b?: number; titleWeight?: number } = {},
): number[] {
  const { k1 = 1.2, b = 0.75, titleWeight = 3 } = opts;
  const n = docs.length;
  if (n === 0 || terms.length === 0) return docs.map(() => 0);
  const tfs = docs.map((d) => {
    const m = new Map<string, number>();
    for (const tok of tokenize(d.title ?? "")) m.set(tok, (m.get(tok) ?? 0) + titleWeight);
    for (const tok of tokenize(d.text ?? "")) m.set(tok, (m.get(tok) ?? 0) + 1);
    return m;
  });
  const lens = tfs.map((m) => {
    let l = 0;
    for (const v of m.values()) l += v;
    return l;
  });
  const avg = lens.reduce((a, c) => a + c, 0) / n || 1;
  // Query terms match as prefixes, mirroring the FTS `term*` query on desktop.
  const tf = (m: Map<string, number>, term: string) => {
    let c = 0;
    for (const [tok, v] of m) if (tok.startsWith(term)) c += v;
    return c;
  };
  const df = terms.map((t) => tfs.reduce((c, m) => c + (tf(m, t) > 0 ? 1 : 0), 0));
  return tfs.map((m, i) => {
    let s = 0;
    terms.forEach((t, ti) => {
      const f = tf(m, t);
      if (f === 0) return;
      const idf = Math.log(1 + (n - df[ti] + 0.5) / (df[ti] + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * lens[i]) / avg)));
    });
    return s;
  });
}

function cosineVec(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den < 1e-9 ? 0 : d / den;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const SIM_TEXT_CHARS = 800;

/** 1-based competition ranks (ties share the best rank) of ids sorted by `score`
 *  desc, only for entries passing `keep`. */
function rankBy(cands: RetrievalCandidate[], score: (c: RetrievalCandidate) => number | undefined, keep: (v: number) => boolean) {
  const ranks = new Map<string, number>();
  const sorted = cands
    .map((c) => ({ id: c.id, v: score(c) }))
    .filter((e): e is { id: string; v: number } => e.v !== undefined && Number.isFinite(e.v) && keep(e.v))
    .sort((a, b) => b.v - a.v);
  sorted.forEach((e, i) => ranks.set(e.id, i > 0 && e.v === sorted[i - 1].v ? ranks.get(sorted[i - 1].id)! : i + 1));
  return ranks;
}

/**
 * Fuse, diversify and cut. `query` is only used for term coverage. The returned
 * list is in final display order.
 */
export function hybridRank(
  query: string,
  candidates: RetrievalCandidate[],
  opts: HybridOptions = {},
): RankedCandidate[] {
  const {
    rrfK = 60,
    coverageWeight = 0.25,
    lambda = 0.7,
    adaptive = true,
    gapRatio = 0.25,
    minRelative = 0.35,
    floor = 3,
    minKeywordCoverage = 0.6,
    poolSize = 100,
  } = opts;
  if (candidates.length === 0) return [];

  const denseRank = rankBy(candidates, (c) => c.dense, () => true);
  const terms = queryTerms(query);
  // Rank-based fusion ignores score magnitude, so a hit on one common word of a
  // multi-term query would otherwise vote like a real match. Candidates with text
  // must cover at least minKeywordCoverage of the terms to join the keyword list
  // or earn the coverage boost.
  const eligible = new Set(
    candidates
      .filter((c) => terms.length < 2 || !(c.title || c.text) || termCoverage(terms, c.title, c.text) >= minKeywordCoverage)
      .map((c) => c.id),
  );
  const kwRank = rankBy(candidates, (c) => (eligible.has(c.id) ? c.keyword : undefined), (v) => v > 0);
  const unit = 1 / (rrfK + 1);
  const maxScore = (denseRank.size > 0 ? unit : 0) + (kwRank.size > 0 ? unit : 0) + coverageWeight * unit;

  const scored = candidates.map((c, idx) => {
    const dr = denseRank.get(c.id);
    const kr = kwRank.get(c.id);
    const coverage = termCoverage(terms, c.title, c.text);
    let s = 0;
    if (dr) s += 1 / (rrfK + dr);
    if (kr) s += 1 / (rrfK + kr);
    if (eligible.has(c.id)) s += coverageWeight * unit * coverage;
    return { c, idx, dr, kr, coverage, score: maxScore > 0 ? s / maxScore : 0 };
  });
  // Stable: ties keep input order.
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  // MMR over the whole pool so a demoted near-duplicate can be replaced by the
  // next-best distinct candidate before the cutoff is applied.
  const tokenSets = new Map<string, Set<string>>();
  const tokensOf = (c: RetrievalCandidate) => {
    let s = tokenSets.get(c.id);
    if (!s) {
      s = new Set(tokenize(`${c.title ?? ""} ${(c.text ?? "").slice(0, SIM_TEXT_CHARS)}`));
      tokenSets.set(c.id, s);
    }
    return s;
  };
  const sim = (a: RetrievalCandidate, b: RetrievalCandidate) => {
    if (a.group !== undefined && a.group === b.group) return 1;
    if (a.vector && b.vector) return Math.max(0, cosineVec(a.vector, b.vector));
    return jaccard(tokensOf(a), tokensOf(b));
  };
  const remaining = scored.slice(0, poolSize);
  const ordered: typeof scored = [];
  while (remaining.length > 0) {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let maxSim = 0;
      for (const s of ordered) maxSim = Math.max(maxSim, sim(remaining[i].c, s.c));
      const val = lambda * remaining[i].score - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    }
    ordered.push(remaining.splice(best, 1)[0]);
  }
  ordered.push(...scored.slice(poolSize));

  // Adaptive-k from the relevance-sorted scores (before MMR reordering).
  let n = scored.length;
  if (adaptive) {
    const top = scored[0].score;
    n = 1;
    while (n < scored.length) {
      const gap = scored[n - 1].score - scored[n].score;
      if (gap >= gapRatio * top || scored[n].score < minRelative * top) break;
      n++;
    }
  }
  const cap = opts.maxK ?? Infinity;
  const keepN = Math.min(Math.max(n, Math.min(floor, scored.length)), cap);

  // Floor: the top dense hits survive the cut regardless of MMR/adaptive-k.
  const floorIds = new Set(
    [...denseRank.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.min(floor, cap)).map(([id]) => id),
  );
  const out = ordered.slice(0, keepN);
  const have = new Set(out.map((o) => o.c.id));
  for (const id of floorIds) {
    if (have.has(id)) continue;
    const entry = ordered.find((o) => o.c.id === id)!;
    // Evict the weakest non-floor tail entry to stay within the cap.
    if (out.length >= cap) {
      let evict = -1;
      for (let i = out.length - 1; i >= 0; i--) if (!floorIds.has(out[i].c.id)) { evict = i; break; }
      if (evict < 0) continue;
      out.splice(evict, 1);
    }
    out.push(entry);
    have.add(id);
  }

  return out.map((o) => ({ id: o.c.id, score: o.score, denseRank: o.dr, keywordRank: o.kr, coverage: o.coverage }));
}
