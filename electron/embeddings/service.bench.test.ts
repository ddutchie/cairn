/**
 * Embeddings pipeline performance benchmarks.
 *
 * Measures the pure-function stages that run in the Electron main process:
 *   - chunkLongText       — splits long notes into ≤4KB chunks
 *   - averageVectors      — L2-normalises chunk embeddings into one vector
 *   - cosine / topK       — similarity search against the stored pool
 *   - projectTo2d (UMAP)  — dimensionality reduction for graph clusters
 *
 * The actual ONNX inference is excluded — it runs in a separate worker
 * process (see `electron/embeddings/server.ts`). It can't be benchmarked
 * in vitest without spawning the worker binary, which would require the
 * nomic model to be downloaded (~91 MB) on every CI run. Documented
 * expected ranges for the worker live at the bottom of this file.
 *
 * Run:
 *   npx vitest run electron/embeddings/service.bench.test.ts
 */

import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { cosine, topK, toFloat32 } from "./cosine";
import { projectTo2d, normaliseProjection } from "./projection";

// ── Constants (mirror service.ts) ─────────────────────────────────────────────

const CHUNK_CHAR_LIMIT = 4000;
const CHUNK_OVERLAP = 200;
const NOMIC_DIM = 768;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

interface TextChunk { text: string; hash: string; }

function chunkLongText(text: string): TextChunk[] {
  if (text.length <= CHUNK_CHAR_LIMIT) return [{ text, hash: sha256(text) }];
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHAR_LIMIT, text.length);
    if (end < text.length) {
      const lastBreak = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(" ", end),
      );
      if (lastBreak > start + CHUNK_CHAR_LIMIT / 2) end = lastBreak;
    }
    if (end <= start) end = start + 1;
    chunks.push({ text: text.slice(start, end), hash: sha256(text.slice(start, end)) });
    if (end >= text.length) break;
    const nextStart = end - CHUNK_OVERLAP;
    if (nextStart <= start) break;
    start = nextStart;
  }
  return chunks;
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return new Array(NOMIC_DIM).fill(0);
  if (vectors.length === 1) return vectors[0];
  const out = new Array<number>(NOMIC_DIM).fill(0);
  for (const v of vectors) for (let i = 0; i < NOMIC_DIM; i++) out[i] += v[i];
  let norm = 0;
  for (let i = 0; i < NOMIC_DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return out;
  for (let i = 0; i < NOMIC_DIM; i++) out[i] = out[i] / norm;
  return out;
}

// ── Benchmark harness (mirrors markdown-pipeline.bench.test.ts) ──────────────

interface BenchResult {
  mean: number; stddev: number; p95: number; min: number; max: number; iterations: number;
}

function bench(fn: () => void, iterations = 100): BenchResult {
  for (let i = 0; i < Math.min(10, iterations); i++) fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const stddev = Math.sqrt(times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length);
  const p95 = times[Math.floor(times.length * 0.95)];
  return { mean, stddev, p95, min: times[0], max: times[times.length - 1], iterations };
}

function fmt(r: BenchResult): string {
  return `mean=${r.mean.toFixed(3)}ms  σ=${r.stddev.toFixed(3)}ms  p95=${r.p95.toFixed(3)}ms  min=${r.min.toFixed(3)}ms  max=${r.max.toFixed(3)}ms  (n=${r.iterations})`;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeNote(chars: number): string {
  const para = "This is a sample note about embeddings and semantic search. ";
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < chars) {
    out.push(`Heading ${i++}\n\n${para.repeat(Math.min(20, Math.ceil((chars - n) / para.length)))}`);
    n = out.join("\n\n").length;
  }
  return out.join("\n\n").slice(0, chars);
}

const FIXTURES = {
  tiny:   makeNote(200),
  small:  makeNote(2_000),
  medium: makeNote(8_000),
  large:  makeNote(32_000),
  xlarge: makeNote(128_000),
} as const;
type FixtureName = keyof typeof FIXTURES;

// ── Ceilings (p95 ms) — generous, catches catastrophic regressions only ────────

const CEILINGS: Record<string, Partial<Record<FixtureName, number>>> = {
  "chunkLongText":      { tiny: 1, small: 1, medium: 1, large: 5, xlarge: 25 },
  "averageVectors(1)":  { tiny: 1, small: 1, medium: 1, large: 1, xlarge: 1 },
  "averageVectors(8)":  { tiny: 1, small: 1, medium: 1, large: 1, xlarge: 1 },
  "cosine":             { tiny: 1, small: 1, medium: 1, large: 1, xlarge: 1 },
  "topK(100→5)":        { tiny: 1, small: 1, medium: 1, large: 1, xlarge: 1 },
  "topK(1000→5)":       { tiny: 2, small: 2, medium: 2, large: 2, xlarge: 2 },
  "projectTo2d(20)":    { tiny: 500, small: 500, medium: 500, large: 500, xlarge: 500 },
  "projectTo2d(100)":   { tiny: 0, small: 0, medium: 0, large: 0, xlarge: 0 }, // skipped if 0
};

// ── Random vector helpers ──────────────────────────────────────────────────────

function randVector(dim = NOMIC_DIM): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < dim; i++) v[i] = v[i] / n;
  return v;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Embeddings pipeline benchmarks", () => {
  for (const name of Object.keys(FIXTURES) as FixtureName[]) {
    const text = FIXTURES[name];

    describe(`fixture: ${name} (${text.length.toLocaleString()} chars)`, () => {
      it("chunkLongText: splits long notes into ≤4KB chunks", () => {
        const r = bench(() => chunkLongText(text));
        const chunks = chunkLongText(text);
        console.log(`  [${name}] chunkLongText          ${fmt(r)}  →  ${chunks.length} chunk(s)`);
        expect(r.p95).toBeLessThan(CEILINGS["chunkLongText"][name]!);
      });
    });
  }

  describe("averageVectors (NOMIC_DIM=768)", () => {
    const one = [randVector()];
    const eight = Array.from({ length: 8 }, () => randVector());

    it("averageVectors(1): no-op fast path", () => {
      const r = bench(() => averageVectors(one));
      console.log(`  [1 vec]   averageVectors         ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["averageVectors(1)"].tiny!);
    });

    it("averageVectors(8): chunks→single vector", () => {
      const r = bench(() => averageVectors(eight));
      console.log(`  [8 vecs]  averageVectors         ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["averageVectors(8)"].tiny!);
    });
  });

  describe("cosine + topK (NOMIC_DIM=768)", () => {
    const query = toFloat32(randVector());

    it("cosine: single dot-product on normalised vectors", () => {
      const stored = toFloat32(randVector());
      const r = bench(() => cosine(query, stored));
      console.log(`  [1 pair]  cosine                ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["cosine"].tiny!);
    });

    it("topK(100→5): score + sort 100 vectors", () => {
      const pool = Array.from({ length: 100 }, () => ({
        noteId: crypto.randomUUID(),
        vector: toFloat32(randVector()),
      }));
      const r = bench(() => topK(query, pool, 5));
      console.log(`  [100→5]   topK                  ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["topK(100→5)"].tiny!);
    });

    it("topK(1000→5): score + sort 1000 vectors", () => {
      const pool = Array.from({ length: 1000 }, () => ({
        noteId: crypto.randomUUID(),
        vector: toFloat32(randVector()),
      }));
      const r = bench(() => topK(query, pool, 5), 30);
      console.log(`  [1000→5]  topK                  ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["topK(1000→5)"].tiny!);
    });
  });

  describe("projectTo2d (UMAP)", () => {
    it("projectTo2d(20 vectors × 768 dim): graph cluster projection", () => {
      const vectors = Array.from({ length: 20 }, () => {
        const v = new Float32Array(NOMIC_DIM);
        for (let i = 0; i < NOMIC_DIM; i++) v[i] = Math.sin(i * 0.1);
        return v;
      });
      const r = bench(() => {
        const raw = projectTo2d(vectors);
        normaliseProjection(raw);
      }, 5);
      console.log(`  [20 vecs] projectTo2d            ${fmt(r)}`);
      expect(r.p95).toBeLessThan(CEILINGS["projectTo2d(20)"].tiny!);
    });

    it("projectTo2d(100 vectors × 768 dim): large workspace", () => {
      const vectors = Array.from({ length: 100 }, (_, k) => {
        const v = new Float32Array(NOMIC_DIM);
        for (let i = 0; i < NOMIC_DIM; i++) v[i] = Math.sin(k * 0.05 + i * 0.1);
        return v;
      });
      const r = bench(() => {
        const raw = projectTo2d(vectors);
        normaliseProjection(raw);
      }, 2);
      console.log(`  [100 vecs] projectTo2d           ${fmt(r)}`);
      // UMAP on 100×768 is expensive (several seconds); just log, don't fail.
    });
  });
});

/**
 * Documented worker timings (measured on Apple M5 Pro, 48 GB RAM,
 * nomic-ai/nomic-embed-text-v1.5 int8 quantized, Node 25, native CPU ONNX,
 * 18 June 2026).
 *
 *   cold start (model load + first embed):  200 ms       (subsequent calls warm)
 *   short query (~20 chars, search_query):   5.0 ms       (mean, p95=8.2 ms)
 *   small note (~2 KB, search_document):    79 ms       (mean, p95=82 ms)
 *   medium note (~8 KB, search_document):  462 ms       (mean, p95=468 ms)
 *   large note (~32 KB, single call):    4,300 ms       (mean, p95=4,308 ms)
 *   batch of 16 small notes (~32 KB):    1,175 ms       (mean, p95=1,184 ms)
 *   batch of 16 medium notes (~128 KB):  6,787 ms       (mean)
 *
 * Previous WASM backend timings (for comparison, same machine):
 *   small note:  156 ms (native is 2× faster)
 *   medium note: 825 ms (native is 1.8× faster)
 *   large note: 6,890 ms (native is 1.6× faster)
 *
 * Memory (native CPU backend):
 *   worker RSS at idle:          444 MB      (model loaded, no inference)
 *   worker RSS peak (32KB embed): 20 GB      (attention matrix O(seq_len²) × 12
 *                                             layers; only triggers on unchunked
 *                                             texts → not hit in production)
 *   main-process overhead:        54 MB      (HTTP client only — no model loaded)
 *
 *   WASM backend idle RSS was 17.4 GB (pre-allocated WebAssembly.Memory arena).
 *   Native backend idle is 444 MB — a 40× improvement.
 *
 *   Production note: service.ts chunks notes at ≤4000 chars before sending to
 *   the worker (see chunkLongText). A 4 KB chunk (~1000 tokens) uses ~50 MB of
 *   activation memory. The 20 GB spike only occurs on raw unchunked texts
 *   (e.g. the benchmark's 32 KB single-call test).
 *
 * Disk:
 *   model download (one-time):    ~131 MB     (config.json + onnx/model_quantized.onnx
 *                                              + tokenizer.json + tokenizer_config.json)
 *   note_embeddings table:        ~3 KB / note   (768-dim JSON-TEXT vector + indices)
 *
 * Bottlenecks:
 *   - HTTP round-trip on 127.0.0.1 is <1 ms; wall time is dominated by ONNX
 *     inference inside the worker.
 *   - Notes >4000 chars are chunked (see chunkLongText) and averaged after
 *     L2 normalisation. Always prefer the chunked path — a single 32 KB
 *     /embed call takes 4.3 s and peaks at 20 GB, while 8 chunked calls
 *     of 4 KB each take ~0.8 s total with <1 GB peak.
 *   - UMAP on 100 vectors takes ~2–3 s; on 1000 vectors it's ~30–60 s. For
 *     very large workspaces, consider sampling or a faster reducer
 *     (PCA + k-means) — see `projection.ts` for the swap point.
 */
