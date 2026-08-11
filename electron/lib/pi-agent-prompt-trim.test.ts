/**
 * Cairn — Coding agent system-prompt trim verification
 *
 * The pi-agent system prompt no longer lists tools ("## Coding tools" /
 * "## Cairn tools" / "## Available tools") because every tool is already
 * defined in the tools array the model receives. This test:
 *
 *   • OFFLINE (always runs): asserts the trimmed prompt drops the redundant
 *     sections, keeps the base identity + workflow intact, and measures the
 *     deterministic token saving vs. the legacy prompt.
 *   • LIVE (gated on an endpoint, like chat-agent-benchmark): replays a small
 *     tool-selection task set through runToolLoop with BOTH the legacy and the
 *     trimmed prompt, and asserts the trimmed prompt selects the same (correct)
 *     tools while sending fewer prompt tokens. Run with:
 *
 *       CAIRN_LIVE_TESTS=1 TEST_LLM_BASE_URL=... TEST_LLM_MODEL=... \
 *         TEST_LLM_API_KEY=... npx vitest run electron/lib/pi-agent-prompt-trim.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { encode } from "gpt-tokenizer";
import { applySchema } from "../db/schema";
import {
  createWorkspace, createProject, createNote, createColumn, createCard,
} from "../db/queries";
import { buildPiAgentSystemPrompt, type PiAgentPromptContext } from "./pi-agent-prompt";
import { type ChatRequest } from "./tools";
import { BASE_URL, MODEL, API_KEY, endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import { runToolLoop } from "./chat-loop";

const tok = (s: string) => encode(s).length;

// The exact tool-list blocks removed from the execute-mode prompt, kept here so
// the live suite can rebuild the LEGACY prompt and A/B it against the trimmed
// one with the same model + tasks.
const LEGACY_CODING_TOOLS = `## Coding tools
- **read** — read file contents with line ranges
- **write** — write or overwrite a file entirely
- **edit** — make targeted string replacements (always read first to get exact content)
- **bash** — execute shell commands (tests, builds, git, grep, etc.)
- **grep** — search file contents with regex
- **find** — find files by name pattern
- **ls** — list directory contents
- **spawn_subagent** — delegate a contained, deep sub-task to a fresh agent with its own context window; only the final answer is returned to you`;

const LEGACY_CAIRN_TOOLS = `## Cairn tools
- **get_active_context** — get IDs for the current workspace, project, and board columns
- **get_project_context_pack** — get full project state: tasks, notes, recent activity
- **ensure_note** — create-or-update a note by title (idempotent — use this for all note writes)
- **patch_note** / **append_to_note** — targeted edit or append to an existing note
- **search_notes** / **get_note** — find and read project notes
- **search_notes_semantic** — natural-language search via local embeddings (better than search_notes when concepts are described in different words; requires embeddings enabled)
- **create_task** / **update_task** — create tasks; update_task with \`columnId\` moves to a column
- **search_tasks** / **list_ready_tasks** — find tasks; list_ready_tasks returns only unblocked work`;

function executePrompt(ctx: Partial<PiAgentPromptContext>): string {
  return buildPiAgentSystemPrompt({
    projectName: ctx.projectName ?? "My Project",
    cwd: ctx.cwd ?? "/project",
    taskTitle: ctx.taskTitle,
    mode: "execute",
  });
}

function legacyExecutePrompt(ctx: Partial<PiAgentPromptContext>): string {
  const trimmed = executePrompt(ctx);
  // Rebuild the pre-trim prompt: the removed blocks sat between the Context
  // section and "## Mandatory Cairn workflow".
  return trimmed.replace(
    "\n\n## Mandatory Cairn workflow",
    `\n\n${LEGACY_CODING_TOOLS}\n\n${LEGACY_CAIRN_TOOLS}\n\n## Mandatory Cairn workflow`,
  );
}

// ── Offline: structural + deterministic token savings ─────────────────────────

describe("pi-agent system prompt trim (offline)", () => {
  const trimmed = executePrompt({ taskTitle: "Fix bug" });
  const legacy = legacyExecutePrompt({ taskTitle: "Fix bug" });

  it("drops the redundant tool-listing sections from execute mode", () => {
    expect(trimmed).not.toContain("## Coding tools");
    expect(trimmed).not.toContain("## Cairn tools");
    expect(trimmed).not.toContain("- **read** — read file contents");
    expect(trimmed).not.toContain("**get_active_context** — get IDs");
  });

  it("keeps the base identity, context, and mandatory workflow intact", () => {
    expect(trimmed).toContain("You are the Cairn coding agent");
    expect(trimmed).toContain("## Context");
    expect(trimmed).toContain("## Mandatory Cairn workflow");
    expect(trimmed).toContain("**1. Orient (first thing, once per session)**");
    expect(trimmed).toContain("## Coding guidelines");
    // Tool guidance that the workflow still depends on survives as prose.
    expect(trimmed).toContain("Always use `ensure_note` to write notes");
    expect(trimmed).toContain("get_active_context");
  });

  it("drops the redundant tool-listing section from plan mode", () => {
    const plan = buildPiAgentSystemPrompt({ projectName: "P", cwd: "/p", mode: "plan" });
    expect(plan).not.toContain("## Available tools");
    expect(plan).not.toContain("- **ask_questions** — render an inline question form");
  });

  it("sends measurably fewer system-prompt tokens than the legacy prompt", () => {
    const saved = tok(legacy) - tok(trimmed);
    // The removed listings are ~15 tool bullets ≈ several hundred tokens.
    expect(saved).toBeGreaterThan(100);
    expect(tok(trimmed)).toBeLessThan(tok(legacy));
    console.log(`\nCoding-agent system prompt: ${tok(trimmed)} tok (was ${tok(legacy)}) — ${saved} tok saved per turn (${Math.round((saved / tok(legacy)) * 100)}%).`);
  });
});

// ── Live: same-model A/B of tool selection ────────────────────────────────────

interface ToolSelTask {
  id: string;
  prompt: string;
  /** Tools that count as a correct first call. */
  expected: string[];
}

const TOOL_TASKS: ToolSelTask[] = [
  { id: "ls",   prompt: "List the files in this directory.", expected: ["ls"] },
  { id: "find", prompt: "Find the file named package.json in this project.", expected: ["find"] },
  { id: "grep", prompt: "Search the project files for the string OPENAI_API_KEY.", expected: ["grep"] },
  { id: "read", prompt: "Read the contents of src/hello.ts.", expected: ["read"] },
  { id: "note", prompt: "Create a note titled 'Hello World' in this project.", expected: ["ensure_note"] },
  { id: "tasks", prompt: "List the open tasks in this project.", expected: ["search_tasks", "list_ready_tasks"] },
  { id: "notes", prompt: "Search notes for the word 'benchmark'.", expected: ["search_notes"] },
];

const WS = "ws-trim";
const PROJ = "proj-trim";
const COL_TODO = "col-todo";
const COL_DONE = "col-done";

function seed(db: Database.Database) {
  createWorkspace(db, { id: WS, name: "Trim Workspace" });
  createProject(db, { id: PROJ, workspaceId: WS, name: "Cairn", description: "Desktop app", priority: "high", icon: "🪨" });
  createColumn(db, { id: COL_TODO, projectId: PROJ, workspaceId: WS, name: "Todo", type: "todo", order: 0 });
  createColumn(db, { id: COL_DONE, projectId: PROJ, workspaceId: WS, name: "Done", type: "done", order: 1 });
  createNote(db, { id: "n-bench", projectId: PROJ, workspaceId: WS, title: "Benchmark findings", content: "Tool-array context cost benchmark results." });
  createCard(db, { id: "c-1", columnId: COL_TODO, projectId: PROJ, workspaceId: WS, title: "Trim the system prompt", description: "", priority: "medium", tagIds: [] });
}

/** A tiny real workspace so ls/grep/find/read have content (no repo writes). */
function seedWorkspaceDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-trim-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "trim-test", version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "src", "hello.ts"), "export const greet = () => 'hello';\n// OPENAI_API_KEY is never committed here\n");
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function toolCallsFor(
  db: Database.Database,
  cwd: string,
  systemPrompt: string,
  task: ToolSelTask,
): Promise<{ called: Set<string>; promptTokens: number; toolErrors: number }> {
  const req: ChatRequest = {
    message: task.prompt,
    threadId: "trim-thread",
    workspaceId: WS,
    projectId: PROJ,
    config: { maxSteps: 6, temperature: 0 },
  };
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: task.prompt },
  ];
  const called = new Set<string>();
  let promptTokens = 0;
  let toolErrors = 0;
  await runToolLoop(
    db, req, cwd, BASE_URL, MODEL, API_KEY, messages,
    (e) => { called.add(e.tool); },
    undefined, undefined, "openai",
    (pt) => { promptTokens += pt; }, // accumulate across tool-loop rounds
    (e) => { if (e.output) { try { if (JSON.parse(e.output)?.error) toolErrors += 1; } catch { /* ignore */ } } },
  );
  return { called, promptTokens, toolErrors };
}

describe.skipIf(!LIVE_TESTS_ENABLED)("pi-agent prompt trim — live A/B tool selection", () => {
  let up = false;
  beforeAll(async () => { up = await endpointUp(); });

  it("selects the same correct tools with the trimmed prompt, with fewer prompt tokens", async () => {
    if (!up) {
      console.log(`[skip] No LLM endpoint reachable at ${BASE_URL}. Set TEST_LLM_BASE_URL/MODEL/API_KEY to run the live A/B.`);
      return;
    }

    const wd = seedWorkspaceDir();
    try {
      const rows: string[] = ["task,legacy_called,trimmed_called,legacy_ptok,trimmed_ptok"];
      let legacyCorrect = 0;
      let trimmedCorrect = 0;
      let legacyTokens = 0;
      let trimmedTokens = 0;

      for (const task of TOOL_TASKS) {
        // Fresh DB per prompt so writes from one don't bias the other.
        const legacy = await (async () => {
          const db = new BetterSqlite3(":memory:");
          applySchema(db);
          seed(db);
          try {
            return await toolCallsFor(db, wd.dir, legacyExecutePrompt({ taskTitle: "Trim prompt" }), task);
          } finally { db.close(); }
        })();
        const trimmed = await (async () => {
          const db = new BetterSqlite3(":memory:");
          applySchema(db);
          seed(db);
          try {
            return await toolCallsFor(db, wd.dir, executePrompt({ taskTitle: "Trim prompt" }), task);
          } finally { db.close(); }
        })();

        // The workflow mandates get_active_context first, so check the expected
        // tool appears SOMEWHERE in the call set, not as the first call.
        const legacyOk = task.expected.some((t) => legacy.called.has(t));
        const trimmedOk = task.expected.some((t) => trimmed.called.has(t));
        if (legacyOk) legacyCorrect += 1;
        if (trimmedOk) trimmedCorrect += 1;
        legacyTokens += legacy.promptTokens;
        trimmedTokens += trimmed.promptTokens;

        rows.push(
          `${task.id},${[...legacy.called].join("|") || "—"},${[...trimmed.called].join("|") || "—"},${legacy.promptTokens},${trimmed.promptTokens}`,
        );
        console.log(
          `${task.id.padEnd(6)} legacy=${legacyOk ? "ok" : "MISS"}  trimmed=${trimmedOk ? "ok" : "MISS"}  ` +
          `ptok ${legacy.promptTokens}→${trimmed.promptTokens}  ` +
          `calls ${[...legacy.called].join(",") || "—"} → ${[...trimmed.called].join(",") || "—"}  err ${legacy.toolErrors}/${trimmed.toolErrors}`,
        );
      }

      console.log("\n=== A/B summary ===\n" + rows.join("\n"));
      console.log(`\nCorrect tool selection: legacy ${legacyCorrect}/${TOOL_TASKS.length}, trimmed ${trimmedCorrect}/${TOOL_TASKS.length}`);
      console.log(`Prompt tokens (sum):   legacy ${legacyTokens}, trimmed ${trimmedTokens} (${Math.round((1 - trimmedTokens / legacyTokens) * 100)}% less)`);

      // The trimmed prompt must select the correct tool at least as often as the
      // legacy prompt, while sending strictly fewer prompt tokens.
      expect(trimmedCorrect).toBeGreaterThanOrEqual(legacyCorrect);
      expect(trimmedTokens).toBeLessThan(legacyTokens);
    } finally {
      wd.cleanup();
    }
  }, 600_000);
});
