/**
 * Cairn — Single-agent vs. Subagent chat benchmark
 *
 * Compares two chat architectures on research-heavy "read a lot, then write a
 * synthesis note" tasks:
 *
 *   1. SINGLE  — the real runToolLoop (electron/lib/chat-loop.ts), all ~45 tools,
 *                one context. This is production behaviour.
 *   2. SUBAGENT — runDispatchLoop (electron/lib/chat-subagent-loop.ts): a thin
 *                dispatcher delegating to a read-only research subagent and a
 *                write-only writing subagent, each with a reduced tool array.
 *
 * Two suites:
 *   • "tool-array context cost" — offline, always runs. Measures the per-role
 *     first-message tool-schema token cost (the context reduction the split buys).
 *   • "live end-to-end" — gated on a reachable OpenAI-compatible endpoint. Runs
 *     the task set through both architectures against a real model and logs
 *     tokens / latency / tool-calls / errors to CSV.
 *
 * Endpoint config (reuses the repo's existing live-test convention):
 *   TEST_LLM_BASE_URL   e.g. https://api.openai.com  or  http://localhost:1234/v1
 *   TEST_LLM_MODEL      e.g. gpt-4o-mini
 *   TEST_LLM_API_KEY    (omit for local no-key endpoints)
 *   CAIRN_SKIP_LIVE_TESTS=1  to force-skip the live suite
 *
 * Run:
 *   TEST_LLM_BASE_URL=... TEST_LLM_MODEL=... TEST_LLM_API_KEY=... \
 *     npx vitest run electron/lib/chat-agent-benchmark.test.ts
 */

import { describe, it, beforeEach, expect } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { encode } from "gpt-tokenizer";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote, createColumn, createCard,
  updateNote, updateCard, createTag,
} from "../db/queries";
import { TOOLS, type ChatRequest } from "./tools";
import { BASE_URL, MODEL, API_KEY, endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import { runToolLoop } from "./chat-loop";
import {
  runDispatchLoop, RESEARCH_TOOL_NAMES, WRITE_TOOL_NAMES, type SubagentMetrics,
} from "./chat-subagent-loop";

// ── Endpoint config ─────────────────────────────────────────────────────────

const tok = (s: string) => encode(s).length;

/** Serialise a tool the way the API sees it, for token accounting. */
function toolStr(t: { function: { name: string; description: string; parameters: unknown } }): string {
  return JSON.stringify({
    type: "function",
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
  });
}

function toolArrayTokens(names?: ReadonlySet<string>): number {
  const list = names ? (TOOLS as ReadonlyArray<typeof TOOLS[number]>).filter((t) => names.has(t.function.name)) : TOOLS;
  return list.reduce((sum, t) => sum + tok(toolStr(t)), 0);
}

// ── Seed a representative workspace ───────────────────────────────────────────

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

const WS = "ws-bench";
const PROJ = "proj-bench";
const COL_BACKLOG = "col-backlog";
const COL_TODO = "col-todo";
const COL_DONE = "col-done";

function seed(db: Database.Database) {
  createWorkspace(db, { id: WS, name: "Bench Workspace" });
  createProject(db, { id: PROJ, workspaceId: WS, name: "Cairn", description: "Desktop app", priority: "high", icon: "🪨" });
  createColumn(db, { id: COL_BACKLOG, projectId: PROJ, workspaceId: WS, name: "Backlog", type: "backlog", order: 0 });
  createColumn(db, { id: COL_TODO, projectId: PROJ, workspaceId: WS, name: "Todo", type: "todo", order: 1 });
  createColumn(db, { id: COL_DONE, projectId: PROJ, workspaceId: WS, name: "Done", type: "done", order: 2 });

  createTag(db, { id: "tg-mobile", workspaceId: WS, name: "mobile", color: "#22c55e" });
  createTag(db, { id: "tg-ai", workspaceId: WS, name: "ai", color: "#6366f1" });
  createTag(db, { id: "tg-perf", workspaceId: WS, name: "performance", color: "#ef4444" });

  // A spread of realistic notes so research has something to synthesise.
  const notes: Array<[string, string, string, string[]]> = [
    ["n-sem-search", "Mobile Semantic Search — on-device findings",
      "Explored NLContextualEmbedding on iOS for on-device semantic search over notes. Works on iOS 17+; macOS 14+ shares the API. Latency ~40ms/query on A17. Next: unify with desktop embeddings.", ["tg-mobile", "tg-ai"]],
    ["n-sem-search-2", "Semantic search score floor",
      "Semantic results need a similarity floor to avoid noisy low-score matches. Plumbing (topK) exists; needs real-data tuning, not mechanical. Deferred past v2.5.0.", ["tg-ai"]],
    ["n-release", "v2.5.0 Release Plan",
      "Shipped: tag-assignment tools, semantic task search (review), binary verification. Deferred to v2.6: score floor, chunked code indexing, mobile theme toggle.", ["tg-perf"]],
    ["n-dogfood", "Dogfooding Log v2.5.0",
      "Personas used Cairn to plan the release. Found: list_ready_tasks NOT a bug; indexer missed const/type/interface (FIXED). Net: 1 real bug, 1 false alarm.", []],
    ["n-code-idx", "Code Semantic Search — jina-code PoC",
      "Chunked semantic code indexing with jina-code 768-d embeddings. Query 'how does auth work' returned the right files. Verified. Task to productionise is medium priority.", ["tg-ai", "tg-perf"]],
    ["n-mobile-matrix", "Mobile Feature Matrix",
      "Desktop vs companion parity: chat, board, notes, sync done. Visualization out of companion scope. Semantic search is a mobile strength via on-device embeddings.", ["tg-mobile"]],
    ["n-perf", "Perf notes — payload optimization",
      "Trimmed MCP tool payloads ~10% by stripping JSON-schema noise (pattern/min/max/default). ~500 tok/turn saved. Validated by tool-schema-optimization test.", ["tg-perf"]],
    ["n-misc", "Random idea — voice capture",
      "Idea: voice capture for quick notes on mobile. Low priority, deferred.", []],
  ];
  for (const [id, title, content, tagIds] of notes) {
    createNote(db, { id, projectId: PROJ, workspaceId: WS, title, content, tagIds });
  }
  updateNote(db, "n-sem-search", { linkedNoteIds: ["n-sem-search-2", "n-mobile-matrix"] });

  const cards: Array<[string, string, string, string, string, string[]]> = [
    ["c-unify-sem", COL_BACKLOG, "Unify semantic search on Mac via NLContextualEmbedding", "Follow-up from mobile on-device work. macOS 14+ shares the API.", "low", ["tg-mobile", "tg-ai"]],
    ["c-score-floor", COL_BACKLOG, "Semantic search score floor", "Deferred past v2.5.0 — needs real-data tuning.", "low", ["tg-ai"]],
    ["c-code-idx", COL_TODO, "Chunked semantic code indexing (jina-code, 768-d)", "PoC verified. Productionise.", "medium", ["tg-ai", "tg-perf"]],
    ["c-reasoning", COL_TODO, "Handle reasoning models in local-llm", "Content fallback + higher max_tokens from benchmark.", "medium", ["tg-ai"]],
    ["c-shipped", COL_DONE, "Semantic task search (desktop + mobile)", "Shipped in v2.5.0 review.", "medium", ["tg-ai"]],
  ];
  for (const [id, columnId, title, description, priority, tagIds] of cards) {
    createCard(db, { id, columnId, projectId: PROJ, workspaceId: WS, title, description, priority: priority as "low" | "medium" | "high" | "urgent", tagIds });
  }
  updateCard(db, "c-unify-sem", { linkedNoteIds: ["n-sem-search"] });
}

// ── Benchmark task set ────────────────────────────────────────────────────────

interface BenchTask {
  id: string;
  prompt: string;
  /** Category, for reading the crossover in results. */
  kind: "research+write" | "research" | "write" | "trivial";
}

const TASKS: BenchTask[] = [
  {
    id: "T1", kind: "research+write",
    prompt: "Read the notes and open tasks in this project, identify the main themes, and write a new note titled 'Themes Synthesis' capturing them.",
  },
  {
    id: "T2", kind: "research",
    prompt: "Find everything related to mobile semantic search across notes and tasks, and summarise the current status in your reply (do not write a note).",
  },
  {
    id: "T3", kind: "research+write",
    prompt: "Compare what shipped vs what was deferred for v2.5.0 based on the notes, and write a note 'v2.5.0 Shipped vs Deferred'.",
  },
  {
    id: "T5", kind: "trivial",
    prompt: "Create a task titled 'Write release notes for v2.6' in the Backlog.",
  },
];

// ── Metric accumulation for the single-agent path ─────────────────────────────

interface RunRecord {
  arch: "single" | "subagent";
  taskId: string;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  toolCalls: number;
  toolErrors: number;
  subagentRuns: number;
  finalChars: number;
}

function baseReq(prompt: string): ChatRequest {
  return {
    message: prompt,
    threadId: "bench-thread",
    workspaceId: WS,
    projectId: PROJ,
    config: { maxSteps: 20, temperature: 0.2 },
  };
}

async function runSingle(db: Database.Database, wp: string, task: BenchTask): Promise<RunRecord> {
  const req = baseReq(task.prompt);
  const messages = [
    { role: "system" as const, content: "" }, // filled below via buildSystemPrompt-equivalent
    { role: "user" as const, content: task.prompt },
  ];
  // Use the real system prompt.
  const { buildSystemPrompt } = await import("./tools");
  messages[0].content = buildSystemPrompt(req);

  let promptTokens = 0, completionTokens = 0, reasoningTokens = 0, toolCalls = 0, toolErrors = 0;
  const t0 = Date.now();
  const result = await runToolLoop(
    db, req, wp, BASE_URL, MODEL, API_KEY, messages,
    () => { toolCalls += 1; },
    undefined, undefined, "openai",
    (pt, ct, rt) => { promptTokens += pt; completionTokens += ct; if (rt) reasoningTokens += rt; },
    (e) => { if (e.output) { try { if (JSON.parse(e.output)?.error) toolErrors += 1; } catch { /* ignore */ } } },
  );
  const latencyMs = Date.now() - t0;

  return {
    arch: "single", taskId: task.id, kind: task.kind,
    promptTokens, completionTokens, reasoningTokens, latencyMs,
    toolCalls, toolErrors, subagentRuns: 0,
    finalChars: result.content.length,
  };
}

async function runSub(db: Database.Database, wp: string, task: BenchTask): Promise<RunRecord> {
  const req = baseReq(task.prompt);
  const t0 = Date.now();
  const { content, metrics }: { content: string; metrics: SubagentMetrics } =
    await runDispatchLoop(db, req, wp, { baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY, provider: "openai" });
  const latencyMs = Date.now() - t0;
  return {
    arch: "subagent", taskId: task.id, kind: task.kind,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    reasoningTokens: metrics.reasoningTokens,
    latencyMs,
    toolCalls: metrics.toolCalls,
    toolErrors: metrics.toolErrors,
    subagentRuns: metrics.subagentRuns,
    finalChars: content.length,
  };
}

function toCsv(rows: RunRecord[]): string {
  const header = "arch,task,kind,promptTok,completionTok,reasoningTok,latencyMs,toolCalls,toolErrors,subagentRuns,finalChars";
  const lines = rows.map((r) =>
    [r.arch, r.taskId, r.kind, r.promptTokens, r.completionTokens, r.reasoningTokens, r.latencyMs, r.toolCalls, r.toolErrors, r.subagentRuns, r.finalChars].join(","));
  return [header, ...lines].join("\n");
}

// ── Suite 1: offline tool-array context cost ─────────────────────────────────

describe("chat agent benchmark — tool-array context cost (offline)", () => {
  it("measures the per-role first-message tool-schema token cost", () => {
    const single = toolArrayTokens();                 // all built-in tools
    const research = toolArrayTokens(RESEARCH_TOOL_NAMES);
    const write = toolArrayTokens(WRITE_TOOL_NAMES);
    // Dispatcher advertises only 2 synthetic tools (~120 tok); approximate here.
    const dispatch = 130;

    const rows = [
      "role,tools,firstMsgToolTokens",
      `single-agent,${TOOLS.length},${single}`,
      `research-subagent,${RESEARCH_TOOL_NAMES.size},${research}`,
      `write-subagent,${WRITE_TOOL_NAMES.size},${write}`,
      `dispatcher,2,${dispatch}`,
    ];
     
    console.log("\n=== Tool-array context cost (tokens sent EVERY turn) ===\n" + rows.join("\n"));

    const worstSubagentTurn = Math.max(research, write, dispatch);
     
    console.log(
      `\nSingle-agent pays ${single} tok/turn for tools.` +
      `\nWorst subagent turn pays ${worstSubagentTurn} tok/turn (${Math.round((1 - worstSubagentTurn / single) * 100)}% less).`,
    );

    // Sanity: each restricted set must be strictly smaller than the full array.
    expect(research).toBeLessThan(single);
    expect(write).toBeLessThan(single);
    expect(worstSubagentTurn).toBeLessThan(single);
  });
});

// ── Suite 2: live end-to-end benchmark ───────────────────────────────────────

describe.skipIf(!LIVE_TESTS_ENABLED)("chat agent benchmark — live end-to-end", () => {
  let up = false;
  beforeEach(async () => { up = await endpointUp(); });

  it("runs the task set through both architectures and logs CSV", async () => {
    if (!up) {
       
      console.log(`[skip] No LLM endpoint reachable at ${BASE_URL}. Set TEST_LLM_BASE_URL/MODEL/API_KEY to run the live benchmark.`);
      return;
    }

    const rows: RunRecord[] = [];
    const wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-bench-"));

    for (const task of TASKS) {
      // Fresh DB per architecture per task so writes from one don't bias the other.
      for (const arch of ["single", "subagent"] as const) {
        const db = makeDb();
        seed(db);
        try {
          const rec = arch === "single" ? await runSingle(db, wp, task) : await runSub(db, wp, task);
          rows.push(rec);
           
          console.log(
            `${arch.padEnd(9)} ${task.id}  ptok=${String(rec.promptTokens).padStart(6)}  ` +
            `ctok=${String(rec.completionTokens).padStart(5)}  ${String(rec.latencyMs).padStart(6)}ms  ` +
            `calls=${rec.toolCalls}  err=${rec.toolErrors}  subs=${rec.subagentRuns}  out=${rec.finalChars}c`,
          );
        } finally {
          db.close();
        }
      }
    }

    const csv = toCsv(rows);
    const outPath = path.join(wp, "chat-agent-benchmark.csv");
    fs.writeFileSync(outPath, csv);
     
    console.log("\n=== CSV ===\n" + csv + "\n\nWritten to: " + outPath);

    // Aggregate: per-arch totals.
    for (const arch of ["single", "subagent"] as const) {
      const a = rows.filter((r) => r.arch === arch);
      const sum = (f: (r: RunRecord) => number) => a.reduce((s, r) => s + f(r), 0);
       
      console.log(
        `TOTAL ${arch.padEnd(9)} ptok=${sum((r) => r.promptTokens)} ctok=${sum((r) => r.completionTokens)} ` +
        `latency=${sum((r) => r.latencyMs)}ms calls=${sum((r) => r.toolCalls)} errors=${sum((r) => r.toolErrors)}`,
      );
    }

    expect(rows.length).toBe(TASKS.length * 2);
  }, 600_000);
});
