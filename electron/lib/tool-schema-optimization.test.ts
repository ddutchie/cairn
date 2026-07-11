/**
 * Tool-schema compression experiment — LIVE, opt-in.
 *
 * The tool payload (~5,092 tok) dwarfs the system prompt. A token breakdown
 * shows the weight is in PARAMETER SCHEMAS (~3,308 tok), not descriptions
 * (~1,036) — much of it mechanical JSON-Schema noise that carries no signal for
 * the model: giant ISO-8601 `pattern` regexes, `maximum: 9007199254740991` /
 * `minimum` bounds on integers, and `.describe()` sentences that merely restate
 * the field name.
 *
 * Unlike the system prompt (which doesn't drive selection), tool schemas drive
 * BOTH tool selection AND argument correctness — so this test measures both:
 * does the model still pick the right tool, and still fill the right args, with
 * the compressed schemas?
 *
 * Opt-in, no hardcoded secrets. Configure via PROMPT_TEST_BASE_URL /
 * TEST_LLM_BASE_URL (+ *_MODEL / *_API_KEY). Skips cleanly if unreachable. Run:
 *   PROMPT_TEST_BASE_URL=http://localhost:3042/v1 \
 *     npx vitest run electron/lib/tool-schema-optimization.test.ts --project node
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { config as loadDotenv } from "dotenv";
import { encode } from "gpt-tokenizer";
import * as z from "zod";
import { TOOLS } from "./tools";
import { TOOL_SCHEMAS, AGENT_EXCLUDED_TOOLS } from "./tool-schemas";
import { parseMobileTools } from "./mobile-tools-fixture";

loadDotenv({ path: path.resolve(__dirname, "../../.env.test"), override: false });
loadDotenv({ path: path.resolve(__dirname, "../../mobile/.env"), override: false });

// Canonicalise to exactly one `/v1` suffix so `${base}/chat/completions` works
// whether the configured base URL includes `/v1` or not (TEST_LLM_BASE_URL is
// stored WITHOUT it — see .env.test).
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

// ── Schema compression (mechanical, lossless-for-the-model) ──────────────────

type JsonObj = Record<string, unknown>;

/**
 * Strip JSON-Schema noise the model never needs, recursively. `level`:
 *  - "safe": pattern / min / max / default / additionalProperties:false, plus
 *    `.describe()` text that merely restates the field key.
 *  - "aggressive": also drop ALL nested parameter `.describe()` text (keep field
 *    names + types + enums, which carry the real signal). Top-level tool
 *    description is untouched in both (that drives selection).
 */
function compressSchema(node: unknown, level: "safe" | "aggressive", key?: string, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => compressSchema(n, level, undefined, depth));
  if (!node || typeof node !== "object") return node;
  const obj = node as JsonObj;
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "pattern" || k === "minimum" || k === "maximum" || k === "default") continue;
    if (k === "additionalProperties" && v === false) continue;
    if (k === "description" && typeof v === "string") {
      if (level === "aggressive" && depth > 0) continue; // drop all nested param descriptions
      const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
      if (key && norm(v).includes(norm(key)) && v.length < key.length + 24) continue; // restates the key
    }
    if (k === "properties" && v && typeof v === "object") {
      const props: JsonObj = {};
      for (const [pk, pv] of Object.entries(v as JsonObj)) props[pk] = compressSchema(pv, level, pk, depth + 1);
      out[k] = props;
      continue;
    }
    out[k] = compressSchema(v, level, k, depth + 1);
  }
  return out;
}

/**
 * The TRUE-FULL baseline: raw zod → JSON Schema WITHOUT the production
 * `stripSchemaNoise` (which now lives in tools.ts and already ships the "safe"
 * strip). Rebuilt here so the experiment can still compare against the original
 * un-stripped payload. `TOOLS` (imported) is the current production ("safe").
 */
function fullOpenaiTools() {
  const excluded = new Set<string>(AGENT_EXCLUDED_TOOLS);
  return Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => !excluded.has(name))
    .map(([name, def]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = z.toJSONSchema((def as any).schema, { target: "draft-07" }) as Record<string, unknown>;
      delete json["$schema"];
      return { type: "function" as const, function: { name, description: (def as { description: string }).description, parameters: json } };
    });
}
/** Current production tool payload (already "safe"-stripped in tools.ts). */
function safeOpenaiTools() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
  }));
}
/** Aggressive = drop all nested param descriptions on top of production. */
function aggressiveOpenaiTools() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: compressSchema(t.function.parameters, "aggressive"),
    },
  }));
}

// ── OpenAI-compatible client (capture first non-orientation tool + its args) ──

interface Captured { name: string; input: Record<string, unknown> }

async function endpointUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}

async function taskToolCall(
  systemPrompt: string,
  userText: string,
  tools: unknown[],
  maxHops = 4,
): Promise<Captured | null> {
  const cannedContext = JSON.stringify({
    workspaceId: "ws_1",
    projects: [{ id: "proj_1", name: "Cairn", columns: [
      { id: "col_todo", name: "Todo", type: "todo" },
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
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0];
    const name = call?.function?.name;
    if (!name) return null;
    let input: Record<string, unknown> = {};
    try { input = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* empty */ }
    if (!ORIENTATION.has(name)) return { name, input };
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: msg?.tool_calls });
    messages.push({ role: "tool", tool_call_id: call?.id ?? "call_0", content: cannedContext });
  }
  return null;
}

/**
 * Multi-turn runner: drive a full conversation, feeding a canned result back for
 * EVERY tool call so the model proceeds through a sequence. Returns the ordered
 * list of tool calls the model made. `resultFor` provides the canned tool output
 * (so later args can depend on earlier results — the real arg-correctness test).
 */
async function runConversation(
  systemPrompt: string,
  userText: string,
  tools: unknown[],
  resultFor: (name: string, input: Record<string, unknown>) => unknown,
  maxTurns = 8,
): Promise<Captured[]> {
  const calls: Captured[] = [];
  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText },
  ];
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];
    if (toolCalls.length === 0) return calls; // model answered with text → done
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls });
    for (const c of toolCalls) {
      const name = c.function?.name ?? "";
      let input: Record<string, unknown> = {};
      try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { /* empty */ }
      calls.push({ name, input });
      messages.push({ role: "tool", tool_call_id: c.id ?? `call_${calls.length}`, content: JSON.stringify(resultFor(name, input)) });
    }
  }
  return calls;
}

/** Parse mobile tools via the shared fixture so the compression transform can be
 *  validated against mobile's hand-written shape without a divergent parser. */
function mobileTools() {
  return parseMobileTools();
}

const SYS = "You are the Cairn AI assistant. Use the tools to act on the workspace; IDs are already known (workspaceId ws_1, projectId proj_1, columns col_todo/col_done/col_prog, note note_1='Auth'/note_5, card card_2='Login bug'/card_9). Never ask for IDs; call exactly the tool the user asks for.";

// Single-turn scenarios probe BOTH selection and argument correctness. `check`
// validates the captured args (the part schema compression could plausibly
// break). Deliberately weighted toward multi-field / nested / enum / date args.
const SCENARIOS: { ask: string; expect: string[]; check: (a: Record<string, unknown>) => boolean; note: string }[] = [
  {
    ask: "Find notes updated since 2025-01-01 that mention 'auth'.",
    expect: ["search_notes"],
    check: (a) => typeof a.updatedAfter === "string" && /2025-01-01/.test(a.updatedAfter as string),
    note: "updatedAfter ISO pattern stripped — must still emit a valid date",
  },
  {
    ask: "Create a task 'Ship v2' in the Todo column with high priority, due 2026-03-01.",
    expect: ["create_task"],
    check: (a) => a.columnId === "col_todo" && a.priority === "high" && typeof a.title === "string" && /2026-03-01/.test(String(a.dueDate ?? "")),
    note: "enum priority + id + due date",
  },
  {
    ask: "Move card card_9 to Done.",
    expect: ["update_task", "bulk_update_task_status"],
    check: (a) => (a.cardId === "card_9" || String(JSON.stringify(a.cardIds)).includes("card_9")) && (a.columnId === "col_done" || a.targetColumnId === "col_done"),
    note: "id + column",
  },
  {
    ask: "Suggest linking note note_1 ('Auth') to card card_2 ('Login bug').",
    expect: ["suggest_connections"],
    check: (a) => Array.isArray(a.actions) && (a.actions as { type?: string }[]).some((x) => x?.type === "link_note_card"),
    note: "nested actions[] w/ correct action type (348-tok schema)",
  },
  {
    ask: "Rename note note_5 to 'Roadmap 2026'.",
    expect: ["rename_note"],
    check: (a) => a.noteId === "note_5" && a.newTitle === "Roadmap 2026",
    note: "two required strings",
  },
  {
    ask: "Add an idea node titled 'Caching layer' with body 'use LRU' to the canvas in proj_1.",
    expect: ["create_idea_flow_node"],
    check: (a) => a.projectId === "proj_1" && a.type === "idea" && !!(a.data as { title?: string })?.title,
    note: "enum type + nested data.title (217-tok schema)",
  },
  {
    ask: "Block card card_9 on card card_2.",
    expect: ["update_task"],
    check: (a) => a.cardId === "card_9" && a.blockedBy === "card_2",
    note: "blockedBy dependency arg (no describe hint in aggressive)",
  },
  {
    ask: "Unlink note note_1 from card card_2.",
    expect: ["unlink_note_from_task"],
    check: (a) => a.noteId === "note_1" && a.cardId === "card_2",
    note: "two id args, distinct fields",
  },
  {
    ask: "Tag note note_5 with 'urgent' and 'q3' using ensure_note tagNames.",
    expect: ["ensure_note"],
    check: (a) => Array.isArray(a.tagNames) && (a.tagNames as string[]).includes("urgent"),
    note: "tagNames string array (no per-item describe)",
  },
  {
    ask: "Move notes note_1 and note_5 into the 'Research' folder.",
    expect: ["bulk_move_notes"],
    check: (a) => Array.isArray(a.noteIds) && (a.noteIds as string[]).length === 2 && a.folder === "Research",
    note: "id array + folder",
  },
  {
    ask: "Set the due date of card card_9 to 2026-05-01 and assign it to Alex.",
    expect: ["update_task"],
    check: (a) => a.cardId === "card_9" && /2026-05-01/.test(String(a.dueDate ?? "")) && String(a.assignee ?? "").includes("Alex"),
    note: "date + assignee multi-field update",
  },
  {
    ask: "Reindex the codebase at /Users/me/proj for project proj_1.",
    expect: ["codebase_reindex"],
    check: (a) => typeof a.folder === "string" && (a.folder as string).includes("/Users/me/proj"),
    note: "path arg",
  },
];

const hit = (n: string | null, want: string[]) => (n && want.includes(n) ? 1 : 0);
const argOk = (cap: Captured | null, want: string[], check: (a: Record<string, unknown>) => boolean) =>
  hit(cap?.name ?? null, want) && cap && check(cap.input) ? 1 : 0;

// LLM output is nondeterministic even at temp 0.2; a single flipped scenario
// per run is noise, not a regression. Assertions allow the compressed variant to
// trail full by at most this many points (a real regression trips it over
// repeated runs). The console table is the primary signal to eyeball.
const NONDETERMINISM_SLACK = 1;
const notWorseThan = (compressed: number, full: number) =>
  expect(compressed).toBeGreaterThanOrEqual(full - NONDETERMINISM_SLACK);

// ── Multi-turn scenarios ─────────────────────────────────────────────────────
// A sequence where later tool args depend on EARLIER tool results — the real
// stress test. `resultFor` returns canned outputs; `steps` scores each expected
// tool + arg check against the ordered calls the model actually made.
interface MultiTurn {
  name: string;
  ask: string;
  resultFor: (name: string, input: Record<string, unknown>) => unknown;
  steps: { expect: string[]; check: (a: Record<string, unknown>) => boolean; note: string }[];
}
const MULTI_TURN: MultiTurn[] = [
  {
    name: "search → open → append",
    ask: "Find the note about authentication, then append a line 'Reviewed 2026-01-05.' to it.",
    resultFor: (name) => {
      if (name === "search_notes" || name === "search_notes_semantic")
        return [{ id: "note_77", title: "Auth design", folder: "" }];
      if (name === "get_note") return { id: "note_77", title: "Auth design", content: "# Auth design\n..." };
      return { ok: true };
    },
    steps: [
      { expect: ["search_notes", "search_notes_semantic"], check: () => true, note: "find the note" },
      { expect: ["append_to_note"], check: (a) => a.id === "note_77" || a.noteId === "note_77", note: "append to the id returned by search" },
    ],
  },
  {
    name: "create task → move to In Progress",
    ask: "Create a task 'Fix flaky test' in Todo, then immediately move it to In Progress (col_prog).",
    resultFor: (name) => (name === "create_task" ? { id: "card_new1" } : { ok: true }),
    steps: [
      { expect: ["create_task"], check: (a) => a.columnId === "col_todo", note: "create in Todo" },
      { expect: ["update_task", "bulk_update_task_status"], check: (a) => (a.cardId === "card_new1" || String(JSON.stringify(a.cardIds)).includes("card_new1")) && (a.columnId === "col_prog" || a.targetColumnId === "col_prog"), note: "move the NEW id to In Progress" },
    ],
  },
  {
    name: "create note → link to card",
    ask: "Create a note titled 'Repro steps' in proj_1, then link it to card card_2.",
    resultFor: (name) => (name === "ensure_note" ? { id: "note_new2" } : { ok: true }),
    steps: [
      { expect: ["ensure_note"], check: (a) => a.projectId === "proj_1" && a.title === "Repro steps", note: "create the note" },
      { expect: ["link_note_to_task"], check: (a) => (a.noteId === "note_new2") && a.cardId === "card_2", note: "link NEW note id to the card" },
    ],
  },
];

describe.skipIf(!!process.env.CAIRN_SKIP_LIVE_TESTS)("tool-schema compression — selection + argument correctness (live)", () => {
  const full = fullOpenaiTools();
  const safe = safeOpenaiTools();
  const aggressive = aggressiveOpenaiTools();
  let up = false;

  beforeAll(async () => {
    up = await endpointUp();
    const fT = tok(JSON.stringify(full));
    const sT = tok(JSON.stringify(safe));
    const aT = tok(JSON.stringify(aggressive));
    console.log("\n=== DESKTOP TOOL PAYLOAD TOKENS ===");
    console.log(`FULL       : ${fT} tok`);
    console.log(`SAFE       : ${sT} tok  (saving ${fT - sT}, -${Math.round((1 - sT / fT) * 100)}%)`);
    console.log(`AGGRESSIVE : ${aT} tok  (saving ${fT - aT}, -${Math.round((1 - aT / fT) * 100)}%)`);
    // Mobile: schemas are hand-written (already lean — no pattern/bounds), so
    // only "aggressive" (drop nested descriptions) moves the needle there.
    const mFull = mobileTools();
    const mAggr = mFull.map((t) => ({ ...t, function: { ...t.function, parameters: compressSchema(t.function.parameters, "aggressive") } }));
    const mFT = tok(JSON.stringify(mFull));
    const mAT = tok(JSON.stringify(mAggr));
    console.log("=== MOBILE TOOL PAYLOAD TOKENS (name+desc only; params hand-written & lean) ===");
    console.log(`FULL       : ${mFT} tok`);
    console.log(`AGGRESSIVE : ${mAT} tok  (saving ${mFT - mAT}, -${Math.round((1 - mAT / mFT) * 100)}%)  [descriptions dominate mobile]`);
    if (!up) console.log(`\n[skip live] no LLM endpoint at ${BASE_URL} — set PROMPT_TEST_BASE_URL to run selection/arg checks.\n`);
    else console.log(`endpoint: ${BASE_URL}  model: ${MODEL}\n`);
  });

  it("compressed schemas are smaller than full", () => {
    expect(tok(JSON.stringify(safe))).toBeLessThan(tok(JSON.stringify(full)));
    expect(tok(JSON.stringify(aggressive))).toBeLessThan(tok(JSON.stringify(safe)));
  });

  it(
    "single-turn: compressed tool schemas preserve tool selection AND argument correctness",
    async () => {
      if (!up) return;
      type Variant = "full" | "safe" | "aggressive";
      const variants: Record<Variant, unknown[]> = { full, safe, aggressive };
      const score: Record<Variant, { sel: number; arg: number }> = {
        full: { sel: 0, arg: 0 }, safe: { sel: 0, arg: 0 }, aggressive: { sel: 0, arg: 0 },
      };

      for (const s of SCENARIOS) {
        const [f, sf, ag] = await Promise.all([
          taskToolCall(SYS, s.ask, variants.full),
          taskToolCall(SYS, s.ask, variants.safe),
          taskToolCall(SYS, s.ask, variants.aggressive),
        ]);
        const tally = (v: Variant, cap: Captured | null) => {
          score[v].sel += hit(cap?.name ?? null, s.expect);
          score[v].arg += argOk(cap, s.expect, s.check);
        };
        tally("full", f); tally("safe", sf); tally("aggressive", ag);

        const mark = (cap: Captured | null) => {
          const sel = hit(cap?.name ?? null, s.expect);
          return `${sel ? "S" : "·"}${argOk(cap, s.expect, s.check) ? "A" : "·"}`;
        };
        console.log(
          `full ${mark(f)}  safe ${mark(sf)}  aggr ${mark(ag)}`.padEnd(34),
          `[${s.expect.join("|")}]`.padEnd(30),
          `— ${s.note}`,
        );
      }

      const n = SCENARIOS.length;
      console.log(`\nSINGLE-TURN (${n} scenarios) — ${"variant".padEnd(12)} selection  arg-correct`);
      for (const v of ["full", "safe", "aggressive"] as Variant[]) {
        console.log(`${"".padEnd(24)}${v.padEnd(12)} ${String(score[v].sel).padStart(2)}/${n}       ${String(score[v].arg).padStart(2)}/${n}`);
      }
      console.log("");

      notWorseThan(score.safe.sel, score.full.sel);
      notWorseThan(score.safe.arg, score.full.arg);
      notWorseThan(score.aggressive.sel, score.full.sel);
      notWorseThan(score.aggressive.arg, score.full.arg);
    },
    240_000,
  );

  it(
    "multi-turn: compressed schemas preserve sequenced tool selection + args (later args depend on earlier results)",
    async () => {
      if (!up) return;
      type Variant = "full" | "safe" | "aggressive";
      const variants: Record<Variant, unknown[]> = { full, safe, aggressive };
      const score: Record<Variant, { sel: number; arg: number }> = {
        full: { sel: 0, arg: 0 }, safe: { sel: 0, arg: 0 }, aggressive: { sel: 0, arg: 0 },
      };
      let totalSteps = 0;

      for (const mt of MULTI_TURN) {
        totalSteps += mt.steps.length;
        const [f, sf, ag] = await Promise.all([
          runConversation(SYS, mt.ask, variants.full, mt.resultFor),
          runConversation(SYS, mt.ask, variants.safe, mt.resultFor),
          runConversation(SYS, mt.ask, variants.aggressive, mt.resultFor),
        ]);
        // Score each expected step against the ordered calls (first matching call
        // consumed per step, in order).
        const scoreSeq = (v: Variant, calls: Captured[]) => {
          let cursor = 0;
          const marks: string[] = [];
          for (const step of mt.steps) {
            let found: Captured | null = null;
            for (let i = cursor; i < calls.length; i++) {
              if (hit(calls[i].name, step.expect)) { found = calls[i]; cursor = i + 1; break; }
            }
            const sel = found ? 1 : 0;
            const arg = found && step.check(found.input) ? 1 : 0;
            score[v].sel += sel; score[v].arg += arg;
            marks.push(`${sel ? "S" : "·"}${arg ? "A" : "·"}`);
          }
          return marks.join(" ");
        };
        console.log(
          `full[${scoreSeq("full", f)}] safe[${scoreSeq("safe", sf)}] aggr[${scoreSeq("aggressive", ag)}]`.padEnd(48),
          `— ${mt.name}`,
        );
      }

      console.log(`\nMULTI-TURN (${totalSteps} steps) — ${"variant".padEnd(12)} step-sel  step-arg`);
      for (const v of ["full", "safe", "aggressive"] as Variant[]) {
        console.log(`${"".padEnd(24)}${v.padEnd(12)} ${String(score[v].sel).padStart(2)}/${totalSteps}     ${String(score[v].arg).padStart(2)}/${totalSteps}`);
      }
      console.log("");

      notWorseThan(score.safe.sel, score.full.sel);
      notWorseThan(score.safe.arg, score.full.arg);
      notWorseThan(score.aggressive.sel, score.full.sel);
      notWorseThan(score.aggressive.arg, score.full.arg);
    },
    240_000,
  );
});
