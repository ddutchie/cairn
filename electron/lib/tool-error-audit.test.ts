/**
 * Tool ERROR self-correction audit — LIVE, opt-in.
 *
 * When a tool call fails, does the error text let the model RECOVER on its own
 * (re-fetch a valid id, adjust args) rather than dead-end or blindly retry? A
 * vague "Not found" wastes turns; an actionable error ("...use search_notes to
 * find the correct id") lets the agent self-correct.
 *
 * This drives a real conversation: the model is asked to act on a STALE id, the
 * tool returns an error, and we check whether the model's NEXT move is a
 * recovery (a read/search tool) vs repeating the same failing call or giving up.
 * Compares the CURRENT error text vs an ACTIONABLE variant to quantify the gap.
 *
 * Opt-in, no secrets. PROMPT_TEST_BASE_URL / TEST_LLM_BASE_URL; skips if down.
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { config as loadDotenv } from "dotenv";
import { TOOLS } from "./tools";

loadDotenv({ path: path.resolve(__dirname, "../../.env.test"), override: false });
loadDotenv({ path: path.resolve(__dirname, "../../mobile/.env"), override: false });

const BASE_URL = (
  process.env.PROMPT_TEST_BASE_URL?.trim() || process.env.TEST_LLM_BASE_URL?.trim() || "http://localhost:3042/v1"
).replace(/\/$/, "");
const MODEL = process.env.PROMPT_TEST_MODEL?.trim() || process.env.TEST_LLM_MODEL?.trim() || "gpt-4o";
const API_KEY = process.env.PROMPT_TEST_API_KEY?.trim() || process.env.TEST_LLM_API_KEY?.trim() || "";

function openaiTools() {
  return TOOLS.map((t) => ({ type: "function" as const, function: t.function }));
}

async function endpointUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}, signal: AbortSignal.timeout(2500) });
    return res.ok || res.status === 401 || res.status === 404;
  } catch { return false; }
}

const READ_TOOLS = new Set([
  "get_active_context", "get_project_context_pack", "get_note", "search_notes",
  "search_notes_semantic", "get_task", "search_tasks", "list_ready_tasks", "list_folders",
  "get_knowledge_graph", "get_neighbors",
]);

interface Turn { tools: string[]; text: string }

/**
 * Run: user asks to act on a bad id → the TARGET tool returns `errorText` → observe
 * the model's next turn. Returns the sequence of turns (each turn's tool names +
 * any assistant text). `targetTool` is the tool we inject the error for; every
 * other tool call gets a benign canned result so the convo can proceed.
 */
async function runWithInjectedError(
  ask: string,
  targetTool: string,
  errorText: string,
  maxTurns = 4,
): Promise<Turn[]> {
  const tools = openaiTools();
  const turns: Turn[] = [];
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You are the Cairn AI assistant. IDs: workspaceId ws_1, projectId proj_1. Use tools; never ask the user for IDs. If a tool fails, decide the best next action." },
    { role: "user", content: ask },
  ];
  for (let t = 0; t < maxTurns; t++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    turns.push({ tools: calls.map((c) => c.function?.name ?? ""), text: msg?.content ?? "" });
    if (calls.length === 0) return turns; // model answered with text → stop
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: calls });
    for (const c of calls) {
      const name = c.function?.name ?? "";
      // Inject the error for the target tool; benign result otherwise.
      const result = name === targetTool
        ? { error: errorText }
        : (READ_TOOLS.has(name) ? mockRead(name) : { ok: true, id: "recovered_1" });
      messages.push({ role: "tool", tool_call_id: c.id ?? "call", content: JSON.stringify(result) });
    }
  }
  return turns;
}

function mockRead(name: string): unknown {
  if (name === "search_notes" || name === "search_notes_semantic")
    return [{ id: "note_real", title: "Auth design", folder: "" }];
  if (name === "search_tasks" || name === "list_ready_tasks")
    return [{ id: "card_real", title: "Login bug", priority: "high", column_id: "col_todo" }];
  if (name === "get_project_context_pack")
    return { project: { id: "proj_1", name: "Cairn" }, pinnedNotes: [{ id: "note_real", title: "Auth design", outline: ["Auth"] }], openTasks: [] };
  return { ok: true };
}

// Did the model recover — i.e. after the error, EVENTUALLY call a READ/search
// tool (to find the right id) within the turn budget, rather than only ever
// repeating the failing call or giving up in prose. We also track whether it
// recovered IMMEDIATELY (next turn) vs after a blind retry — actionable errors
// should shift recoveries earlier.
function recovery(turns: Turn[]): { recovered: boolean; immediate: boolean } {
  const after = turns.slice(1); // turn 0 is the initial failing call
  let recovered = false;
  let immediate = false;
  for (let i = 0; i < after.length; i++) {
    if (after[i].tools.some((n) => READ_TOOLS.has(n))) {
      recovered = true;
      immediate = i === 0;
      break;
    }
  }
  return { recovered, immediate };
}

interface Case { name: string; ask: string; tool: string; current: string; actionable: string }
const CASES: Case[] = [
  {
    name: "patch_note stale id",
    ask: "In the note with id note_stale, replace 'foo' with 'bar'.",
    tool: "patch_note",
    current: "Note not found",
    actionable: "Note not found: no note has id 'note_stale'. It may be wrong or stale — call search_notes to find the correct note id, then retry.",
  },
  {
    name: "update_task stale id",
    ask: "Move card card_stale to the Done column.",
    tool: "update_task",
    current: "Task not found",
    actionable: "Task not found: no card has id 'card_stale'. Call search_tasks to find the correct card id, then retry.",
  },
  {
    name: "get_project_context_pack wrong id",
    ask: "Summarise the project with id proj_wrong.",
    tool: "get_project_context_pack",
    current: "Project not found",
    actionable: "Project not found: no project has id 'proj_wrong'. Call get_active_context (or get_cairn_context) to list valid project ids.",
  },
];

describe("tool error self-correction audit (live)", () => {
  let up = false;
  beforeAll(async () => {
    up = await endpointUp();
    if (!up) console.log(`\n[skip] no LLM endpoint at ${BASE_URL} — set PROMPT_TEST_BASE_URL.\n`);
    else console.log(`\nendpoint: ${BASE_URL}  model: ${MODEL}\n`);
  });

  it(
    "actionable errors drive self-correction at least as well as terse ones",
    async () => {
      if (!up) return;
      let curRecover = 0, actRecover = 0, curImmediate = 0, actImmediate = 0;
      console.log("=== ERROR SELF-CORRECTION (current / actionable) ===");
      for (const c of CASES) {
        const [cur, act] = await Promise.all([
          runWithInjectedError(c.ask, c.tool, c.current),
          runWithInjectedError(c.ask, c.tool, c.actionable),
        ]);
        const cr = recovery(cur), ar = recovery(act);
        curRecover += cr.recovered ? 1 : 0; actRecover += ar.recovered ? 1 : 0;
        curImmediate += cr.immediate ? 1 : 0; actImmediate += ar.immediate ? 1 : 0;
        console.log(
          `current ${cr.recovered ? (cr.immediate ? "IMMED" : "recov") : "DEAD"}  actionable ${ar.recovered ? (ar.immediate ? "IMMED" : "recov") : "DEAD"}`.padEnd(44),
          `— ${c.name}`,
        );
        console.log(`    current  next-turn tools: ${cur.slice(1).map((t) => t.tools.join(",") || "(text)").join(" → ") || "(none)"}`);
        console.log(`    action.  next-turn tools: ${act.slice(1).map((t) => t.tools.join(",") || "(text)").join(" → ") || "(none)"}`);
      }
      console.log(`\nRECOVERED:  current ${curRecover}/${CASES.length}  actionable ${actRecover}/${CASES.length}`);
      console.log(`IMMEDIATE:  current ${curImmediate}/${CASES.length}  actionable ${actImmediate}/${CASES.length}  (recovered on the very next turn, no blind retry)\n`);
      // Actionable errors must not regress recovery, and should recover at least
      // as immediately (fewer wasted retry turns).
      expect(actRecover).toBeGreaterThanOrEqual(curRecover);
      expect(actImmediate).toBeGreaterThanOrEqual(curImmediate);
    },
    180_000,
  );
});
