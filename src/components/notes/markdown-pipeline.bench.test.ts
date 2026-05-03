/**
 * Markdown pipeline performance benchmarks
 *
 * Measures each stage of the note-editor rendering pipeline in isolation
 * and end-to-end, across small / medium / large fixtures.
 *
 * Runs as part of the normal test suite (`npm test`). Each benchmark
 * reports mean ± stddev and a p95 latency. Tests fail only if a stage
 * regresses beyond a generous ceiling defined per fixture size — the
 * ceilings are intentionally loose (10–20× expected) so they catch
 * catastrophic regressions without being flaky on slow CI machines.
 *
 * To read the numbers without running the full suite:
 *   npx vitest run src/components/notes/markdown-pipeline.bench.test.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import { visit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root, Element, Text } from "hast";
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

// ── Pipeline stages (mirrors note-editor.tsx) ─────────────────────────────────

/** Stage 1 — remark-parse: markdown string → mdast */
const parserBase = unified().use(remarkParse);

/** Stage 2 — remark-gfm + remark-math transforms on the mdast */
const parserFull = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath);

/** remarkCallout — mirrors the plugin in note-editor.tsx */
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

/** remarkPromoteDisplayMath — mirrors the plugin in note-editor.tsx */
const remarkPromoteDisplayMath = () => (tree: MdastRoot) => {
  visit(tree, "paragraph", (node: Paragraph) => {
    if (node.children.length === 1 && node.children[0].type === "inlineMath") {
      const inlineMath = node.children[0] as InlineMath;
      inlineMath.data = {
        ...inlineMath.data,
        hName: "code",
        hProperties: { className: ["language-math", "math-display"] },
      };
      (node as any).data = { hName: "pre", hProperties: {} };
    }
  });
};

/** rehypeHighlight — mirrors the plugin in note-editor.tsx */
const rehypeHighlight: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent: any) => {
    if (!parent || index === undefined) return;
    if (!node.value.includes("==")) return;
    const parts = node.value.split(/(==.+?==)/g);
    if (parts.length === 1) return;
    const nodes = parts
      .map((part): any => {
        if (part.startsWith("==") && part.endsWith("==") && part.length > 4)
          return { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part.slice(2, -2) }] };
        if (part === "") return null;
        return { type: "text", value: part };
      })
      .filter(Boolean);
    parent.children.splice(index, 1, ...nodes);
  });
};

/** makeLatexPlugins — mirrors note-editor.tsx */
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
  const rehypeTagLatex: Plugin<[], Root> = () => (tree) => {
    let i = 0;
    visit(tree, "element", (node: Element) => {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      if (cls.includes("katex-display") && latexBlocks[i] !== undefined) {
        node.tagName = "mathblock";
        node.properties = { "data-latex": latexBlocks[i++] };
      }
    });
  };
  return { rehypeCaptureLatex, rehypeTagLatex };
}

// ── Benchmark harness ─────────────────────────────────────────────────────────

interface BenchResult {
  mean: number;   // ms
  stddev: number; // ms
  p95: number;    // ms
  min: number;
  max: number;
  iterations: number;
}

function bench(fn: () => void, iterations = 100): BenchResult {
  // Warmup — not measured
  for (let i = 0; i < Math.min(10, iterations); i++) fn();

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
// Values are ~20× the expected cost on a modern laptop so CI machines pass
// comfortably while runaway regressions (e.g. quadratic algorithms) are caught.

const CEILINGS: Record<string, Record<FixtureName, number>> = {
  "remark-parse":           { small: 5,   medium: 10,  large: 30  },
  "remark-gfm+math":        { small: 5,   medium: 15,  large: 50  },
  "remark-callout":         { small: 2,   medium: 5,   large: 20  },
  "remark-promoteDisplay":  { small: 2,   medium: 5,   large: 15  },
  "remark→hast":            { small: 5,   medium: 15,  large: 50  },
  "rehype-captureLatex":    { small: 2,   medium: 5,   large: 15  },
  "rehype-katex":           { small: 20,  medium: 60,  large: 200 },
  "rehype-tagLatex":        { small: 2,   medium: 5,   large: 15  },
  "rehype-highlight":       { small: 2,   medium: 5,   large: 15  },
  "full-pipeline":          { small: 30,  medium: 80,  large: 300 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Markdown pipeline benchmarks", () => {
  for (const fixtureName of ["small", "medium", "large"] as FixtureName[]) {
    const md = fixtures[fixtureName];

    describe(`fixture: ${fixtureName} (${md.length} chars)`, () => {

      // ── Stage 1: parse only ──────────────────────────────────────────────
      it("remark-parse: string → mdast", () => {
        const r = bench(() => parserBase.parse(md));
        console.log(`  [${fixtureName}] remark-parse         ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-parse"][fixtureName]);
      });

      // ── Stage 2: parse + GFM + math transforms ───────────────────────────
      it("remark-gfm + remark-math transforms", () => {
        const r = bench(() => parserFull.parse(md));
        console.log(`  [${fixtureName}] remark-gfm+math      ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-gfm+math"][fixtureName]);
      });

      // ── Stage 3: remarkCallout on pre-parsed mdast ───────────────────────
      it("remarkCallout plugin", () => {
        const tree = parserFull.parse(md);
        const transformer = (remarkCallout as any)();
        const r = bench(() => transformer(structuredClone(tree)));
        console.log(`  [${fixtureName}] remark-callout       ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-callout"][fixtureName]);
      });

      // ── Stage 4: remarkPromoteDisplayMath on pre-parsed mdast ────────────
      it("remarkPromoteDisplayMath plugin", () => {
        const tree = parserFull.parse(md);
        const transformer = (remarkPromoteDisplayMath as any)();
        const r = bench(() => transformer(structuredClone(tree)));
        console.log(`  [${fixtureName}] remark-promoteDisplay ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark-promoteDisplay"][fixtureName]);
      });

      // ── Stage 5: remark-rehype (mdast → hast) ───────────────────────────
      it("remark-rehype: mdast → hast", () => {
        const toHast = unified().use(remarkRehype);
        const mdast  = unified()
          .use(remarkParse).use(remarkGfm).use(remarkMath)
          .use(remarkCallout).use(remarkPromoteDisplayMath)
          .parse(md);

        const r = bench(() => toHast.runSync(structuredClone(mdast) as any));
        console.log(`  [${fixtureName}] remark→hast          ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["remark→hast"][fixtureName]);
      });

      // ── Stage 6–8: rehype plugins individually ───────────────────────────
      it("rehypeCaptureLatex plugin", () => {
        const { rehypeCaptureLatex } = makeLatexPlugins();
        const hast = unified()
          .use(remarkParse).use(remarkGfm).use(remarkMath)
          .use(remarkCallout).use(remarkPromoteDisplayMath)
          .use(remarkRehype)
          .runSync(unified()
            .use(remarkParse).use(remarkGfm).use(remarkMath)
            .use(remarkCallout).use(remarkPromoteDisplayMath)
            .parse(md));

        const transformer = (rehypeCaptureLatex as any)();
        const r = bench(() => transformer(structuredClone(hast)));
        console.log(`  [${fixtureName}] rehype-captureLatex  ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-captureLatex"][fixtureName]);
      });

      it("rehype-katex: render LaTeX → HTML", () => {
        const { rehypeCaptureLatex } = makeLatexPlugins();
        const rehypeKatexProcessor = unified().use(rehypeKatex);
        const hast = unified()
          .use(remarkParse).use(remarkGfm).use(remarkMath)
          .use(remarkCallout).use(remarkPromoteDisplayMath)
          .use(remarkRehype).use(rehypeCaptureLatex as any)
          .runSync(unified()
            .use(remarkParse).use(remarkGfm).use(remarkMath)
            .use(remarkCallout).use(remarkPromoteDisplayMath)
            .parse(md));

        const r = bench(() => rehypeKatexProcessor.runSync(structuredClone(hast) as any), 50);
        console.log(`  [${fixtureName}] rehype-katex         ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-katex"][fixtureName]);
      });

      it("rehypeTagLatex plugin", () => {
        const { rehypeCaptureLatex, rehypeTagLatex } = makeLatexPlugins();
        const hast = unified()
          .use(remarkParse).use(remarkGfm).use(remarkMath)
          .use(remarkCallout).use(remarkPromoteDisplayMath)
          .use(remarkRehype).use(rehypeCaptureLatex as any).use(rehypeKatex)
          .runSync(unified()
            .use(remarkParse).use(remarkGfm).use(remarkMath)
            .use(remarkCallout).use(remarkPromoteDisplayMath)
            .parse(md));

        const transformer = (rehypeTagLatex as any)();
        const r = bench(() => transformer(structuredClone(hast)));
        console.log(`  [${fixtureName}] rehype-tagLatex      ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-tagLatex"][fixtureName]);
      });

      it("rehypeHighlight: ==marks== → <mark>", () => {
        const { rehypeCaptureLatex, rehypeTagLatex } = makeLatexPlugins();
        const hast = unified()
          .use(remarkParse).use(remarkGfm).use(remarkMath)
          .use(remarkCallout).use(remarkPromoteDisplayMath)
          .use(remarkRehype).use(rehypeCaptureLatex as any)
          .use(rehypeKatex).use(rehypeTagLatex as any)
          .runSync(unified()
            .use(remarkParse).use(remarkGfm).use(remarkMath)
            .use(remarkCallout).use(remarkPromoteDisplayMath)
            .parse(md));

        const transformer = (rehypeHighlight as any)();
        const r = bench(() => transformer(structuredClone(hast)));
        console.log(`  [${fixtureName}] rehype-highlight     ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["rehype-highlight"][fixtureName]);
      });

      // ── Full pipeline ────────────────────────────────────────────────────
      it("full pipeline: string → final hast", () => {
        const { rehypeCaptureLatex, rehypeTagLatex } = makeLatexPlugins();

        const processor = unified()
          .use(remarkParse)
          .use(remarkGfm)
          .use(remarkMath)
          .use(remarkCallout)
          .use(remarkPromoteDisplayMath)
          .use(remarkRehype)
          .use(rehypeCaptureLatex as any)
          .use(rehypeKatex)
          .use(rehypeTagLatex as any)
          .use(rehypeHighlight);

        const r = bench(() => processor.runSync(processor.parse(md)), 50);
        console.log(`  [${fixtureName}] FULL PIPELINE        ${fmt(r)}`);
        expect(r.p95).toBeLessThan(CEILINGS["full-pipeline"][fixtureName]);
      });
    });
  }
});
