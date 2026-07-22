/**
 * Cairn — Fault-injection benchmark: write-failure recovery
 *
 * Answers the design question: when the writer provides a wrong `oldString` to
 * patch_note, does the subagent architecture PING-PONG back to the dispatcher,
 * and does a "pure write-only" writer (no get_note) get stuck?
 *
 * We force the FIRST patch_note call to miss (corrupt its oldString) via the
 * argMutator seam on runToolLoop / runDispatchLoop, then measure recovery under
 * three configs:
 *
 *   A. STRICT subagent — writer has NO read tools (WRITE_TOOL_NAMES_STRICT).
 *      It cannot get_note to self-correct → failure should escalate to the
 *      dispatcher (writeInvocations > 1 = ping-pong) or fail outright.
 *   B. HYBRID subagent — writer includes get_note (WRITE_TOOL_NAMES, default).
 *      It should self-correct inside its own loop (writeInvocations == 1).
 *   C. SINGLE agent   — control; self-corrects in one context.
 *
 * "Recovered" = the note actually contains the intended new text at the end.
 *
 * Endpoint via the repo convention (.env.test): TEST_LLM_BASE_URL / _MODEL / _API_KEY.
 * Gated by CAIRN_SKIP_LIVE_TESTS and endpoint reachability.
 *
 * Run:
 *   npx vitest run --project node electron/lib/chat-write-recovery-benchmark.test.ts
 */

import { describe, it, beforeEach, expect } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote, getNoteById } from "../db/queries";
import { buildSystemPrompt, type ChatRequest } from "./tools";
import { normaliseBaseUrl } from "./llm";
import { runToolLoop } from "./chat-loop";
import { runDispatchLoop, WRITE_TOOL_NAMES, WRITE_TOOL_NAMES_STRICT } from "./chat-subagent-loop";

// For THIS test we drop append_to_note from the writer sets so the model can't
// sidestep the patch_note path (an in-place replacement is required). This
// isolates the failure mode under study: a bad oldString on patch_note.
const noAppend = (s: ReadonlySet<string>) => new Set([...s].filter((n) => n !== "append_to_note"));
const HYBRID_WRITE = noAppend(WRITE_TOOL_NAMES);         // still has get_note
const STRICT_WRITE = noAppend(WRITE_TOOL_NAMES_STRICT);  // no read tools at all

const BASE_URL = normaliseBaseUrl(process.env.TEST_LLM_BASE_URL?.trim() || "http://localhost:1234/v1");
const MODEL = process.env.TEST_LLM_MODEL?.trim() || "gpt-4o-mini";
const API_KEY = process.env.TEST_LLM_API_KEY?.trim() || "";

const WS = "ws-fault";
const PROJ = "proj-fault";
const COL = "col-fault";
const NOTE_ID = "n-themes";
const NOTE_TITLE = "Themes Synthesis";

// A note with a distinctive, easy-to-target anchor line so the correct oldString
// is unambiguous once the model reads the real content.
const NOTE_BODY = `# Themes Synthesis

## Overview
This project spans mobile semantic search, code indexing, and performance work.

## Key Themes
- On-device semantic search (NLContextualEmbedding)
- Chunked code indexing (jina-code)
- Payload/token optimization

## Open Questions
- Should the semantic score floor be tuned per-project?
`;

// The intended edit is an IN-PLACE REPLACEMENT (not an append), so the model
// must use patch_note with a correct oldString — this is the operation whose
// failure we want to test. The natural target is the Overview sentence.
const ANCHOR = "This project spans mobile semantic search, code indexing, and performance work.";

function makeDb() {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database) {
  createWorkspace(db, { id: WS, name: "Fault WS" });
  createProject(db, { id: PROJ, workspaceId: WS, name: "Cairn", priority: "high" });
  createColumn(db, { id: COL, projectId: PROJ, workspaceId: WS, name: "Backlog", type: "backlog", order: 0 });
  createNote(db, { id: NOTE_ID, projectId: PROJ, workspaceId: WS, title: NOTE_TITLE, content: NOTE_BODY });
}

async function endpointUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    return res.ok || res.status === 401 || res.status === 404;
  } catch { return false; }
}

/**
 * Fault injector factory. Corrupts the FIRST patch_note call's oldString so it
 * cannot match, then passes everything else through untouched — simulating the
 * model guessing the wrong replacement text once.
 */
function makeFirstPatchFault() {
  let fired = false;
  const injector = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    if (!fired && name === "patch_note" && typeof args.oldString === "string") {
      fired = true;
      return { ...args, oldString: args.oldString + " __NONEXISTENT_ZZZ__" };
    }
    return args;
  };
  return { injector, didFire: () => fired };
}

function recovered(db: Database.Database): boolean {
  const note = getNoteById(db, NOTE_ID) as { content?: string } | undefined;
  const content = note?.content ?? "";
  // Recovery = the Overview sentence was actually rewritten (the anchor text is
  // GONE and the new phrase is present), i.e. a targeted patch_note landed.
  return !content.includes(ANCHOR) && content.toLowerCase().includes("throughline");
}

const PROMPT = `In the note "${NOTE_TITLE}", REPLACE the sentence in the Overview section that begins "This project spans..." with a new sentence stating that the project's throughline is on-device intelligence under tight token budgets. You must edit that existing sentence in place using patch_note (do not append a new section).`;

interface RecoveryRecord {
  config: string;
  recovered: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolCalls: number;
  toolErrors: number;
  writeInvocations: number;
  faultFired: boolean;
}

function baseReq(): ChatRequest {
  return {
    message: PROMPT, threadId: "fault-thread",
    workspaceId: WS, projectId: PROJ,
    config: { maxSteps: 12, temperature: 0.2 },
  };
}

async function runSingle(db: Database.Database, wp: string): Promise<RecoveryRecord> {
  const req = baseReq();
  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req) },
    { role: "user" as const, content: PROMPT },
  ];
  const fault = makeFirstPatchFault();
  let pt = 0, ct = 0, calls = 0, errs = 0;
  const t0 = Date.now();
  await runToolLoop(
    db, req, wp, BASE_URL, MODEL, API_KEY, messages,
    () => { calls += 1; }, undefined, undefined, "openai",
    (p, c) => { pt += p; ct += c; },
    (e) => { if (e.output) { try { if (JSON.parse(e.output)?.error) errs += 1; } catch { /* */ } } },
    undefined, undefined, [], undefined, fault.injector,
  );
  return {
    config: "C-single", recovered: recovered(db),
    promptTokens: pt, completionTokens: ct, latencyMs: Date.now() - t0,
    toolCalls: calls, toolErrors: errs, writeInvocations: 0, faultFired: fault.didFire(),
  };
}

async function runSub(db: Database.Database, wp: string, label: string, writeTools: ReadonlySet<string>): Promise<RecoveryRecord> {
  const req = baseReq();
  const fault = makeFirstPatchFault();
  const t0 = Date.now();
  const { metrics } = await runDispatchLoop(
    db, req, wp, { baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY, provider: "openai" },
    undefined, { writeTools, argMutator: fault.injector },
  );
  return {
    config: label, recovered: recovered(db),
    promptTokens: metrics.promptTokens, completionTokens: metrics.completionTokens,
    latencyMs: Date.now() - t0, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors,
    writeInvocations: metrics.writeInvocations, faultFired: fault.didFire(),
  };
}

describe.skipIf(!!process.env.CAIRN_SKIP_LIVE_TESTS)("write-failure recovery (fault injection, live)", () => {
  let up = false;
  beforeEach(async () => { up = await endpointUp(); });

  it("compares strict-write vs hybrid-write vs single on a forced bad oldString", async () => {
    if (!up) {
      // eslint-disable-next-line no-console
      console.log(`[skip] No LLM endpoint at ${BASE_URL}. Set TEST_LLM_* to run.`);
      return;
    }

    const wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-fault-"));
    const rows: RecoveryRecord[] = [];

    // A — strict write-only (no get_note)
    {
      const db = makeDb(); seed(db);
      try { rows.push(await runSub(db, wp, "A-strict", STRICT_WRITE)); } finally { db.close(); }
    }
    // B — hybrid write (with get_note)
    {
      const db = makeDb(); seed(db);
      try { rows.push(await runSub(db, wp, "B-hybrid", HYBRID_WRITE)); } finally { db.close(); }
    }
    // C — single agent
    {
      const db = makeDb(); seed(db);
      try { rows.push(await runSingle(db, wp)); } finally { db.close(); }
    }

    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.config.padEnd(9)} recovered=${r.recovered ? "YES" : "NO "}  ` +
        `faultFired=${r.faultFired ? "y" : "n"}  ptok=${String(r.promptTokens).padStart(6)}  ` +
        `ctok=${String(r.completionTokens).padStart(5)}  ${String(r.latencyMs).padStart(6)}ms  ` +
        `calls=${r.toolCalls}  err=${r.toolErrors}  writeInvocations=${r.writeInvocations}`,
      );
    }

    const header = "config,recovered,faultFired,promptTok,completionTok,latencyMs,toolCalls,toolErrors,writeInvocations";
    const csv = [header, ...rows.map((r) =>
      [r.config, r.recovered, r.faultFired, r.promptTokens, r.completionTokens, r.latencyMs, r.toolCalls, r.toolErrors, r.writeInvocations].join(","))].join("\n");
    const outPath = path.join(wp, "write-recovery.csv");
    fs.writeFileSync(outPath, csv);
    // eslint-disable-next-line no-console
    console.log("\n=== CSV ===\n" + csv + "\n\nWritten to: " + outPath);

    // faultFired / recovered / writeInvocations are the FINDINGS, logged above.
    // The test only asserts all three configs ran; interpretation is manual.
    expect(rows.length).toBe(3);
  }, 600_000);
});
