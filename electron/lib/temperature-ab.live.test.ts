/**
 * Temperature A/B benchmark (live, OCGO) — quantifies the effect of the
 * capability-gated temperature change.
 *
 * Compares OLD behaviour (`temperature: 0.3` forced on every request) against
 * NEW behaviour (`temperature` omitted → vendor default) on the same prompts,
 * over the real opencode zen Responses endpoint, plus an explicit `1.0`
 * control (the vendor default for GLM-5.x) to confirm that "omit" really does
 * mean the vendor default and to measure what forcing it explicitly does:
 *
 *   CAIRN_LIVE_TESTS=1 \
 *   TEST_LLM_OCGO_BASE_URL=https://opencode.ai/zen/go/v1 \
 *   TEST_LLM_OCGO_MODEL=glm-5.2 \
 *   TEST_LLM_OCGO_KEY=sk-... \
 *   npx vitest run electron/lib/temperature-ab.live.test.ts
 *
 * Focus models (per the research):
 *   - gpt-5.6-luna  → models.dev `temperature: false` (vendor manages sampling).
 *   - glm-5.2       → `temperature: true` but vendor default is 1.0.
 *   - deepseek-v4-flash → coding model; DeepSeek recommends 0.0 for coding.
 *
 * Each config runs N times per prompt so the *reliability* signal (did the
 * model finish cleanly?) is measured, not just one noisy sample. Reports
 * finish_reason counts (stop / incomplete / length), tool-call success, and
 * mean latency. Never gated on a normal run.
 */

import { describe, it, beforeAll } from "vitest";
import { buildResponsesBody, consumeResponsesStream } from "./responses";
import { endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import type { OpenAIMessage } from "./llm";

const BASE_URL = (process.env.TEST_LLM_OCGO_BASE_URL || "https://opencode.ai/zen/go/v1").trim().replace(/\/+$/, "");
const API_KEY = process.env.TEST_LLM_OCGO_KEY?.trim() || "";

// Restrict the model set via TEST_LLM_OCGO_A_B_MODELS (comma-separated) to
// keep a run short, e.g. just glm-5.2 for a focused three-way comparison.
const FOCUS = (process.env.TEST_LLM_OCGO_A_B_MODELS || "gpt-5.6-luna,glm-5.2,deepseek-v4-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);
const N = 3;

// old:0.3 = legacy forced value; omit = new Auto (field dropped); 1.0 = the
// explicit vendor default for GLM-5.x (control for what "omit" should mean).
const CONFIGS: Array<{ label: string; value: number | undefined }> = [
  { label: "old:0.3", value: 0.3 },
  { label: "new:omit", value: undefined },
  { label: "ctl:1.0", value: 1.0 },
];

const PROMPTS: Array<{ id: string; system: string; user: string }> = [
  {
    id: "coding-json",
    system: "You are a precise coding assistant. Reply with ONLY a JSON object, no prose, no markdown fences.",
    user: 'Implement a function `parseArgs(argv)` that returns {"name":"parseArgs"} — output exactly: {"name":"parseArgs"}',
  },
  {
    id: "toolcall",
    system: "You must use the provided get_weather tool for any weather question.",
    user: "What's the weather in Paris?",
  },
  {
    id: "reasoning",
    system: "You are a helpful assistant. Explain clearly and accurately.",
    user: "In one short paragraph, explain what tail-call optimisation is and why it matters.",
  },
];

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
};

interface Sample {
  status: number;
  retried: boolean;
  finishReason: string | null;
  toolCalls: number;
  latencyMs: number;
}

async function runOnce(model: string, prompt: { system: string; user: string }, temperature: number | undefined): Promise<Sample> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const tools = prompt.id === "toolcall" ? [WEATHER_TOOL] : [];
  const t0 = performance.now();
  const body = buildResponsesBody({ model, messages, tools, maxTokens: 2048, temperature, stream: true });

  let res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  let retried = false;
  if ((res.status === 400 || res.status === 422) && temperature !== undefined) {
    // The chat-loop's minimal retry: strip the optional fields (incl. temperature).
    const stripped = buildResponsesBody({ model, messages, tools, maxTokens: 2048, stream: true, supportsEncryptedReasoning: false, includeTemperature: false });
    res = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(stripped),
    });
    retried = true;
  }

  const status = res.status;
  let finishReason: string | null = null;
  let toolCalls = 0;
  if (res.ok) {
    const turn = await consumeResponsesStream(res.body!.getReader(), {});
    finishReason = turn.finishReason;
    toolCalls = turn.toolCalls.length;
  }
  return { status, retried, finishReason, toolCalls, latencyMs: performance.now() - t0 };
}

interface Agg {
  stop: number;
  incomplete: number;
  length: number;
  httpErr: number;
  retries: number;
  toolCalls: number;
  meanLat: number;
}

function aggregate(samples: Sample[]): Agg {
  const agg: Agg = { stop: 0, incomplete: 0, length: 0, httpErr: 0, retries: 0, toolCalls: 0, meanLat: 0 };
  for (const s of samples) {
    if (s.status !== 200) { agg.httpErr += 1; continue; }
    if (s.finishReason === "stop") agg.stop += 1;
    else if (s.finishReason === "length") agg.length += 1;
    else agg.incomplete += 1; // null or any other → not a clean stop
    if (s.toolCalls > 0) agg.toolCalls += 1;
    if (s.retried) agg.retries += 1;
    agg.meanLat += s.latencyMs;
  }
  agg.meanLat /= samples.length;
  return agg;
}

describe.skipIf(!LIVE_TESTS_ENABLED)("temperature A/B — 0.3 vs omit vs 1.0", () => {
  let up = false;
  beforeAll(async () => {
    up = await endpointUp(BASE_URL, API_KEY);
  });

  it("reports the comparison per model × prompt (N runs each)", async () => {
    if (!up) {
      console.log(`[skip] Endpoint unreachable at ${BASE_URL}. Set TEST_LLM_OCGO_* to run.`);
      return;
    }

    const line = (s: string) => console.log(s);
    line(`\n${"MODEL".padEnd(18)} ${"PROMPT".padEnd(13)} ${"CFG".padEnd(9)} ${"stop".padEnd(5)} ${"incompl".padEnd(8)} ${"len".padEnd(4)} ${"HTTP!".padEnd(6)} ${"retry".padEnd(6)} ${"toolOK".padEnd(7)} ${"meanMs".padEnd(7)}`);
    line("-".repeat(96));

    for (const model of FOCUS) {
      for (const prompt of PROMPTS) {
        const aggs: Array<[string, Agg]> = [];
        for (const cfg of CONFIGS) {
          const samples: Sample[] = [];
          for (let i = 0; i < N; i++) samples.push(await runOnce(model, prompt, cfg.value));
          aggs.push([cfg.label, aggregate(samples)]);
        }
        for (const [label, a] of aggs) {
          const fmt = (a: Agg) =>
            `${String(a.stop).padEnd(5)} ${String(a.incomplete).padEnd(8)} ${String(a.length).padEnd(4)} ${String(a.httpErr).padEnd(6)} ${String(a.retries).padEnd(6)} ${String(a.toolCalls).padEnd(7)} ${a.meanLat.toFixed(0).padEnd(7)}`;
          line(`${model.padEnd(18)} ${prompt.id.padEnd(13)} ${label.padEnd(9)} ${fmt(a)}`);
        }
      }
      line("-".repeat(96));
    }
  }, 300_000);
});
