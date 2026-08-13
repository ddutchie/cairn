/**
 * Cairn — Responses vs Chat Completions protocol benchmark (live).
 *
 * Hits the SAME endpoint + model over BOTH wire protocols — `/v1/responses`
 * (RESPONSES_TRANSPORT) and `/v1/chat/completions` (COMPLETIONS_TRANSPORT) —
 * using the exact production code paths, and reports latency, time-to-first-
 * token, and token usage per protocol so the two can be compared directly.
 *
 * OPT-IN, reusing the repo's live-test convention:
 *
 *   CAIRN_LIVE_TESTS=1 \
 *   TEST_LLM_OCGO_BASE_URL=https://opencode.ai/zen/go/v1 \
 *   TEST_LLM_OCGO_MODEL=deepseek-v4-flash \
 *   TEST_LLM_OCGO_KEY=sk-... \
 *   npx vitest run electron/lib/protocol-benchmark.live.test.ts
 *
 * `TEST_LLM_OCGO_*` are already in `.env.test`. Never gated on a normal run.
 */

import { describe, it, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { COMPLETIONS_TRANSPORT, RESPONSES_TRANSPORT, type LlmTransport } from "./llm-transport";
import { endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import type { OpenAIMessage } from "./llm";

const BASE_URL = (process.env.TEST_LLM_OCGO_BASE_URL || "https://opencode.ai/zen/go/v1").trim().replace(/\/+$/, "");
const MODEL = process.env.TEST_LLM_OCGO_MODEL?.trim() || "deepseek-v4-flash";
const API_KEY = process.env.TEST_LLM_OCGO_KEY?.trim() || "";

const RUNS = 3;

interface Sample {
  latencyMs: number;
  ttftMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

async function runOnce(transport: LlmTransport, messages: OpenAIMessage[]): Promise<Sample> {
  const body = transport.buildBody({ model: MODEL, messages, tools: [], temperature: 0.2, maxTokens: 2048 });
  const t0 = performance.now();
  let ttft: number | undefined;
  const res = await fetch(transport.endpoint(BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);

  const reader = res.body!.getReader();
  let usage: { pt: number; ct: number; rt: number; cacheRead: number } = { pt: 0, ct: 0, rt: 0, cacheRead: 0 };
  await transport.consume(reader, {
    onToken: () => {
      ttft ??= performance.now() - t0;
    },
    onUsage: (u) => {
      usage = { pt: u.promptTokens, ct: u.completionTokens, rt: u.reasoningTokens, cacheRead: u.cacheReadTokens };
    },
  });
  const latencyMs = performance.now() - t0;
  return {
    latencyMs,
    ttftMs: ttft ?? latencyMs,
    promptTokens: usage.pt,
    completionTokens: usage.ct,
    reasoningTokens: usage.rt,
    cacheReadTokens: usage.cacheRead,
  };
}

interface Prompt {
  id: string;
  kind: string;
  system: string;
  user: string;
}

const PROMPTS: Prompt[] = [
  {
    id: "hello", kind: "trivial",
    system: "You are a helpful assistant.",
    user: "Say hello.",
  },
  {
    id: "palindrome", kind: "generation",
    system: "You are a helpful coding assistant.",
    user: "Write a short Python function that checks if a string is a palindrome, with a one-sentence explanation.",
  },
  {
    id: "attention", kind: "reasoning",
    system: "You are a helpful assistant. Explain clearly and accurately.",
    user: "Explain how the self-attention mechanism in a transformer works, step by step.",
  },
];

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe.skipIf(!LIVE_TESTS_ENABLED)("protocol benchmark — Responses vs Completions (live)", () => {
  let up = false;
  beforeAll(async () => {
    up = await endpointUp(BASE_URL, API_KEY);
  });

  it("runs identical prompts over both endpoints and reports the comparison", async () => {
    if (!up) {
      console.log(`[skip] Endpoint unreachable at ${BASE_URL}. Set TEST_LLM_OCGO_* to run.`);
      return;
    }

    const rows: string[] = [];
    const summary: Array<{ proto: string; prompt: string; latency: number; ttft: number; ptok: number; ctok: number; rtok: number; cache: number }> = [];

    const protocols: Array<[name: string, transport: LlmTransport]> = [
      ["responses", RESPONSES_TRANSPORT],
      ["completions", COMPLETIONS_TRANSPORT],
    ];

    // Warm both endpoints once so cold-start (model/proxy spin-up) doesn't bias
    // the first measured run, which would otherwise land on "responses".
    const warmup: OpenAIMessage[] = [{ role: "user", content: "ping" }];
    for (const [, transport] of protocols) {
      await runOnce(transport, warmup);
    }

    let promptIndex = 0;
    for (const prompt of PROMPTS) {
      const messages: OpenAIMessage[] = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];

      // Alternate protocol order per prompt so time-based drift cancels out.
      const ordered = promptIndex % 2 === 0 ? protocols : [...protocols].reverse();
      promptIndex++;

      for (const [name, transport] of ordered) {
        const samples: Sample[] = [];
        for (let r = 0; r < RUNS; r++) {
          const s = await runOnce(transport, messages);
          samples.push(s);
          rows.push([name, prompt.id, s.latencyMs.toFixed(0), s.ttftMs.toFixed(0), s.promptTokens, s.completionTokens, s.reasoningTokens, s.cacheReadTokens].join(","));
        }
        summary.push({
          proto: name,
          prompt: prompt.id,
          latency: mean(samples.map((s) => s.latencyMs)),
          ttft: mean(samples.map((s) => s.ttftMs)),
          ptok: mean(samples.map((s) => s.promptTokens)),
          ctok: mean(samples.map((s) => s.completionTokens)),
          rtok: mean(samples.map((s) => s.reasoningTokens)),
          cache: mean(samples.map((s) => s.cacheReadTokens)),
        });
      }
    }

    // ── Print per-prompt comparison ──
    console.log(`\n=== Responses vs Chat Completions (${MODEL}, n=${RUNS}, means) ===`);
    console.log("prompt          proto         lat(ms)  ttft(ms)  ptok  ctok  rtok  cache");
    for (const prompt of PROMPTS) {
      for (const proto of ["responses", "completions"]) {
        const s = summary.find((x) => x.prompt === prompt.id && x.proto === proto)!;
        console.log(
          `${prompt.id.padEnd(15)} ${proto.padEnd(13)} ${String(Math.round(s.latency)).padStart(7)} ${String(Math.round(s.ttft)).padStart(8)} ${String(Math.round(s.ptok)).padStart(5)} ${String(Math.round(s.ctok)).padStart(5)} ${String(Math.round(s.rtok)).padStart(5)} ${String(Math.round(s.cache)).padStart(5)}`,
        );
      }
    }

    // ── Aggregate totals ──
    const agg = (proto: string) => summary.filter((x) => x.proto === proto);
    for (const proto of ["responses", "completions"]) {
      const a = agg(proto);
      console.log(
        `\nTOTAL ${proto}: lat=${Math.round(mean(a.map((s) => s.latency)))}ms ttft=${Math.round(mean(a.map((s) => s.ttft)))}ms ` +
        `ptok=${Math.round(mean(a.map((s) => s.ptok)))} ctok=${Math.round(mean(a.map((s) => s.ctok)))} rtok=${Math.round(mean(a.map((s) => s.rtok)))} cache=${Math.round(mean(a.map((s) => s.cache)))}`,
      );
    }

    const csv = ["proto,prompt,latencyMs,ttftMs,promptTokens,completionTokens,reasoningTokens,cacheReadTokens", ...rows].join("\n");
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-proto-")), "protocol-benchmark.csv");
    fs.writeFileSync(outPath, csv);
    console.log(`\nCSV written to ${outPath}`);
  }, 600_000);
});
