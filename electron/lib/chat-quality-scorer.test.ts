/**
 * Cairn — Output-quality scorer (LLM-as-judge) for single vs. subagent chat
 *
 * The token/latency harness (chat-agent-benchmark.test.ts) measures cost. This
 * one measures QUALITY of the actual deliverable — the note/task artifacts
 * written to the DB plus the final chat reply — scored against the 5-point
 * rubric from the experiment note by an LLM judge.
 *
 * Rubric (each 1–5):
 *   R1 task_completion  — did it produce the asked-for artifact (note/task)?
 *   R2 theme_coverage   — captures the actual themes present in the source corpus?
 *   R3 faithfulness     — no hallucinated notes/tasks/ids/claims?
 *   R4 structure        — concise, well-structured markdown?
 *   R5 actionability    — links/tags/next-steps where appropriate?
 *
 * The judge SHOULD be a strong model even if the agent runs on a weak one, so
 * the score reflects quality, not the judge's own limits. Override with
 * JUDGE_BASE_URL / JUDGE_MODEL / JUDGE_API_KEY; otherwise falls back to the
 * TEST_LLM_* endpoint used to run the agents.
 *
 * Run:
 *   TEST_LLM_BASE_URL=... TEST_LLM_MODEL=... TEST_LLM_API_KEY=... \
 *   [JUDGE_MODEL=... JUDGE_BASE_URL=... JUDGE_API_KEY=...] \
 *     npx vitest run --project node electron/lib/chat-quality-scorer.test.ts
 */

import { describe, it, beforeEach, expect } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createColumn, createNote, createCard,
  updateNote, updateCard, createTag, getFullSnapshot,
} from "../db/queries";
import { buildSystemPrompt, type ChatRequest } from "./tools";
import { normaliseBaseUrl, buildApiUrl } from "./llm";
import { BASE_URL, MODEL, API_KEY, endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import { runToolLoop } from "./chat-loop";
import { runDispatchLoop } from "./chat-subagent-loop";

// Judge endpoint — defaults to the agent endpoint if not overridden.
const JUDGE_BASE_URL = normaliseBaseUrl(process.env.JUDGE_BASE_URL?.trim() || BASE_URL);
const JUDGE_MODEL = process.env.JUDGE_MODEL?.trim() || MODEL;
const JUDGE_API_KEY = process.env.JUDGE_API_KEY?.trim() || API_KEY;

// ── Seed (same corpus as chat-agent-benchmark) ────────────────────────────────

const WS = "ws-q";
const PROJ = "proj-q";
const COL_BACKLOG = "col-b";
const COL_TODO = "col-t";
const COL_DONE = "col-d";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

/** The ground-truth source corpus, also handed to the judge for theme/faithfulness checks. */
const SOURCE_NOTES: Array<{ id: string; title: string; content: string; tagIds: string[] }> = [
  { id: "n-sem-search", title: "Mobile Semantic Search — on-device findings", tagIds: ["tg-mobile", "tg-ai"],
    content: "Explored NLContextualEmbedding on iOS for on-device semantic search over notes. Works on iOS 17+; macOS 14+ shares the API. Latency ~40ms/query on A17. Next: unify with desktop embeddings." },
  { id: "n-sem-search-2", title: "Semantic search score floor", tagIds: ["tg-ai"],
    content: "Semantic results need a similarity floor to avoid noisy low-score matches. Plumbing (topK) exists; needs real-data tuning, not mechanical. Deferred past v2.5.0." },
  { id: "n-release", title: "v2.5.0 Release Plan", tagIds: ["tg-perf"],
    content: "Shipped: tag-assignment tools, semantic task search (review), binary verification. Deferred to v2.6: score floor, chunked code indexing, mobile theme toggle." },
  { id: "n-dogfood", title: "Dogfooding Log v2.5.0", tagIds: [],
    content: "Personas used Cairn to plan the release. Found: list_ready_tasks NOT a bug; indexer missed const/type/interface (FIXED). Net: 1 real bug, 1 false alarm." },
  { id: "n-code-idx", title: "Code Semantic Search — jina-code PoC", tagIds: ["tg-ai", "tg-perf"],
    content: "Chunked semantic code indexing with jina-code 768-d embeddings. Query 'how does auth work' returned the right files. Verified. Task to productionise is medium priority." },
  { id: "n-mobile-matrix", title: "Mobile Feature Matrix", tagIds: ["tg-mobile"],
    content: "Desktop vs companion parity: chat, board, notes, sync done. Visualization out of companion scope. Semantic search is a mobile strength via on-device embeddings." },
  { id: "n-perf", title: "Perf notes — payload optimization", tagIds: ["tg-perf"],
    content: "Trimmed MCP tool payloads ~10% by stripping JSON-schema noise (pattern/min/max/default). ~500 tok/turn saved. Validated by tool-schema-optimization test." },
  { id: "n-misc", title: "Random idea — voice capture", tagIds: [],
    content: "Idea: voice capture for quick notes on mobile. Low priority, deferred." },
];

const SOURCE_CARDS: Array<{ id: string; col: string; title: string; description: string; priority: string; tagIds: string[] }> = [
  { id: "c-unify-sem", col: COL_BACKLOG, title: "Unify semantic search on Mac via NLContextualEmbedding", description: "Follow-up from mobile on-device work. macOS 14+ shares the API.", priority: "low", tagIds: ["tg-mobile", "tg-ai"] },
  { id: "c-score-floor", col: COL_BACKLOG, title: "Semantic search score floor", description: "Deferred past v2.5.0 — needs real-data tuning.", priority: "low", tagIds: ["tg-ai"] },
  { id: "c-code-idx", col: COL_TODO, title: "Chunked semantic code indexing (jina-code, 768-d)", description: "PoC verified. Productionise.", priority: "medium", tagIds: ["tg-ai", "tg-perf"] },
  { id: "c-reasoning", col: COL_TODO, title: "Handle reasoning models in local-llm", description: "Content fallback + higher max_tokens from benchmark.", priority: "medium", tagIds: ["tg-ai"] },
  { id: "c-shipped", col: COL_DONE, title: "Semantic task search (desktop + mobile)", description: "Shipped in v2.5.0 review.", priority: "medium", tagIds: ["tg-ai"] },
];

function seed(db: Database.Database) {
  createWorkspace(db, { id: WS, name: "Quality WS" });
  createProject(db, { id: PROJ, workspaceId: WS, name: "Cairn", description: "Desktop app", priority: "high", icon: "🪨" });
  createColumn(db, { id: COL_BACKLOG, projectId: PROJ, workspaceId: WS, name: "Backlog", type: "backlog", order: 0 });
  createColumn(db, { id: COL_TODO, projectId: PROJ, workspaceId: WS, name: "Todo", type: "todo", order: 1 });
  createColumn(db, { id: COL_DONE, projectId: PROJ, workspaceId: WS, name: "Done", type: "done", order: 2 });
  createTag(db, { id: "tg-mobile", workspaceId: WS, name: "mobile", color: "#22c55e" });
  createTag(db, { id: "tg-ai", workspaceId: WS, name: "ai", color: "#6366f1" });
  createTag(db, { id: "tg-perf", workspaceId: WS, name: "performance", color: "#ef4444" });
  for (const n of SOURCE_NOTES) createNote(db, { id: n.id, projectId: PROJ, workspaceId: WS, title: n.title, content: n.content, tagIds: n.tagIds });
  updateNote(db, "n-sem-search", { linkedNoteIds: ["n-sem-search-2", "n-mobile-matrix"] });
  for (const c of SOURCE_CARDS) createCard(db, { id: c.id, columnId: c.col, projectId: PROJ, workspaceId: WS, title: c.title, description: c.description, priority: c.priority as "low" | "medium" | "high" | "urgent", tagIds: c.tagIds });
  updateCard(db, "c-unify-sem", { linkedNoteIds: ["n-sem-search"] });
}

// ── Tasks (subset of the benchmark that produces a note deliverable) ──────────

interface QTask { id: string; prompt: string; }
const TASKS: QTask[] = [
  { id: "T1", prompt: "Read the notes and open tasks in this project, identify the main themes, and write a new note titled 'Themes Synthesis' capturing them." },
  { id: "T2", prompt: "Find everything related to mobile semantic search across notes and tasks, and write a note 'Mobile Semantic Search — Status' summarising the current state, what's shipped, and what's deferred." },
  { id: "T3", prompt: "Compare what shipped vs what was deferred for v2.5.0 based on the notes, and write a note 'v2.5.0 Shipped vs Deferred'." },
];

// ── Artifact capture: diff snapshot before/after a run ────────────────────────

interface Artifact { notes: Array<{ id: string; title: string; content: string }>; cards: Array<{ id: string; title: string }>; }

function captureNew(db: Database.Database, beforeNoteIds: Set<string>, beforeCardIds: Set<string>): Artifact {
  const snap = getFullSnapshot(db);
  const notes = snap.notes
    .filter((n) => !beforeNoteIds.has(n.id as string))
    .map((n) => ({ id: n.id as string, title: n.title as string, content: (n.content as string) ?? "" }));
  const cards = snap.cards
    .filter((c) => !beforeCardIds.has(c.id as string))
    .map((c) => ({ id: c.id as string, title: c.title as string }));
  return { notes, cards };
}

// ── The judge ─────────────────────────────────────────────────────────────────

interface RubricScore { task_completion: number; theme_coverage: number; faithfulness: number; structure: number; actionability: number; comment: string; }

const CRITERIA: (keyof Omit<RubricScore, "comment">)[] = ["task_completion", "theme_coverage", "faithfulness", "structure", "actionability"];

function sourceCorpusText(): string {
  const notes = SOURCE_NOTES.map((n) => `- [${n.id}] "${n.title}": ${n.content}`).join("\n");
  const cards = SOURCE_CARDS.map((c) => `- [${c.id}] "${c.title}" (${c.priority}, ${c.col}): ${c.description}`).join("\n");
  return `NOTES:\n${notes}\n\nTASKS:\n${cards}`;
}

async function judge(task: QTask, finalReply: string, artifact: Artifact): Promise<RubricScore> {
  const deliverable = artifact.notes.length
    ? artifact.notes.map((n) => `### Note "${n.title}"\n${n.content}`).join("\n\n")
    : "(no note was created)";
  const createdCards = artifact.cards.length ? artifact.cards.map((c) => `- ${c.title}`).join("\n") : "(none)";

  const system =
    "You are a strict, fair evaluator of an AI assistant's output inside a note-taking app. " +
    "Score ONLY against the rubric and the provided source corpus. Penalise hallucinated facts/ids not grounded in the corpus. " +
    "Return ONLY a JSON object, no prose.";

  const user =
`SOURCE CORPUS (ground truth the assistant had access to):
${sourceCorpusText()}

USER REQUEST:
${task.prompt}

ASSISTANT FINAL REPLY:
${finalReply || "(empty)"}

DELIVERABLE ARTIFACT (note written to the workspace):
${deliverable}

CARDS CREATED: ${createdCards}

Score each criterion 1–5 (5 best):
- task_completion: produced the asked-for artifact (a note) with a sensible title/content.
- theme_coverage: captures the actual themes present in the source corpus (mobile semantic search, code indexing, perf/payload, release shipped/deferred, dogfooding).
- faithfulness: no hallucinated notes/tasks/ids/claims absent from the corpus.
- structure: concise, well-structured markdown (headings/lists as appropriate).
- actionability: surfaces next steps / shipped-vs-deferred / links where the request implies it.

Return JSON exactly like:
{"task_completion":N,"theme_coverage":N,"faithfulness":N,"structure":N,"actionability":N,"comment":"one sentence"}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (JUDGE_API_KEY) headers["Authorization"] = `Bearer ${JUDGE_API_KEY}`;

  const res = await fetch(buildApiUrl(JUDGE_BASE_URL, "chat/completions"), {
    method: "POST", headers,
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 700, temperature: 0, stream: false,
    }),
  });
  if (!res.ok) throw new Error(`judge error ${res.status}: ${await res.text().catch(() => "")}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any;
  let text: string = data.choices?.[0]?.message?.content ?? "";
  // Strip code fences / extract the JSON object.
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : text) as RubricScore;
  // Clamp to 1–5.
  for (const c of CRITERIA) parsed[c] = Math.max(1, Math.min(5, Math.round(Number(parsed[c]) || 1)));
  return parsed;
}

// ── Run one task under one architecture, capturing the artifact + reply ───────

function baseReq(prompt: string): ChatRequest {
  return { message: prompt, threadId: "q-thread", workspaceId: WS, projectId: PROJ, config: { maxSteps: 20, temperature: 0.2 } };
}

async function runSingle(db: Database.Database, wp: string, task: QTask): Promise<{ reply: string; artifact: Artifact }> {
  const before = getFullSnapshot(db);
  const beforeNotes = new Set(before.notes.map((n) => n.id as string));
  const beforeCards = new Set(before.cards.map((c) => c.id as string));
  const req = baseReq(task.prompt);
  const messages = [{ role: "system" as const, content: buildSystemPrompt(req) }, { role: "user" as const, content: task.prompt }];
  const r = await runToolLoop(db, req, wp, BASE_URL, MODEL, API_KEY, messages, () => {}, undefined, undefined, "openai");
  return { reply: r.content, artifact: captureNew(db, beforeNotes, beforeCards) };
}

async function runSub(db: Database.Database, wp: string, task: QTask): Promise<{ reply: string; artifact: Artifact }> {
  const before = getFullSnapshot(db);
  const beforeNotes = new Set(before.notes.map((n) => n.id as string));
  const beforeCards = new Set(before.cards.map((c) => c.id as string));
  const req = baseReq(task.prompt);
  const r = await runDispatchLoop(db, req, wp, { baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY, provider: "openai" });
  return { reply: r.content, artifact: captureNew(db, beforeNotes, beforeCards) };
}

interface ScoreRow { arch: string; task: string; s: RubricScore; total: number; noteChars: number; }

describe.skipIf(!LIVE_TESTS_ENABLED)("chat output-quality scorer (LLM-as-judge, live)", () => {
  let up = false;
  beforeEach(async () => { up = (await endpointUp(BASE_URL, API_KEY)) && (await endpointUp(JUDGE_BASE_URL, JUDGE_API_KEY)); });

  it("scores single vs subagent deliverables against the rubric", async () => {
    if (!up) {
       
      console.log(`[skip] agent endpoint ${BASE_URL} or judge ${JUDGE_BASE_URL} unreachable.`);
      return;
    }
     
    console.log(`Agent: ${MODEL} @ ${BASE_URL}   Judge: ${JUDGE_MODEL} @ ${JUDGE_BASE_URL}`);

    const wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-quality-"));
    const rows: ScoreRow[] = [];

    for (const task of TASKS) {
      for (const arch of ["single", "subagent"] as const) {
        const db = makeDb(); seed(db);
        try {
          const { reply, artifact } = arch === "single" ? await runSingle(db, wp, task) : await runSub(db, wp, task);
          const s = await judge(task, reply, artifact);
          const total = CRITERIA.reduce((sum, c) => sum + s[c], 0);
          const noteChars = artifact.notes.reduce((sum, n) => sum + n.content.length, 0);
          rows.push({ arch, task: task.id, s, total, noteChars });
           
          console.log(
            `${arch.padEnd(9)} ${task.id}  total=${total}/25  ` +
            `[tc=${s.task_completion} th=${s.theme_coverage} f=${s.faithfulness} st=${s.structure} act=${s.actionability}]  ` +
            `noteChars=${noteChars}  — ${s.comment}`,
          );
        } finally { db.close(); }
      }
    }

    const header = "arch,task,task_completion,theme_coverage,faithfulness,structure,actionability,total,noteChars";
    const csv = [header, ...rows.map((r) =>
      [r.arch, r.task, r.s.task_completion, r.s.theme_coverage, r.s.faithfulness, r.s.structure, r.s.actionability, r.total, r.noteChars].join(","))].join("\n");
    fs.writeFileSync(path.join(wp, "quality-scores.csv"), csv);
     
    console.log("\n=== CSV ===\n" + csv);

    for (const arch of ["single", "subagent"] as const) {
      const a = rows.filter((r) => r.arch === arch);
      const avg = (f: (r: ScoreRow) => number) => (a.reduce((s, r) => s + f(r), 0) / a.length).toFixed(2);
       
      console.log(
        `AVG ${arch.padEnd(9)} total=${avg((r) => r.total)}/25  ` +
        `tc=${avg((r) => r.s.task_completion)} th=${avg((r) => r.s.theme_coverage)} ` +
        `f=${avg((r) => r.s.faithfulness)} st=${avg((r) => r.s.structure)} act=${avg((r) => r.s.actionability)} ` +
        `noteChars=${avg((r) => r.noteChars)}`,
      );
    }

    expect(rows.length).toBe(TASKS.length * 2);
  }, 900_000);
});
