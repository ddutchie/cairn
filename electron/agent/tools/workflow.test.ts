import { describe, expect, it } from "vitest";
import { runWorkflow, workflowTools } from "./workflow";
import type { SubagentDeps } from "./subagent";

const echo = async (p: string) => `did: ${p}`;

describe("runWorkflow", () => {
  it("fans out with agents(), combines the reports and returns the result", async () => {
    const out = await runWorkflow("const r = await agents(args.items.map((i) => 'check ' + i)); log('n', r.length); return r.join(' | ');", { items: ["a", "b"] }, echo);
    expect(out).toEqual({ result: "did: check a | did: check b", log: ["n 2"] });
  });
  it("runs agents in parallel", async () => {
    let live = 0, peak = 0;
    await runWorkflow("await agents(['x','y','z'])", undefined, async () => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 10)); live--; return ""; });
    expect(peak).toBe(3);
  });
  it("caps the agents per run and per call", async () => {
    await expect(runWorkflow("await agents(new Array(51).fill('x'))", undefined, echo)).rejects.toThrow(/at most 50/);
    await expect(runWorkflow("for (let i = 0; i < 101; i++) await agent('x')", undefined, echo)).rejects.toThrow(/at most 100/);
  });
  it("has no way to reach the host", async () => {
    await expect(runWorkflow("return require('fs')", undefined, echo)).rejects.toThrow(/require is not defined/);
    await expect(runWorkflow("return process.exit(1)", undefined, echo)).rejects.toThrow(/process is not defined/);
    await expect(runWorkflow("return eval('1')", undefined, echo)).rejects.toThrow();
    // Neither the helpers, their results nor their errors lead back to the host's Function constructor.
    const escapes = [
      "return agent.constructor.constructor('return process')()",
      "const p = agent('x'); return p.constructor.constructor('return process')()",
      "const r = await agents(['x']); return r.constructor.constructor('return process')()",
      "try { await agents(new Array(60).fill('x')) } catch (e) { return e.constructor.constructor('return process')() }",
      "return log.constructor.constructor('return process')()",
      "return this.constructor.constructor('return process')().pid",
    ];
    for (const code of escapes) await expect(runWorkflow(code, undefined, echo), code).rejects.toThrow(/Code generation|process is not defined|undefined/);
  });
  it("stops a script that never yields", async () => {
    await expect(runWorkflow("while (true) {}", undefined, echo)).rejects.toThrow(/timed out/i);
  }, 15_000);
});

function tools(texts: string[], reason = "stop") {
  const prompts: string[] = [];
  const deps: SubagentDeps = {
    run: async (_p, r) => { prompts.push(r.prompt); return { childId: `c${prompts.length}`, text: texts[prompts.length - 1] ?? "", reason }; },
    list: async () => [], interrupt: () => false, transcript: () => "",
  };
  const by = Object.fromEntries(workflowTools(deps).map((t) => [t.name, t]));
  return { by, prompts };
}
const text = (r: unknown) => String((r as { content: string }).content);

describe("workflow tool", () => {
  it("returns the script's result, and reports a failing script as an error", async () => {
    const t = tools(["alpha"]);
    expect(text(await t.by.workflow.execute({ script: "return await agent('go')" } as never, { sessionId: "s", callId: "c" } as never))).toBe('"alpha"');
    const bad = await t.by.workflow.execute({ script: "throw new Error('boom')" } as never, { sessionId: "s", callId: "c" } as never);
    expect(bad).toMatchObject({ isError: true });
  });
  it("is gated as EXEC", () => {
    expect(tools([]).by.workflow.risk({ script: "return 1" } as never)).toMatchObject({ class: "EXEC" });
  });
});

describe("ralph tool", () => {
  it("hands each round's summary to the next and stops at the marker", async () => {
    const t = tools(["did part one", "did part two RALPH_DONE"]);
    const out = text(await t.by.ralph.execute({ task: "migrate" } as never, { sessionId: "s", callId: "c" } as never));
    expect(out).toContain("Finished in 2 rounds");
    expect(t.prompts[1]).toContain("did part one");
    expect(t.prompts[1]).toContain("round 2");
  });
  it("stops at the round limit, bounded to 20", async () => {
    const t = tools([]);
    const out = text(await t.by.ralph.execute({ task: "x", maxRounds: 500 } as never, { sessionId: "s", callId: "c" } as never));
    expect(out).toContain("Stopped after 20 rounds");
    expect(t.prompts).toHaveLength(20);
  });
  it("reports a child that ended early", async () => {
    const r = await tools(["x"], "error").by.ralph.execute({ task: "x" } as never, { sessionId: "s", callId: "c" } as never);
    expect(r).toMatchObject({ isError: true });
  });
});
