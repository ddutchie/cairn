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
    const fold = (await import("@deepseek-ai/dsh-plan-mode")).foldPlanMode as (e: readonly unknown[]) => boolean;
    const agent = (handle as { agent: { session: { events: readonly unknown[] } } }).agent;

    try {
      expect(fold(agent.session.events)).toBe(false); // starts inactive
      const on = await commands!.execute!(agent, "/plan", [], new AbortController().signal);
      console.log("/plan:", JSON.stringify(on?.result ?? on)?.slice(0, 120));
      expect(fold(agent.session.events)).toBe(true);

      const off = await commands!.execute!(agent, "/plan off", [], new AbortController().signal);
      console.log("/plan off:", JSON.stringify(off?.result ?? off)?.slice(0, 120));
      expect(fold(agent.session.events)).toBe(false);
    } finally {
      try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
    }
  }, 60000);
});
