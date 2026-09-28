#!/usr/bin/env node
/**
 * Benchmark Apple's on-device Foundation Model (macOS 27 `fm serve`) — or any
 * OpenAI-compatible endpoint — on Cairn-shaped workloads.
 *
 * Usage (on a Mac running macOS 27 with Apple Intelligence enabled):
 *   fm serve                                   # terminal 1 (default port 1976)
 *   node scripts/bench-apple-fm.mjs            # terminal 2
 *
 * Options:
 *   --url <base>        OpenAI-compatible base URL   (default http://127.0.0.1:1976/v1)
 *   --model <id>        model id                      (default: first from /models, else "system")
 *   --key <key>         bearer token, if the endpoint needs one
 *   --compare <base>    second endpoint to run the same suite against (e.g. LM Studio / Ollama)
 *   --compare-model <id>
 *   --runs <n>          repetitions per task          (default 3)
 *   --out <file>        also write the markdown report to a file
 *
 * No dependencies — plain Node 18+ fetch. Not part of the test suite.
 */

const args = parseArgs(process.argv.slice(2));
const RUNS = Number(args.runs ?? 3);

const NOTE = `# Q3 planning sync

We agreed the mobile app ships offline sync before the Android beta. Dana owns the
sync conflict resolver and wants a design review by Friday. Sam flagged that the
embeddings server cold start is ~4s on Intel Macs, which makes first search feel
broken; he'll profile it and report back next week. The board view needs a
"blocked" column — Priya will add it and migrate existing cards tagged #blocked.
We also discussed dropping the legacy markdown importer: nobody has used it in
three months, but support wants a deprecation notice first. Budget for the
cloud relay stays flat. Open question: do we let automations write to notes in
other projects? Security wants an approval step if so. Next sync in two weeks.`;

const TASK_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          owner: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["title", "owner", "priority"],
      },
    },
  },
  required: ["tasks"],
};

const CREATE_CARD_TOOL = {
  type: "function",
  function: {
    name: "create_card",
    description: "Create a task card on the project board.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short card title" },
        column: { type: "string", enum: ["Backlog", "In Progress", "Review", "Done"] },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["title", "column"],
    },
  },
};

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_notes",
    description: "Full-text search across the user's notes.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search terms" } },
      required: ["query"],
    },
  },
};

/** Each task returns { ok, detail } from the parsed response. */
const TASKS = [
  {
    id: "chat",
    label: "Short chat reply",
    stream: true,
    body: { messages: [{ role: "user", content: "In two sentences, what is a kanban board good for?" }] },
    check: (r) => ({ ok: r.text.trim().length > 20, detail: `${r.text.trim().split(/\s+/).length} words` }),
  },
  {
    id: "summarize",
    label: "Summarize a note",
    stream: true,
    body: {
      messages: [
        { role: "system", content: "You summarize meeting notes into 3-5 terse bullet points." },
        { role: "user", content: NOTE },
      ],
    },
    check: (r) => {
      const bullets = r.text.split("\n").filter((l) => /^\s*([-*•]|\d+\.)\s/.test(l)).length;
      const hits = ["Dana", "Sam", "Priya"].filter((n) => r.text.includes(n)).length;
      return { ok: bullets >= 3 && hits >= 2, detail: `${bullets} bullets, ${hits}/3 owners named` };
    },
  },
  {
    id: "extract",
    label: "Extract tasks (JSON schema)",
    body: {
      messages: [{ role: "user", content: `Extract every action item from this note.\n\n${NOTE}` }],
      response_format: { type: "json_schema", json_schema: { name: "tasks", schema: TASK_SCHEMA } },
    },
    check: (r) => {
      try {
        const tasks = JSON.parse(r.text).tasks;
        const owners = new Set(tasks.map((t) => t.owner));
        return { ok: Array.isArray(tasks) && tasks.length >= 3, detail: `${tasks.length} tasks, owners: ${[...owners].join(", ")}` };
      } catch (e) {
        return { ok: false, detail: `invalid JSON: ${String(e.message).slice(0, 60)}` };
      }
    },
  },
  {
    id: "tags",
    label: "Suggest tags",
    body: {
      messages: [
        { role: "user", content: `Suggest 3 to 5 lowercase single-word tags for this note. Reply with only a comma-separated list.\n\n${NOTE}` },
      ],
    },
    check: (r) => {
      const tags = r.text.split(",").map((t) => t.trim()).filter(Boolean);
      return { ok: tags.length >= 3 && tags.length <= 6 && tags.every((t) => !/\s/.test(t)), detail: tags.join(", ").slice(0, 70) };
    },
  },
  {
    id: "tool-forced",
    label: "Tool call (tool_choice=required)",
    body: {
      messages: [{ role: "user", content: "Add a high priority card to the backlog: profile embeddings cold start on Intel." }],
      tools: [CREATE_CARD_TOOL, SEARCH_TOOL],
      tool_choice: "required",
    },
    check: checkToolCall("create_card"),
  },
  {
    id: "tool-auto",
    label: "Tool call (tool_choice=auto)",
    body: {
      messages: [{ role: "user", content: "Find my notes about the markdown importer." }],
      tools: [CREATE_CARD_TOOL, SEARCH_TOOL],
      tool_choice: "auto",
    },
    check: checkToolCall("search_notes"),
  },
];

function checkToolCall(expected) {
  return (r) => {
    const call = r.toolCalls[0];
    if (!call) return { ok: false, detail: `no tool_calls (text: ${r.text.trim().slice(0, 50) || "∅"})` };
    let parsed = null;
    try {
      parsed = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      /* reported below */
    }
    const ok = call.function?.name === expected && parsed !== null;
    return { ok, detail: `${call.function?.name}(${(call.function?.arguments ?? "").slice(0, 60)})` };
  };
}

async function main() {
  const targets = [{ url: trimUrl(args.url ?? "http://127.0.0.1:1976/v1"), model: args.model, key: args.key }];
  if (args.compare) targets.push({ url: trimUrl(args.compare), model: args["compare-model"], key: args["compare-key"] ?? args.key });

  const sections = [];
  for (const target of targets) sections.push(await runSuite(target));

  const report = [`# Endpoint benchmark — ${new Date().toISOString()}`, `Runs per task: ${RUNS}`, "", ...sections].join("\n");
  console.log(`\n${report}`);
  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.out, report);
    console.log(`\nWrote ${args.out}`);
  }
}

async function runSuite(target) {
  target.model ??= await firstModel(target).catch(() => null) ?? "system";
  console.error(`\n▶ ${target.url}  model=${target.model}`);

  const rows = [];
  for (const task of TASKS) {
    const results = [];
    for (let i = 0; i < RUNS; i++) {
      process.stderr.write(`  ${task.id} #${i + 1}… `);
      try {
        const r = await request(target, task);
        const verdict = task.check(r);
        results.push({ ...r, ...verdict });
        process.stderr.write(`${verdict.ok ? "ok" : "FAIL"} ${r.totalMs}ms\n`);
      } catch (e) {
        results.push({ ok: false, detail: String(e.message).slice(0, 80), totalMs: NaN });
        process.stderr.write(`ERROR ${e.message}\n`);
      }
    }
    rows.push(summarizeRow(task, results));
  }

  const ctx = await probeContext(target);
  const warm = rows.find((r) => r.id === "chat");

  return [
    `## ${target.url} — \`${target.model}\``,
    "",
    "| Task | Pass | Median latency | TTFT | Output tok/s | Sample |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.label} | ${r.pass}/${RUNS} | ${fmtMs(r.medianMs)} | ${fmtMs(r.ttft)} | ${r.tps ?? "—"} | ${escapeCell(r.sample)} |`),
    "",
    `**Largest prompt accepted:** ~${ctx.okWords} words (${ctx.okTokens ?? "?"} prompt tokens reported)` +
      (ctx.failDetail ? `; failed at ~${ctx.failWords} words: ${escapeCell(ctx.failDetail)}` : ""),
    warm?.tps ? `**Warm streaming speed (chat):** ${warm.tps} tok/s` : "",
    "",
  ].join("\n");
}

async function request(target, task) {
  const body = { model: target.model, temperature: 0, max_tokens: 600, ...task.body, stream: !!task.stream };
  if (task.stream) body.stream_options = { include_usage: true };
  const started = performance.now();
  const res = await fetch(`${target.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  if (!task.stream) {
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    const totalMs = Math.round(performance.now() - started);
    return { text: msg.content ?? "", toolCalls: msg.tool_calls ?? [], usage: json.usage, totalMs, ttftMs: null };
  }

  let text = "";
  let ttftMs = null;
  let usage = null;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      const evt = JSON.parse(data);
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        ttftMs ??= Math.round(performance.now() - started);
        text += delta;
      }
      if (evt.usage) usage = evt.usage;
    }
  }
  return { text, toolCalls: [], usage, totalMs: Math.round(performance.now() - started), ttftMs };
}

/** Grow the prompt until the endpoint refuses, to find the effective context window. */
async function probeContext(target) {
  const filler = NOTE.replace(/\s+/g, " ");
  const fillerWords = filler.split(" ").length;
  let okWords = 0;
  let okTokens = null;
  for (const words of [500, 1500, 2500, 3500, 5000, 6500, 8000, 12000]) {
    const reps = Math.ceil(words / fillerWords);
    const content = `${Array(reps).fill(filler).join("\n\n")}\n\nIn one sentence: who owns the sync conflict resolver?`;
    process.stderr.write(`  context ~${words}w… `);
    try {
      const r = await request(target, { body: { messages: [{ role: "user", content }], max_tokens: 60 } });
      okWords = words;
      okTokens = r.usage?.prompt_tokens ?? okTokens;
      process.stderr.write(`ok (${r.usage?.prompt_tokens ?? "?"} tok, ${r.totalMs}ms)\n`);
    } catch (e) {
      process.stderr.write("refused\n");
      return { okWords, okTokens, failWords: words, failDetail: String(e.message).slice(0, 120) };
    }
  }
  return { okWords, okTokens };
}

function summarizeRow(task, results) {
  const good = results.filter((r) => Number.isFinite(r.totalMs));
  const tpsSamples = good
    .filter((r) => r.usage?.completion_tokens && r.ttftMs != null && r.totalMs > r.ttftMs)
    .map((r) => r.usage.completion_tokens / ((r.totalMs - r.ttftMs) / 1000));
  return {
    id: task.id,
    label: task.label,
    pass: results.filter((r) => r.ok).length,
    medianMs: median(good.map((r) => r.totalMs)),
    ttft: median(good.map((r) => r.ttftMs).filter((v) => v != null)),
    tps: tpsSamples.length ? median(tpsSamples).toFixed(1) : null,
    sample: (results.find((r) => !r.ok) ?? results[0])?.detail ?? "",
  };
}

async function firstModel(target) {
  const res = await fetch(`${target.url}/models`, { signal: AbortSignal.timeout(5000) });
  const json = await res.json();
  return json.data?.[0]?.id ?? null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const trimUrl = (u) => u.replace(/\/+$/, "");
const fmtMs = (ms) => (ms == null || !Number.isFinite(ms) ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
const escapeCell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
