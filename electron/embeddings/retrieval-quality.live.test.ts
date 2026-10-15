/**
 * Retrieval-quality benchmark (live) — embedding model comparison.
 *
 * Measures what `service.bench.test.ts` deliberately excludes: end-to-end
 * retrieval quality (top-1 accuracy + MRR) of a real embedding model over a
 * fixed fixture of note-like documents, code snippets (future codebase
 * indexing), and multilingual pairs. The pure-function stages (chunking,
 * cosine/topK, UMAP) are benchmarked separately in `service.bench.test.ts`.
 *
 * Run:
 *   CAIRN_LIVE_TESTS=1 npx vitest run electron/embeddings/retrieval-quality.live.test.ts
 *
 * The first run downloads weights (BGE-small ~33 MB; Gemma q4 ~174 MB) and
 * takes a few minutes on CPU. Results print as a comparison table; the
 * production baseline (BGE-small) is held to quality floors, exploratory
 * contenders are report-only.
 *
 * Adding a contender: append to CONTENDERS with `{ id, dim, formatQuery,
 * formatDoc, load }`. `load` must return `(texts: string[]) =>
 * Promise<number[][]>` of L2-normalised vectors. Pure-cosine scoring here
 * isolates embedding quality from the chunking/search stack in `service.ts`.
 *
 * Multimodal future: fixtures carry a `modality` field (`"text"` | `"code"`;
 * `"image"` reserved). The skipped `describe` at the bottom is the slot for
 * image→text retrieval once a multimodal contender (e.g. EmbeddingGemma-2
 * vision path) is wired up.
 */

import { describe, it } from "vitest";

const LIVE = !process.env.CAIRN_SKIP_LIVE_TESTS && process.env.CAIRN_LIVE_TESTS === "1";

type Modality = "text" | "code";

interface FixtureDoc { id: string; topic: string; modality: Modality; text: string }
interface FixtureQuery { q: string; want: string }

// ── Fixture ─────────────────────────────────────────────────────────────
// Near-miss distractors within a topic (auth ×3, db ×3, cooking ×3, …) plus
// paraphrased queries, so lexical overlap alone does not separate the docs.
// Code docs stand in for future codebase indexing; es/fr/de docs cover the
// multilingual case BGE-small (English-only) is expected to be weak on.

const CORPUS: FixtureDoc[] = [
  { id: "auth-oauth", topic: "auth-oauth", modality: "text", text: "The login pipeline validates OAuth tokens against the session store before issuing a refresh cookie." },
  { id: "auth-pw", topic: "auth-pw", modality: "text", text: "Password reset emails expire after fifteen minutes and invalidate all other active sessions." },
  { id: "auth-mfa", topic: "auth-mfa", modality: "text", text: "Enroll a TOTP authenticator app for step-up verification on unrecognized devices." },
  { id: "db-cover", topic: "db-cover", modality: "text", text: "A covering index on the orders table avoids the heap lookup for status queries." },
  { id: "db-partial", topic: "db-partial", modality: "text", text: "Use a partial index on active subscriptions to keep the write amplification low." },
  { id: "db-vacuum", topic: "db-vacuum", modality: "text", text: "Schedule autovacuum aggressively on high-churn tables to prevent transaction id wraparound." },
  { id: "cook-steak", topic: "cook-steak", modality: "text", text: "Sear the steak on high heat for ninety seconds per side then rest it under foil." },
  { id: "cook-bread", topic: "cook-bread", modality: "text", text: "A slow-fermented sourdough needs twelve hours of bulk fermentation at room temperature." },
  { id: "cook-soup", topic: "cook-soup", modality: "text", text: "Simmer the stock with roasted bones for six hours, skimming the surface every half hour." },
  { id: "fit-zone2", topic: "fit-zone2", modality: "text", text: "Zone two cardio means holding a pace where nasal breathing stays comfortable." },
  { id: "fit-lift", topic: "fit-lift", modality: "text", text: "Progressive overload on the squat works best with small weekly increments." },
  { id: "fit-sleep", topic: "fit-sleep", modality: "text", text: "Deep sleep consolidates motor learning from evening training sessions." },
  { id: "code-py", topic: "code-py", modality: "code", text: "def quicksort(arr): pivot = arr[len(arr)//2]; left = [x for x in arr if x < pivot]" },
  { id: "code-js", topic: "code-js", modality: "code", text: "async function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }" },
  { id: "code-sql", topic: "code-sql", modality: "code", text: "SELECT u.name FROM users u JOIN orders o ON o.user_id = u.id WHERE o.status = 'paid'" },
  { id: "es-train", topic: "es-train", modality: "text", text: "El tren nocturno a Barcelona sale del andén cuatro a las once en punto." },
  { id: "es-food", topic: "es-food", modality: "text", text: "La receta de paella necesita caldo de pescado y azafrán de la Mancha." },
  { id: "fr-garden", topic: "fr-garden", modality: "text", text: "Le jardin botanique ouvre ses portes au public dès huit heures du matin." },
  { id: "de-ubahn", topic: "de-ubahn", modality: "text", text: "Die U-Bahn Linie 8 fährt alle fünf Minuten zum Hauptbahnhof." },
  { id: "en-train", topic: "en-train", modality: "text", text: "Night trains across Austria include a sleeper carriage with private compartments." },
];

const QUERIES: FixtureQuery[] = [
  { q: "my reset link stopped working after a quarter of an hour, are my other devices logged out", want: "auth-pw" },
  { q: "second factor setup for a new phone", want: "auth-mfa" },
  { q: "sign in with google token exchange and session cookies", want: "auth-oauth" },
  { q: "preventing bloat on tables with constant updates and deletes", want: "db-vacuum" },
  { q: "index only part of a table to reduce write cost", want: "db-partial" },
  { q: "how long to simmer bones for broth and when to skim", want: "cook-soup" },
  { q: "recovering after leg day and cementing technique overnight", want: "fit-sleep" },
  { q: "rate-limiting rapid function calls in javascript", want: "code-js" },
  { q: "divide and conquer ordering routine", want: "code-py" },
  { q: "a qué hora sale el tren nocturno", want: "es-train" },
  { q: "recette du plat de riz espagnol", want: "es-food" },
  { q: "night train through Austria with private cabins", want: "en-train" },
  { q: "wann fährt die U-Bahn zum Hauptbahnhof", want: "de-ubahn" },
];

// Quality floors for the production baseline. Set with slack below the
// measured 11/13 / MRR 0.923 (Apple Silicon, Oct 2026) — they catch
// catastrophic regressions (e.g. a dropped query prefix), not noise.
const TOP1_FLOOR = 9;
const MRR_FLOOR = 0.8;

// ── Harness (model-agnostic) ────────────────────────────────────────────

type EmbedFn = (texts: string[]) => Promise<number[][]>;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

interface EvalResult {
  top1: number; total: number; mrr: number; dim: number;
  misses: string[]; queryMsMedian: number; note4kMsMedian: number;
}

async function evaluateRetrieval(
  embed: EmbedFn,
  formatQuery: (t: string) => string,
  formatDoc: (t: string) => string,
): Promise<EvalResult> {
  const docVecs: number[][] = [];
  const formatted = CORPUS.map((d) => formatDoc(d.text));
  for (let i = 0; i < formatted.length; i += 4) {
    docVecs.push(...await embed(formatted.slice(i, i + 4)));
  }
  let top1 = 0;
  let reciprocalSum = 0;
  const misses: string[] = [];
  const queryMs: number[] = [];
  for (const { q, want } of QUERIES) {
    const t0 = performance.now();
    const [qv] = await embed([formatQuery(q)]);
    queryMs.push(performance.now() - t0);
    const ranked = docVecs
      .map((v, i) => ({ i, s: cosine(qv, v) }))
      .sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => CORPUS[r.i].topic === want) + 1;
    if (rank === 1) top1++;
    else misses.push(`want=${want} got=${CORPUS[ranked[0].i].topic} q="${q.slice(0, 64)}"`);
    reciprocalSum += 1 / rank;
  }
  queryMs.sort((a, b) => a - b);
  // 4 KB note = production chunk size (CHUNK_CHAR_LIMIT in service.ts).
  const para = "This is a sample project note about authentication flows and session management. ";
  const note4k = formatDoc(("Project Notes\n\n" + para.repeat(60)).slice(0, 4000));
  await embed([note4k]);
  const noteMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await embed([note4k]);
    noteMs.push(performance.now() - t0);
  }
  noteMs.sort((a, b) => a - b);
  return {
    top1, total: QUERIES.length, mrr: reciprocalSum / QUERIES.length,
    dim: docVecs[0].length, misses,
    queryMsMedian: queryMs[Math.floor(queryMs.length / 2)],
    note4kMsMedian: noteMs[2],
  };
}

// ── Contenders ──────────────────────────────────────────────────────────

interface Contender {
  id: string;
  dim: number;
  formatQuery: (t: string) => string;
  formatDoc: (t: string) => string;
  load: () => Promise<EmbedFn>;
}

async function loadBgeSmall(): Promise<EmbedFn> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
    device: "cpu",
    dtype: "q8",
  });
  return async (texts: string[]) => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  };
}

async function loadEmbeddingGemma2(): Promise<EmbedFn> {
  // Requires @huggingface/transformers ≥4.3.1 (the release that added the
  // EmbeddingGemma2 model class). Text-only callers pass no media; the
  // pipeline feeds the model's multimodal inputs internally.
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", "onnx-community/embeddinggemma-2-ONNX", {
    device: "cpu",
    dtype: "q4",
  });
  return async (texts: string[]) => {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  };
}

const CONTENDERS: Contender[] = [
  {
    id: "bge-small-en-v1.5 (production baseline)",
    dim: 384,
    formatQuery: (t) => `Represent this sentence for searching relevant passages: ${t}`,
    formatDoc: (t) => t,
    load: loadBgeSmall,
  },
  {
    id: "embeddinggemma-2 q4 (exploratory)",
    dim: 768,
    formatQuery: (t) => `task: search result | query: ${t}`,
    formatDoc: (t) => `title: none | text: ${t}`,
    load: loadEmbeddingGemma2,
  },
];

// ── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!LIVE)("retrieval quality (live)", () => {
  for (const contender of CONTENDERS) {
    it(`${contender.id}: top-1 + MRR over fixture`, { timeout: 600_000 }, async ({ expect }) => {
      const t0 = performance.now();
      const embed = await contender.load();
      const loadMs = performance.now() - t0;
      const r = await evaluateRetrieval(embed, contender.formatQuery, contender.formatDoc);
      console.log(
        `  [${contender.id}] top1=${r.top1}/${r.total} MRR=${r.mrr.toFixed(3)} ` +
        `dim=${r.dim} load=${(loadMs / 1000).toFixed(1)}s ` +
        `qMedian=${r.queryMsMedian.toFixed(1)}ms note4kMedian=${r.note4kMsMedian.toFixed(0)}ms`,
      );
      for (const m of r.misses) console.log(`    miss ${m}`);
      expect(r.dim).toBe(contender.dim);
      expect(r.top1).toBeGreaterThanOrEqual(TOP1_FLOOR);
      expect(r.mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
    });
  }
});

describe.skip("multimodal retrieval (reserved)", () => {
  // Slot for image→text (and code→doc at repo scale) once a multimodal
  // contender exists. Fixture docs will gain `modality: "image"` entries
  // with stable asset paths; scoring reuses evaluateRetrieval with an
  // embed fn that accepts the media input. This is the bench the
  // EmbeddingGemma-2 vision/audio path — or any image-capable successor —
  // must pass before product work starts.
  it.todo("image→text retrieval over fixture media assets");
});
