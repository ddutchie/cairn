/**
 * Prompt-optimization experiment — LIVE, opt-in.
 *
 * Question: does the model still pick the CORRECT tool if we strip the big
 * per-subsystem guidance out of the system prompt and lean on the tool
 * descriptions (which are always sent in the tools array) instead? If so we can
 * cut system-prompt tokens with no loss of tool-selection accuracy.
 *
 * Hits an OpenAI-compatible /v1/chat/completions endpoint (e.g. Rork exposed as
 * OpenAI at http://localhost:3042/v1). SKIPPED unless configured — no secrets in
 * source. Configure via env (falls back to the local dev endpoint):
 *   - PROMPT_TEST_BASE_URL   (e.g. http://localhost:3042/v1)
 *   - TEST_LLM_BASE_URL      (reused from .env.test)
 *   - PROMPT_TEST_MODEL / TEST_LLM_MODEL   (optional model name)
 *   - PROMPT_TEST_API_KEY / TEST_LLM_API_KEY   (optional; local needs none)
 *
 * We DON'T execute tools — we capture the first tool the model chooses and its
 * args, which is all we need to score selection accuracy. Run with:
 *   PROMPT_TEST_BASE_URL=http://localhost:3042/v1 \
 *     npx vitest run electron/lib/prompt-optimization.test.ts --project node
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { config as loadDotenv } from "dotenv";
import { encode } from "gpt-tokenizer";
import { buildSystemPrompt, TOOLS } from "./tools";
import { parseMobileTools } from "./mobile-tools-fixture";

// Load .env.test so TEST_LLM_* are available (git-ignored). mobile/.env too, in
// case an endpoint is configured there.
loadDotenv({ path: path.resolve(__dirname, "../../.env.test"), override: false });
loadDotenv({ path: path.resolve(__dirname, "../../mobile/.env"), override: false });

// Canonicalise to exactly one `/v1` suffix so the endpoint works whether the
// configured base URL includes `/v1` or not (TEST_LLM_BASE_URL is stored WITHOUT
// it — see .env.test — which otherwise 404s on `${base}/chat/completions`).
function normalizeV1(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${trimmed}/v1`;
}

const BASE_URL = normalizeV1(
  process.env.PROMPT_TEST_BASE_URL?.trim() ||
  process.env.TEST_LLM_BASE_URL?.trim() ||
  "http://localhost:3042/v1",
);
const MODEL = process.env.PROMPT_TEST_MODEL?.trim() || process.env.TEST_LLM_MODEL?.trim() || "gpt-4o";
const API_KEY = process.env.PROMPT_TEST_API_KEY?.trim() || process.env.TEST_LLM_API_KEY?.trim() || "";

const tok = (s: string) => encode(s).length;

// ── OpenAI-compatible client ─────────────────────────────────────────────────

interface CapturedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** OpenAI function-tool shape: [{ type:"function", function:{ name, description, parameters } }]. */
function openaiTools() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/** Is the endpoint reachable? Used to skip cleanly when nothing is running. */
async function endpointUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    return res.ok || res.status === 401 || res.status === 404; // reachable
  } catch {
    return false;
  }
}

/**
 * Send a user turn and return the first NON-orientation tool the model selects.
 * Both prompts mandate calling get_active_context first, so we satisfy that with
 * a canned result and continue until the model picks a task tool (or answers
 * with text). Up to `maxHops` model calls. We never execute real tools.
 */
async function taskToolCall(
  systemPrompt: string,
  userText: string,
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[],
  maxHops = 4,
): Promise<CapturedToolCall | null> {
  // Canned context so the model can proceed past orientation without real data.
  const cannedContext = JSON.stringify({
    workspaceId: "ws_1",
    projects: [{ id: "proj_1", name: "Cairn", columns: [
      { id: "col_todo", name: "Todo", type: "todo" },
      { id: "col_prog", name: "In Progress", type: "in_progress" },
      { id: "col_done", name: "Done", type: "done" },
    ] }],
    tags: [],
  });

  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText },
  ];

  const ORIENTATION = new Set(["get_active_context", "get_cairn_context", "get_project_context_pack"]);

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    const msg = json.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0];
    const name = call?.function?.name;
    if (!name) return null; // model answered with text — no tool chosen

    let input: Record<string, unknown> = {};
    try {
      input = call?.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      /* leave empty */
    }

    if (!ORIENTATION.has(name)) return { name, input }; // the task tool we want

    // Satisfy the orientation call with canned data, then let the model continue.
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: msg?.tool_calls });
    messages.push({ role: "tool", tool_call_id: call?.id ?? "call_0", content: cannedContext });
  }
  return null;
}

// ── Prompt variants under test ───────────────────────────────────────────────
// OLD = the previous verbose prompts (kept here as literals for the record).
// PROD = the current production prompts (desktop imported; mobile kept in sync
// as a literal since the RN module can't load in Node). This test is now a
// REGRESSION GUARD: PROD must select tools at least as accurately as OLD.

const OLD_DESKTOP = [
  "You are the Cairn AI assistant — an intelligent helper embedded inside a note-taking and project management app.",
  "## RENDERING CAPABILITIES: Mermaid diagrams, tables, code blocks (with language), standard formatting.",
  "## Getting IDs: Call get_active_context once to obtain workspaceId/projectId/columnId; reuse them. Never ask for IDs.",
  "## Instructions: For writes call the tool directly; after a write briefly confirm; bold key items; concise.",
  "## Notes: ensure_note (idempotent; omit content to preserve); rename_note (fixes wikilinks); bulk_move_notes; list_folders; folder param; patch_note for edits, append_to_note to add; search_notes empty=all (offset/updatedAfter); search_notes_semantic for concepts; tagNames auto-resolves tags.",
  "## Tasks: update_task with columnId to move; list_ready_tasks for unblocked; blockedBy/unblockFrom; link_note_to_task/unlink; tagNames.",
  "## Dashboards: create_dashboard; call get_dashboard_constants before writing HTML.",
  "## Idea Flow: prefer note_ref/task_ref; inline-create via data (noteTitle/noteContent or taskTitle/taskDescription/priority); use spatial.nextPosition.",
  "## Knowledge Graph: get_knowledge_graph first; get_neighbors for N-hop; CRITICAL: to suggest connections you MUST call suggest_connections, not prose.",
  "Tone: calm, focused, like a thoughtful co-worker.",
].join("\n");

const PROD_DESKTOP = buildSystemPrompt({ message: "", threadId: "t" });

// Mobile prompts (RN modules can't import in Node — replicated verbatim from
// mobile/src/chat/agent.ts systemMessage()).
const isoDate = new Date().toISOString().slice(0, 10);
const humanDate = new Date().toLocaleDateString(undefined, {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
});
const OLD_MOBILE = [
  "You are Cairn's mobile assistant. You help the user read and edit their notes and tasks.",
  `The current date is ${humanDate} (${isoDate}). Use it to resolve relative dates like "tomorrow" or "next week", and always pass dates to tools as YYYY-MM-DD.`,
  "You have tools that run against the user's local workspace; writes sync to their desktop.",
  "ALWAYS begin by calling get_cairn_context to get project ids, columns, and tags — there is no separate 'list projects' tool.",
  "To summarise or reason about a project, then call get_project_context_pack(project_id): it returns the project, columns, pinned notes, open tasks grouped by column, and recent activity in one call. Prefer it over many small list/get calls.",
  "Look up ids with read tools before writing — never invent an id.",
  "When you mention a specific note in your reply, wrap its exact title in [[double brackets]] so the user can tap it to open the note.",
  "After a successful write, briefly confirm what you did. Answer in concise markdown.",
].join(" ");
// PROD mobile — MUST stay in sync with mobile/src/chat/agent.ts systemMessage().
const PROD_MOBILE = [
  "You are Cairn's mobile assistant for the user's notes and tasks; writes sync to their desktop.",
  `The current date is ${humanDate} (${isoDate}). Resolve relative dates like "tomorrow"/"next week" against it, and pass dates to tools as YYYY-MM-DD.`,
  "Call get_cairn_context first to get project ids, columns, and tags (there is no separate 'list projects' tool), then reuse them — never invent an id. Choose the tool whose description matches the request.",
  "When you mention a specific note or task, link it as [[id]] using its exact id (it renders as the title and can't be confused with a same-titled item); if you don't have the id, [[Title]] also works. After a write, briefly confirm. Answer in concise markdown.",
].join(" ");

/** Mobile tools, parsed from mobile/src/chat/tools.ts via the shared fixture so
 *  the two AI experiment tests don't maintain divergent parsers and stay in sync
 *  with the source. jsonSchema is generic (name + description drive selection). */
function mobileTools() {
  return parseMobileTools();
}

// Realistic requests → the tool we EXPECT the model to select. Asks give the
// target id where relevant so the decision isn't masked by a read-first lookup.
const SCENARIOS: { ask: string; expect: string[] }[] = [
  { ask: "Rename the note with id note_42 to 'Q3 Planning'.", expect: ["rename_note"] },
  { ask: "Move the card id card_7 to the Done column (col_done).", expect: ["update_task", "bulk_update_task_status"] },
  { ask: "Make a dashboard showing task counts per column.", expect: ["create_dashboard", "get_dashboard_constants"] },
  { ask: "What notes talk about authentication? Search by meaning, not keywords.", expect: ["search_notes_semantic"] },
  { ask: "Create a task 'Write release notes' in the Todo column (col_todo).", expect: ["create_task"] },
  { ask: "Move notes note_1, note_2 and note_3 into a folder called 'Research'.", expect: ["bulk_move_notes"] },
  { ask: "Add a node to the idea canvas in project proj_1 for a new caching-layer idea.", expect: ["create_idea_flow_node"] },
  { ask: "Delete the note with id note_9.", expect: ["delete_note"] },
  { ask: "Link note note_5 to card card_2.", expect: ["link_note_to_task"] },
  { ask: "Add a tag called 'urgent' to the workspace.", expect: ["create_tag"] },
];

/** Mobile lacks idea-flow, dashboards, tags, linking → mobile-appropriate asks. */
const MOBILE_SCENARIOS: { ask: string; expect: string[] }[] = [
  { ask: "Rename the note with id note_42 to 'Q3 Planning'.", expect: ["rename_note"] },
  { ask: "Move the card id card_7 to the Done column (col_done).", expect: ["update_task"] },
  { ask: "What notes talk about authentication? Search by meaning, not keywords.", expect: ["search_notes_semantic"] },
  { ask: "Create a task 'Write release notes' in the Todo column (col_todo).", expect: ["create_task"] },
  { ask: "Move notes note_1, note_2 and note_3 into a folder called 'Research'.", expect: ["bulk_move_notes"] },
  { ask: "Delete the note with id note_9.", expect: ["delete_note"] },
  { ask: "Delete the card with id card_3.", expect: ["delete_task"] },
  { ask: "Show me the full detail of task card_8.", expect: ["get_task"] },
  { ask: "Append 'See follow-up below.' to note note_2.", expect: ["append_to_note"] },
  { ask: "What folders exist in project proj_1?", expect: ["list_folders"] },
];

const hit = (name: string | null, want: string[]) => (name && want.includes(name) ? 1 : 0);

/** Compare OLD (verbose) vs PROD (current) prompt tool-selection. Returns scores. */
async function runComparison(
  label: string,
  oldPrompt: string,
  prodPrompt: string,
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[],
  scenarios: { ask: string; expect: string[] }[],
): Promise<{ oldScore: number; prodScore: number }> {
  const results: { ask: string; old: string | null; prod: string | null; want: string[] }[] = [];
  for (const s of scenarios) {
    const [o, p] = await Promise.all([
      taskToolCall(oldPrompt, s.ask, tools),
      taskToolCall(prodPrompt, s.ask, tools),
    ]);
    results.push({ ask: s.ask, old: o?.name ?? null, prod: p?.name ?? null, want: s.expect });
  }
  const oldScore = results.reduce((a, r) => a + hit(r.old, r.want), 0);
  const prodScore = results.reduce((a, r) => a + hit(r.prod, r.want), 0);

  console.log(`\n=== ${label}: TOOL SELECTION (old / prod) ===`);
  console.log(`OLD prompt : ${tok(oldPrompt)} tok`);
  console.log(`PROD prompt: ${tok(prodPrompt)} tok  (saving ${tok(oldPrompt) - tok(prodPrompt)}, -${Math.round((1 - tok(prodPrompt) / tok(oldPrompt)) * 100)}%)`);
  for (const r of results) {
    console.log(
      `${hit(r.old, r.want) ? "OK  " : "MISS"}old ${hit(r.prod, r.want) ? "OK  " : "MISS"}prod`.padEnd(16),
      `[${r.want.join("|")}]`.padEnd(42),
      `old=${r.old ?? "—"}  prod=${r.prod ?? "—"}`,
    );
  }
  console.log(`OLD: ${oldScore}/${scenarios.length}   PROD: ${prodScore}/${scenarios.length}\n`);
  return { oldScore, prodScore };
}

describe.skipIf(!!process.env.CAIRN_SKIP_LIVE_TESTS || process.env.CAIRN_LIVE_TESTS !== "1")("prompt optimization — tool selection (live)", () => {
  const desktopToolset = openaiTools();
  const mobileToolset = mobileTools();
  let up = false;

  beforeAll(async () => {
    up = await endpointUp();
    if (!up) {
      console.log(`\n[skip] no LLM endpoint at ${BASE_URL} — set PROMPT_TEST_BASE_URL to run.\n`);
      return;
    }
    console.log(`\nendpoint: ${BASE_URL}  model: ${MODEL}  (desktop ${desktopToolset.length} tools, mobile ${mobileToolset.length} tools)`);
  });

  it(
    "DESKTOP: production (trimmed) prompt selects tools at least as well as the old verbose prompt",
    async () => {
      if (!up) return;
      const { oldScore, prodScore } = await runComparison(
        "DESKTOP", OLD_DESKTOP, PROD_DESKTOP, desktopToolset, SCENARIOS,
      );
      expect(prodScore).toBeGreaterThanOrEqual(oldScore);
    },
    180_000,
  );

  it(
    "MOBILE: production (trimmed) prompt selects tools at least as well as the old verbose prompt",
    async () => {
      if (!up) return;
      const { oldScore, prodScore } = await runComparison(
        "MOBILE", OLD_MOBILE, PROD_MOBILE, mobileToolset, MOBILE_SCENARIOS,
      );
      expect(prodScore).toBeGreaterThanOrEqual(oldScore);
    },
    180_000,
  );
});
