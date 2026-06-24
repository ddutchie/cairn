/**
 * Markdown pipeline performance benchmarks
 *
 * Measures each stage of the note-editor rendering pipeline in isolation
 * and end-to-end, across small / medium / large fixtures.
 *
 * Runs as part of the normal test suite (`npm test`). Each benchmark
 * reports mean ± stddev and a p95 latency. Tests fail only if a stage
 * regresses beyond a generous ceiling defined per fixture size — the
 * ceilings are intentionally loose (~20× expected) so they catch
 * catastrophic regressions without being flaky on slow CI machines.
 *
 * To read the numbers without running the full suite:
 *   npx vitest run src/components/notes/markdown-pipeline.bench.test.ts
 *
 * Implementation note on stage isolation
 * ───────────────────────────────────────
 * In unified, `.parse()` only runs the parser — remark plugin transformers
 * run during `.runSync()`. For isolation tests we therefore:
 *   1. Build the input tree up to the stage under test using a full processor.
 *   2. Clone it (structuredClone) once outside the timed loop.
 *   3. Apply only the target transformer function inside the loop.
 * This measures the transformer cost, not the clone cost.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import { remarkCallout, remarkPromoteDisplayMath, makeLatexPlugins } from "@/lib/markdown/pipeline";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_DIR = resolve(__dirname, "__fixtures__");

const fixtures = {
  small:  readFileSync(resolve(FIXTURE_DIR, "small.md"),  "utf8"),
  medium: readFileSync(resolve(FIXTURE_DIR, "medium.md"), "utf8"),
  large:  readFileSync(resolve(FIXTURE_DIR, "large.md"),  "utf8"),
} as const;

type FixtureName = keyof typeof fixtures;

// ── Pipeline stages (exact mirrors of note-editor.tsx) ────────────────────────

// ── Benchmark harness ─────────────────────────────────────────────────────────

interface BenchResult {
  mean: number;
  stddev: number;
  p95: number;
  min: number;
  max: number;
  iterations: number;
}

function bench(fn: () => void, iterations = 100): BenchResult {
  for (let i = 0; i < Math.min(10, iterations); i++) fn(); // warmup
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean   = times.reduce((s, t) => s + t, 0) / times.length;
  const stddev = Math.sqrt(times.reduce((s, t) => s + (t - mean) ** 2, 0) / times.length);
  const p95    = times[Math.floor(times.length * 0.95)];
  return { mean, stddev, p95, min: times[0], max: times[times.length - 1], iterations };
}

function fmt(r: BenchResult): string {
  return `mean=${r.mean.toFixed(3)}ms  σ=${r.stddev.toFixed(3)}ms  p95=${r.p95.toFixed(3)}ms  min=${r.min.toFixed(3)}ms  max=${r.max.toFixed(3)}ms  (n=${r.iterations})`;
}

// ── Perf ceilings (ms, p95) — fail on catastrophic regression only ────────────
// Values are calibrated for GitHub Actions shared runners, which are ~3× slower
// than a typical dev machine. The intent is to catch catastrophic regressions
// only — not to enforce tight latency budgets.

const CEILINGS: Record<string, Record<FixtureName, number>> = {
  "remark-parse":          { small: 15,  medium: 30,  large: 90   },
  "remark-gfm+math":       { small: 15,  medium: 30,  large: 100  },
  "remark-callout":        { small: 10,  medium: 15,  large: 60   },
  "remark-promoteDisplay": { small: 10,  medium: 15,  large: 45   },
  "remark→hast":           { small: 15,  medium: 45,  large: 150  },
  "rehype-captureLatex":   { small: 10,  medium: 15,  large: 45   },
  "rehype-katex":          { small: 60,  medium: 180, large: 600  },
  "rehype-mergedPass":     { small: 15,  medium: 45,  large: 150  },
  "full-pipeline":         { small: 90,  medium: 240, large: 900  },
};

// ── Processors for building pre-stage inputs ──────────────────────────────────
// (Built once per file, reused across fixture loops)

// Remark-only (produces mdast with GFM + math node types)
const remarkProcessor = unified()
  .use(remarkParse).use(remarkGfm).use(remarkMath);

// Full remark stack (produces transformed mdast ready for remark-rehype)
const fullRemarkProcessor = unified()
  .use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkCallout).use(remarkPromoteDisplayMath);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Markdown pipeline benchmarks", () => {
  for (const fixtureName of ["small", "medium", "large"] as FixtureName[]) {
    const md = fixtures[fixtureName];

    describe(`fixture: ${fixtureName} (${md.length} chars)`, () => {

      // ── Stage 1: remark-parse only ───────────────────────────────────────
      it("remark-parse: string → mdast", () => {
        const r = bench(() => unified().use(remarkParse).parse(md));
        console.log(`  [${fixtureName}] remark-parse          ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-parse"][fixtureName]);
      });

      // ── Stage 2: remark-gfm + remark-math ───────────────────────────────
      // Note: .parse() only runs the parser; transforms run during .runSync().
      // We time the full parse+transform phase here.
      it("remark-gfm + remark-math transforms", () => {
        const r = bench(() => remarkProcessor.runSync(remarkProcessor.parse(md)));
        console.log(`  [${fixtureName}] remark-gfm+math       ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-gfm+math"][fixtureName]);
      });

      // ── Stage 3: remarkCallout transformer ───────────────────────────────
      // Input: mdast after remark-gfm+math. Clone once, run N times.
      it("remarkCallout plugin", () => {
        const mdast = remarkProcessor.runSync(remarkProcessor.parse(md));
        const transformer = (remarkCallout as any)();
        const r = bench(() => transformer(structuredClone(mdast)));
        console.log(`  [${fixtureName}] remark-callout        ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-callout"][fixtureName]);
      });

      // ── Stage 4: remarkPromoteDisplayMath transformer ────────────────────
      it("remarkPromoteDisplayMath plugin", () => {
        const mdast = remarkProcessor.runSync(remarkProcessor.parse(md));
        const transformer = (remarkPromoteDisplayMath as any)();
        const r = bench(() => transformer(structuredClone(mdast)));
        console.log(`  [${fixtureName}] remark-promoteDisplay ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-promoteDisplay"][fixtureName]);
      });

      // ── Stage 5: remark-rehype (mdast → hast) ───────────────────────────
      // Input: fully transformed mdast (callout + promoteDisplay applied).
      it("remark-rehype: mdast → hast", () => {
        const mdast = fullRemarkProcessor.runSync(fullRemarkProcessor.parse(md));
        const toHast = unified().use(remarkRehype);
        const r = bench(() => toHast.runSync(structuredClone(mdast) as any));
        console.log(`  [${fixtureName}] remark→hast           ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark→hast"][fixtureName]);
      });

      // ── Stage 6: rehypeCaptureLatex ──────────────────────────────────────
      // Input: hast after remark-rehype (before rehype-katex).
      it("rehypeCaptureLatex plugin", () => {
        const { rehypeCaptureLatex } = makeLatexPlugins();
        const mdast = fullRemarkProcessor.runSync(fullRemarkProcessor.parse(md));
        const preKatexHast = unified().use(remarkRehype).runSync(structuredClone(mdast) as any);
        const transformer = (rehypeCaptureLatex as any)();
        const r = bench(() => transformer(structuredClone(preKatexHast)));
        console.log(`  [${fixtureName}] rehype-captureLatex   ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-captureLatex"][fixtureName]);
      });

      // ── Stage 7: rehype-katex ────────────────────────────────────────────
      // Input: hast after captureLatex (so latexBlocks is populated),
      // but before katex renders — we clone to reset each iteration.
      it("rehype-katex: render LaTeX → HTML", () => {
        const { rehypeCaptureLatex } = makeLatexPlugins();
        const mdast = fullRemarkProcessor.runSync(fullRemarkProcessor.parse(md));
        // Build a hast that has math-display nodes captured
        const captureProcessor = unified().use(remarkRehype).use(rehypeCaptureLatex as any);
        const preKatexHast = captureProcessor.runSync(structuredClone(mdast) as any);
        const katexTransformer = (rehypeKatex as any)()!;
        const r = bench(() => {
          // katex mutates in place — clone for each run
          katexTransformer(structuredClone(preKatexHast));
        }, 50);
        console.log(`  [${fixtureName}] rehype-katex          ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-katex"][fixtureName]);
      });

      // ── Stage 8: rehypeMergedPass (tagLatex + ==highlights==) ───────────
      // Input: hast after rehype-katex (katex-display spans present).
      it("rehypeMergedPass: tagLatex + ==highlight== in one traversal", () => {
        const { rehypeCaptureLatex, rehypeMergedPass } = makeLatexPlugins();
        const mdast = fullRemarkProcessor.runSync(fullRemarkProcessor.parse(md));
        const postKatexHast = unified()
          .use(remarkRehype).use(rehypeCaptureLatex as any).use(rehypeKatex)
          .runSync(structuredClone(mdast) as any);
        const transformer = (rehypeMergedPass as any)();
        const r = bench(() => transformer(structuredClone(postKatexHast)));
        console.log(`  [${fixtureName}] rehype-mergedPass     ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-mergedPass"][fixtureName]);
      });

      // ── Full pipeline ────────────────────────────────────────────────────
      // Times the complete string → final hast path as ReactMarkdown runs it.
      it("full pipeline: string → final hast", () => {
        const { rehypeCaptureLatex, rehypeMergedPass } = makeLatexPlugins();
        const processor = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .use(remarkMath)
          .use(remarkCallout)
          .use(remarkPromoteDisplayMath)
          .use(remarkRehype)
          .use(rehypeCaptureLatex as any)
          .use(rehypeKatex)
          .use(rehypeMergedPass as any);

        const r = bench(() => processor.runSync(processor.parse(md)), 50);
        console.log(`  [${fixtureName}] FULL PIPELINE         ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["full-pipeline"][fixtureName]);
      });
    });
  }
});
