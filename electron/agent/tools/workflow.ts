/**
 * workflow / ralph: orchestration over subagents.
 *  - `workflow` runs a short async JS script that fans work out with `agent()` / `agents()`.
 *  - `ralph` repeats one task in fresh subagents, handing each round's summary to the next, until done.
 * Both only ever start subagents; the script has no filesystem, network or process access.
 */
import vm from "node:vm";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import type { SubagentDeps } from "./subagent";
import { clampMiddle, fail, ok } from "./schema";

const SYNC_TIMEOUT_MS = 5_000;
const MAX_AGENTS_PER_RUN = 100;
const MAX_AGENTS_PER_CALL = 50;
const MAX_RESULT_CHARS = 50_000;
const DONE = "RALPH_DONE";
const DEFAULT_ROUNDS = 5;
const MAX_ROUNDS = 20;
const MAX_HANDOFF_CHARS = 16_384;

type Runner = (prompt: string) => Promise<string>;

/**
 * Run `script` as the body of an async function with the orchestration helpers as its only globals.
 * Nothing from this realm is reachable from the script: the host functions only trade JSON strings and
 * never throw, and the script-side wrappers (built inside the context) turn them back into values and errors.
 */
export async function runWorkflow(script: string, args: unknown, run: Runner): Promise<unknown> {
  let started = 0;
  const logs: string[] = [];
  const ok = (value: unknown) => JSON.stringify({ value: value ?? null });
  const bad = (err: unknown) => JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  const start = async (prompt: string): Promise<string> => {
    if (++started > MAX_AGENTS_PER_RUN) throw new Error(`A workflow can start at most ${MAX_AGENTS_PER_RUN} agents.`);
    return run(prompt);
  };
  const hostAgents = async (json: string): Promise<string> => {
    try {
      const prompts = JSON.parse(json) as string[];
      if (!Array.isArray(prompts) || prompts.length > MAX_AGENTS_PER_CALL) throw new Error(`agents() takes an array of at most ${MAX_AGENTS_PER_CALL} prompts.`);
      return ok(await Promise.all(prompts.map((p) => start(String(p)))));
    } catch (err) { return bad(err); }
  };
  const hostAgent = async (prompt: string): Promise<string> => { try { return ok(await start(String(prompt))); } catch (err) { return bad(err); } };
  const hostLog = (line: string): void => { logs.push(String(line)); };

  // A null-prototype sandbox, so `this.constructor` inside the script is not this realm's Object.
  const context = vm.createContext(Object.assign(Object.create(null), { __agent: hostAgent, __agents: hostAgents, __log: hostLog, __args: JSON.stringify(args ?? null) }), { codeGeneration: { strings: false, wasm: false } });
  // The helpers are built in one scope and the script runs in another, so the script cannot see the host bindings.
  const helpers = vm.runInContext(`(() => {
    const host = { agent: __agent, agents: __agents, log: __log, args: __args };
    for (const k of ["__agent", "__agents", "__log", "__args"]) delete globalThis[k];
    const unwrap = (json) => { const r = JSON.parse(json); if (r.error !== undefined) throw new Error(r.error); return r.value; };
    return [
      async (prompt) => unwrap(await host.agent(String(prompt))),
      async (prompts) => unwrap(await host.agents(JSON.stringify(prompts))),
      (...v) => host.log(v.map(String).join(" ")),
      JSON.parse(host.args),
    ];
  })()`, context, { timeout: SYNC_TIMEOUT_MS }) as unknown[];
  // The call itself runs under the synchronous timeout, so a script that never yields is stopped.
  context.__run = vm.runInContext(`(async (agent, agents, log, args) => {\n${script}\n})`, context);
  context.__helpers = helpers;
  const result = await vm.runInContext("__run(...__helpers)", context, { timeout: SYNC_TIMEOUT_MS });
  return logs.length ? { result, log: logs } : result;
}

export function workflowTools(deps: SubagentDeps): AgentTool[] {
  return [
    defineTool({
      name: "workflow",
      description: `Orchestrate many subagents with a short JavaScript program. The script is the body of an async function; it may use \`await agent(prompt)\` (one subagent, returns its report), \`await agents([prompts])\` (in parallel), \`args\`, \`log(...)\`, and must \`return\` a JSON-serialisable result. Up to ${MAX_AGENTS_PER_RUN} subagents per run. Use it to map a job over many items, then combine the reports.`,
      parameters: Type.Object({ script: Type.String(), args: Type.Optional(Type.Any({ description: "Passed to the script as `args`." })) }),
      risk: (a) => ({ class: "EXEC", command: a.script.slice(0, 200) }),
      preview: (a) => a.script,
      async execute(a, ctx) {
        try {
          const out = await runWorkflow(a.script, a.args, async (prompt) => {
            const r = await deps.run(ctx.sessionId, { prompt, signal: ctx.signal });
            if (r.reason !== "stop") throw new Error(`Subagent ${r.childId} ended early (${r.reason}).`);
            return r.text;
          });
          return ok(clampMiddle(JSON.stringify(out, null, 2) ?? "undefined", MAX_RESULT_CHARS));
        } catch (err) {
          return fail(`Workflow failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    defineTool({
      name: "ralph",
      description: `Work on one task in repeated rounds, each in a fresh subagent that sees the previous round's summary, until a round reports the task finished (it ends its report with ${DONE}) or the round limit is reached. Use it for long iterative jobs that outgrow one context.`,
      parameters: Type.Object({
        task: Type.String(),
        maxRounds: Type.Optional(Type.Number({ description: `Default ${DEFAULT_ROUNDS}, at most ${MAX_ROUNDS}.` })),
      }),
      risk: () => ({ class: "READ" }),
      preview: (a) => a.task,
      async execute(a, ctx) {
        const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.floor(a.maxRounds ?? DEFAULT_ROUNDS)));
        let handoff = "";
        for (let round = 1; round <= rounds; round++) {
          const prompt = `${a.task}\n\nThis is round ${round} of at most ${rounds}. ${handoff ? `Previous rounds' summary:\n${handoff}\n\n` : ""}Make progress, then end with a short summary of what is done and what remains. If the task is completely finished, end your report with ${DONE}.`;
          const r = await deps.run(ctx.sessionId, { prompt, signal: ctx.signal });
          if (r.reason !== "stop") return fail(`Round ${round} ended early (${r.reason}).${handoff ? `\n\nSummary so far:\n${handoff}` : ""}`);
          handoff = clampMiddle(r.text.replace(DONE, "").trim(), MAX_HANDOFF_CHARS);
          if (r.text.includes(DONE)) return ok(`Finished in ${round} round${round === 1 ? "" : "s"}.\n\n${handoff}`);
        }
        return ok(`Stopped after ${rounds} rounds without a completion marker.\n\n${handoff}`);
      },
    }),
  ];
}
