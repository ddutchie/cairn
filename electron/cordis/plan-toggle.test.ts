import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os"; import * as fs from "fs"; import * as path from "path";
import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-plan-toggle-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins")); // no user plugins in probe
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("plan toggle via /plan command", () => {
  it("commits plan state to the session log (foldable, durable)", async () => {
    const ctx = await getContext();
    const sessionId = `probe-plan-${Date.now()}`;
    const commands = (ctx as unknown as { commands?: { execute: (a: unknown, line: string, images: unknown[], s?: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } }> } }).commands;
    expect(commands?.execute).toBeTruthy();

    const { openCordisAgent } = await import("./run-cordis-coding");
    const handle = await openCordisAgent(ctx, {
      sessionId, cwd: tmp,
      llmConfig: { baseUrl: "http://localhost:1/v1", model: "m", apiKey: "k", provider: "openai" },
      signal: undefined,
    });
    const { foldPlanModeActive, getPlanModeActive } = await import("./plan-fold");
    const agent = (handle as { agent: { session: unknown } }).agent;

    try {
      expect(foldPlanModeActive(agent.session as never)).toBe(false); // starts inactive
      // Projection read agrees with the event fold at every step.
      expect(getPlanModeActive(ctx, agent.session as never)).toBe(false);
      const on = await commands!.execute!(agent, "/plan", [], new AbortController().signal);
      console.log("/plan:", JSON.stringify(on?.result ?? on)?.slice(0, 120));
      expect(foldPlanModeActive(agent.session as never)).toBe(true);
      expect(getPlanModeActive(ctx, agent.session as never)).toBe(true);

      const off = await commands!.execute!(agent, "/plan off", [], new AbortController().signal);
      console.log("/plan off:", JSON.stringify(off?.result ?? off)?.slice(0, 120));
      expect(foldPlanModeActive(agent.session as never)).toBe(false);
      expect(getPlanModeActive(ctx, agent.session as never)).toBe(false);
    } finally {
      try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
    }
  }, 60000);

  it("getPlanModeActive falls back to the event fold without a registry", async () => {
    const { getPlanModeActive } = await import("./plan-fold");
    const session = {
      events: [
        { type: "plan/mode", data: { active: true } },
        { type: "plan/mode", data: { active: false } },
      ],
    };
    // No registry on the ctx → fold decides (last wins → false).
    expect(getPlanModeActive({}, session as never)).toBe(false);
    expect(getPlanModeActive(undefined, session as never)).toBe(false);
    // Throwing stateOf → fold decides.
    const badCtx = { sessionProjections: { stateOf: () => { throw new Error("boom"); } } };
    expect(getPlanModeActive(badCtx, session as never)).toBe(false);
    // Registry wins when it answers with a boolean.
    const regCtx = { sessionProjections: { stateOf: () => ({ active: true, pending: false }) } };
    expect(getPlanModeActive(regCtx, session as never)).toBe(true);
    // Non-boolean projection state → fold decides.
    const emptyCtx = { sessionProjections: { stateOf: () => undefined } };
    expect(getPlanModeActive(emptyCtx, session as never)).toBe(false);
  });
});
