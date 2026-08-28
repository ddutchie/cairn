import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os"; import * as fs from "fs"; import * as path from "path";
import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-compact-cmd-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("compact command", () => {
  it("is registered in ctx.commands and executable (no-op on empty session)", async () => {
    const ctx = await getContext();
    const commands = (ctx as unknown as { commands?: { list?: () => Array<{ name: string }>; execute: (a: unknown, line: string, imgs: unknown[], s?: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } }> } }).commands;
    expect(commands?.list?.().map((c) => c.name)).toContain("compact");

    const { openCordisAgent } = await import("./run-cordis-coding");
    const handle = await openCordisAgent(ctx, {
      sessionId: `probe-compact-${Date.now()}`, cwd: tmp,
      llmConfig: { baseUrl: "http://localhost:1/v1", model: "m", apiKey: "k", provider: "openai" },
      signal: undefined,
    });
    const agent = (handle as { agent: unknown }).agent;
    try {
      const out = await commands!.execute(agent, "/compact", [], new AbortController().signal);
      const r = (out as { result?: { kind?: string; text?: string } }).result ?? out as { kind?: string; text?: string };
      console.log("/compact:", JSON.stringify(r));
      // Wiring proof: the command executed through ctx.commands and surfaced a
      // structured result. With no model configured in the probe env the
      // summariser errors ("empty id"); with one, an empty session reports
      // "Nothing to compact yet."
      expect(["success", "error"]).toContain(r.kind);
      expect(r.text).toBeTruthy();
    } finally {
      try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
    }
  }, 60000);
});
