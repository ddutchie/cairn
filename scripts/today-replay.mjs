#!/usr/bin/env node
/**
 * Replay a Today run outside the app.
 *
 * Takes a Today export (Today → Settings → Export data) and runs the same system prompt, prompt
 * and tools against an OpenAI-compatible endpoint. Connector calls are answered from the results
 * recorded in the export, so no app, sign-in or live connector is needed, and the brief tools
 * (today_read / today_upsert / today_remove / today_finish) are simulated in memory. Use it to try
 * a prompt or model change in seconds and see which calls the model makes and what brief it builds.
 *
 *   TODAY_LLM_BASE_URL=https://… TODAY_LLM_API_KEY=… node scripts/today-replay.mjs today-debug-….json
 *
 * Env:
 *   TODAY_LLM_BASE_URL  endpoint (default: the export's baseUrl). "/v1" is added unless present.
 *   TODAY_LLM_API_KEY   bearer key (never printed).
 *   TODAY_LLM_MODEL     model id (default: the export's model).
 *
 * Options:
 *   --prompt <file>        use this prompt instead of the recorded one
 *   --system <file>        use this system prompt instead of the recorded one
 *   --next-prompt          use the export's nextPrompt and nextSystemPrompt (what the build that
 *                          exported would send now) instead of what the last run was sent
 *   --fixture <match>=<file>  answer tools whose name contains <match> with the file's text
 *                          (repeatable; e.g. --fixture work_iq=fixtures/refusal.txt)
 *   --effort <low|medium|high|none>  reasoning effort (default: the export's; none sends nothing)
 *   --max-steps <n>        model turns before stopping (default 30)
 *   --out <file>           write the full transcript and the built brief as JSON
 *   --dry                  print what would be sent and stop (no endpoint needed)
 *
 * Exports made before tool schemas were recorded (`lastRunSetup.toolDefs`) still replay, with
 * an open schema per tool; the model then has only the tool names to go on.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--dry", "--next-prompt"].includes(args[i - 1])));
if (!file) {
  console.error("usage: node scripts/today-replay.mjs <today-debug-….json> [options]  (see the header of this file)");
  process.exit(2);
}

const exp = JSON.parse(fs.readFileSync(file, "utf8"));
const setup = exp.lastRunSetup;
if (!setup) { console.error("This export has no lastRunSetup: run Today once, then export again."); process.exit(2); }
const events = (exp.lastRun?.sessionEvents ?? []).map((e) => e.event ?? e);

// ── recorded tool results, by tool name, in call order ─────────────────────
const calls = new Map(); // callId → { name, args }
for (const ev of events) {
  if (ev.type !== "assistant/message") continue;
  for (const part of ev.message?.content ?? []) if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments });
}
const recorded = new Map(); // name → [{ args, text, used }]
for (const ev of events) {
  if (ev.type !== "tool/result") continue;
  const call = calls.get(ev.callId);
  const name = ev.name ?? call?.name;
  if (!name) continue;
  if (!recorded.has(name)) recorded.set(name, []);
  recorded.get(name).push({ args: JSON.stringify(call?.args ?? {}), text: ev.text ?? "", used: false });
}

const fixtures = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--fixture") continue;
  const [match, f] = String(args[i + 1] ?? "").split("=");
  if (!match || !f) { console.error("--fixture wants <match>=<file>"); process.exit(2); }
  fixtures.push({ match, text: fs.readFileSync(f, "utf8") });
}

/** The recorded answer for a call: an exact args match first, then the next unused one, then the last. */
function answerFromExport(name, argText) {
  const fx = fixtures.find((f) => name.includes(f.match));
  if (fx) return { text: fx.text, how: "fixture" };
  const list = recorded.get(name);
  if (!list?.length) return { text: "No result for this call was recorded in the export (replay).", how: "none" };
  const hit = list.find((r) => !r.used && r.args === argText) ?? list.find((r) => !r.used) ?? list[list.length - 1];
  hit.used = true;
  return { text: hit.text, how: hit.args === argText ? "recorded (same args)" : "recorded (other args)" };
}

// ── simulated brief tools ──────────────────────────────────────────────────
// The brief starts from the recorded today_read (what the run saw first) and every later read shows
// it as the run left it, so a model that reads after an update sees its own changes.
const LISTS = { decision: "needYou", todo: "needYou", draft: "drafts", fyi: "fyi", event: "events" };
const brief = { outline: { needYou: [], drafts: [], fyi: [], events: [] }, removed: [], finish: null };
try {
  const first = JSON.parse(recorded.get("today_read")?.[0]?.text ?? "{}");
  for (const list of Object.values(LISTS)) if (Array.isArray(first[list])) brief.outline[list] = first[list];
  brief.outline = { ...first, ...brief.outline };
} catch { /* no recorded read: start empty */ }
const allLists = () => [...new Set(Object.values(LISTS))];
const dropId = (id) => { for (const l of allLists()) brief.outline[l] = brief.outline[l].filter((x) => x.id !== id); };
function briefTool(name, a) {
  if (name === "today_read") return JSON.stringify(brief.outline);
  if (name === "today_upsert") {
    const lines = (a.items ?? []).map((item, i) => {
      const list = LISTS[item.lane];
      if (!list) return `${item.id ?? `item ${i + 1}`}: skipped, unknown lane.`;
      const id = item.id ?? `${item.start ?? ""}-${item.title ?? i}`;
      const at = brief.outline[list].findIndex((x) => x.id === id);
      const kept = at >= 0 ? brief.outline[list][at] : undefined;
      const next = { ...item, id, ...(kept?.carriedSince ? { carriedSince: kept.carriedSince } : {}) };
      dropId(id);
      if (at >= 0) brief.outline[list].splice(at, 0, next); else brief.outline[list].push(next);
      return `${id}: ${at >= 0 ? "updated" : "added"}.`;
    });
    return lines.join("\n");
  }
  if (name === "today_remove") {
    // As in the app: a carried item goes only with a reason.
    return (a.ids ?? []).map((id) => {
      const carried = allLists().some((l) => brief.outline[l].some((x) => x.id === id && x.carriedSince));
      if (carried && !String(a.reason ?? "").trim()) return `${id}: kept. It's carried from an earlier day; give the reason.`;
      dropId(id); brief.removed.push(id); return `${id}: removed.`;
    }).join("\n");
  }
  if (name === "today_finish") { brief.finish = a; return "Brief finished."; }
  return null;
}

// ── request ────────────────────────────────────────────────────────────────
const system = opt("--system") ? fs.readFileSync(opt("--system"), "utf8")
  : flag("--next-prompt") && exp.nextSystemPrompt ? exp.nextSystemPrompt
  : setup.systemPrompt;
const prompt = opt("--prompt") ? fs.readFileSync(opt("--prompt"), "utf8")
  : flag("--next-prompt") && exp.nextPrompt ? exp.nextPrompt
  : exp.lastRunPrompt;
const openSchema = { type: "object", properties: {}, additionalProperties: true };
const defs = setup.toolDefs ?? setup.tools.map((name) => ({ name, description: name, parameters: openSchema }));
if (!setup.toolDefs) console.warn("! This export has tool names only (made before schemas were recorded): tools get an open schema.");
const tools = defs.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? openSchema } }));

const model = process.env.TODAY_LLM_MODEL || setup.model;
const base = (process.env.TODAY_LLM_BASE_URL || setup.baseUrl || "").replace(/\/+$/, "");
// Built only when there is an endpoint: --dry needs none.
const url = !base ? "(no endpoint)" : /(^|\/)v\d+(\/|$)/.test(new URL(/^https?:\/\//.test(base) ? base : `https://${base}`).pathname) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
const effort = opt("--effort") ?? setup.reasoningEffort;
const maxSteps = Number(opt("--max-steps") ?? 30);

console.log(`model ${model} · ${url} · effort ${effort ?? "default"} · ${tools.length} tools · prompt ${prompt.length} chars`);
if (flag("--dry")) {
  console.log("\nTools:", tools.map((t) => t.function.name).join(", "));
  console.log("\nRecorded results:", [...recorded].map(([n, l]) => `${n} ×${l.length}`).join(", ") || "none");
  console.log("\nPrompt (start):\n" + prompt.slice(0, 1200));
  process.exit(0);
}
const key = process.env.TODAY_LLM_API_KEY;
if (!base) { console.error("Set TODAY_LLM_BASE_URL (the export has no baseUrl)."); process.exit(2); }

const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
const transcript = [];
const started = Date.now();
const short = (v, n = 160) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };

for (let step = 1; step <= maxSteps; step++) {
  const body = { model, messages, tools, max_tokens: setup.maxTokens ?? 8000 };
  if (effort && effort !== "none" && effort !== "off") body.reasoning_effort = effort;
  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) { console.error(`HTTP ${res.status}: ${short(await res.text(), 800)}`); process.exit(1); }
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
  const toolCalls = msg.tool_calls ?? [];
  const u = data.usage ?? {};
  console.log(`\n── step ${step} · ${((Date.now() - t0) / 1000).toFixed(1)}s · in ${u.prompt_tokens ?? "?"} out ${u.completion_tokens ?? "?"}${reasoning ? ` · thinking ${reasoning.length} chars` : ""}`);
  if (msg.content) console.log(`  says: ${short(msg.content, 400)}`);
  messages.push({ role: "assistant", content: msg.content ?? "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
  transcript.push({ step, content: msg.content, reasoning, toolCalls, usage: u });
  if (!toolCalls.length) break;
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    let a = {};
    try { a = JSON.parse(tc.function?.arguments || "{}"); } catch { /* left empty */ }
    const sim = briefTool(name, a);
    const { text, how } = sim !== null ? { text: sim, how: "simulated" } : answerFromExport(name, JSON.stringify(a));
    console.log(`  → ${name} ${short(a)}\n    ${how}: ${short(text, 200)}`);
    messages.push({ role: "tool", tool_call_id: tc.id, content: text });
    transcript.push({ step, tool: name, args: a, how, result: text });
  }
  if (brief.finish) break;
}

// ── result ─────────────────────────────────────────────────────────────────
console.log(`\n══ brief after ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (brief.finish) console.log(`headline: ${brief.finish.headline}\nlede: ${brief.finish.lede}`);
else console.log("(today_finish was never called)");
for (const list of allLists()) {
  const items = brief.outline[list];
  if (!items.length) continue;
  console.log(`\n${list} (${items.length})`);
  for (const it of items) console.log(`  - ${it.priority ? `[${it.priority}] ` : ""}${it.start ? `${it.start}${it.end ? `–${it.end}` : ""} ` : ""}${it.question ?? it.title ?? it.id}${it.carriedSince ? ` (since ${it.carriedSince})` : ""}`);
}
if (brief.removed.length) console.log(`\nremoved: ${brief.removed.join(", ")}`);
for (const src of brief.finish?.sources ?? []) console.log(`source ${src.name}: ${src.status}${src.note ? ` · ${src.note}` : ""}`);

const out = opt("--out");
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ model, url, effort, transcript, brief: { ...brief.outline, removed: brief.removed, finish: brief.finish } }, null, 2));
  console.log(`\nwrote ${out}`);
}
