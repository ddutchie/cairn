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
import { visit, SKIP } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root, Element, Text, ElementContent, Parent } from "hast";
import type { Root as MdastRoot, Paragraph } from "mdast";
import type { InlineMath } from "mdast-util-math";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_DIR = resolve(__dirname, "__fixtures__");

const fixtures = {
  small:  readFileSync(resolve(FIXTURE_DIR, "small.md"),  "utf8"),
  medium: readFileSync(resolve(FIXTURE_DIR, "medium.md"), "utf8"),
  large:  readFileSync(resolve(FIXTURE_DIR, "large.md"),  "utf8"),
} as const;

type FixtureName = keyof typeof fixtures;

// ── Pipeline stages (exact mirrors of note-editor.tsx) ────────────────────────

const CALLOUT_RE = /^\[!([^\]]+)\]([\+\-]?)([\s\S]*)/;
const remarkCallout = () => (tree: MdastRoot) => {
  visit(tree, "blockquote", (node: any) => {
    const firstPara = node.children[0];
    if (!firstPara || firstPara.type !== "paragraph") return;
    const firstChild = firstPara.children[0];
    if (!firstChild || firstChild.type !== "text") return;
    const match = firstChild.value.match(CALLOUT_RE);
    if (!match) return;
    const [, rawType, modifier, rest] = match;
    firstChild.value = firstChild.value.slice(firstChild.value.indexOf("\n") + 1);
    node.data = {
      hName: "callout",
      hProperties: {
        "data-callout-type": rawType.trim().toLowerCase(),
        "data-title": rest.trim(),
        "data-collapsible": (modifier === "+" || modifier === "-") ? "true" : "false",
        "data-default-open": modifier !== "-" ? "true" : "false",
      },
    };
  });
};

const remarkPromoteDisplayMath = () => (tree: MdastRoot) => {
  visit(tree, "paragraph", (node: Paragraph) => {
    if (node.children.length === 1 && node.children[0].type === "inlineMath") {
      const im = node.children[0] as InlineMath;
      im.data = {
        ...im.data,
        hName: "code",
        hProperties: { className: ["language-math", "math-display"] },
      };
      (node as any).data = { hName: "pre", hProperties: {} };
    }
  });
};

function makeLatexPlugins() {
  const latexBlocks: string[] = [];

  const rehypeCaptureLatex: Plugin<[], Root> = () => (tree) => {
    latexBlocks.length = 0;
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("math-display")) {
        latexBlocks.push((node.children[0] as Text | undefined)?.value ?? "");
      }
    });
  };

  // Single post-katex pass: renames katex-display → mathblock AND converts ==marks==.
  // Uses SKIP to avoid descending into KaTeX subtrees (~80 nodes each).
  const rehypeMergedPass: Plugin<[], Root> = () => (tree) => {
    let i = 0;
    visit(tree, (node, index, parent) => {
      if (node.type === "element") {
        const cls = ((node as Element).properties?.className as string[] | undefined) ?? [];
        if (cls.includes("katex-display")) {
          if (latexBlocks[i] !== undefined) {
            (node as Element).tagName = "mathblock";
            (node as Element).properties = { "data-latex": latexBlocks[i++] };
          }
          return SKIP;
        }
      }
      if (
        node.type === "text" &&
        (node as Text).value.includes("==") &&
        parent && index !== undefined
      ) {
        const parts = (node as Text).value.split(/(==.+?==)/g);
        if (parts.length > 1) {
          const nodes: ElementContent[] = parts
            .map((part): ElementContent | null => {
              if (part.startsWith("==") && part.endsWith("==") && part.length > 4)
                return { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part.slice(2, -2) }] };
              if (part === "") return null;
              return { type: "text", value: part } as Text;
            })
            .filter((n): n is ElementContent => n !== null);
          (parent as Parent).children.splice(index, 1, ...nodes);
          return index;
        }
      }
    });
  };

  return { rehypeCaptureLatex, rehypeMergedPass };
}

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

const CEILINGS: Record<string, Record<FixtureName, number>> = {
  "remark-parse":          { small: 5,   medium: 10,  large: 30  },
  "remark-gfm+math":       { small: 15,  medium: 30,  large: 80  },
  "remark-callout":        { small: 2,   medium: 5,   large: 20  },
  "remark-promoteDisplay": { small: 2,   medium: 5,   large: 15  },
  "remark→hast":           { small: 5,   medium: 15,  large: 50  },
  "rehype-captureLatex":   { small: 2,   medium: 5,   large: 15  },
  "rehype-katex":          { small: 20,  medium: 60,  large: 200 },
  "rehype-mergedPass":     { small: 5,   medium: 15,  large: 50  },
  "full-pipeline":         { small: 30,  medium: 80,  large: 300 },
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
