/**
 * Mount tests for the persistent-shell stack: the six `terminal_*` model
 * tools + the `shell` backend register in CODING turns only (like
 * `tool-bash`), never on the chat (fs-chain-only) path. No live model —
 * mount + inspect the tool registry, then dispose.
 */
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { Context } from "@deepseek-ai/cordis";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import TerminalSessionService from "@deepseek-ai/dsh-terminal";
import { mountCodingStack, mountFsChain } from "./cordis-coding-tools";

const TERMINAL_TOOLS = [
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_signal",
  "terminal_close",
  "terminal_list",
];

function toolNames(ctx: Context): string[] {
  const tools = ctx.tools as unknown as {
    schemas(): Array<{ name?: string; function?: { name?: string } }>;
  };
  // Same mapping as the coding loop's tools diagnostic.
  return tools.schemas().map((s) => s.function?.name ?? s.name ?? "");
}

/** Minimal global/plugin surface both turn kinds share (mirrors getContext). */
async function baseContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(sessionPlugin);
  await ctx.plugin(llmPlugin);
  await ctx.plugin(systemPromptPlugin, { persona: "", includeHarnessIdentity: false });
  await ctx.plugin(agentPlugin);
  await ctx.plugin(toolsPlugin, { mode: "native" });
  const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection");
  await ctx.plugin(ProjectionRegistry as never, {} as never);
  await ctx.plugin(TerminalSessionService);
  return ctx;
}

describe("terminal stack mounting", () => {
  it("registers the shell backend + six terminal tools in coding turns", async () => {
    const ctx = await baseContext();
    const dispose = await mountCodingStack(ctx, { cwd: os.tmpdir(), sandboxMode: "danger-full-access" });
    try {
      const names = toolNames(ctx);
      for (const tool of TERMINAL_TOOLS) expect(names).toContain(tool);
      expect(names).toContain("bash");
      expect(ctx.terminals.listBackends()).toContain("shell");
    } finally {
      await dispose();
    }
  }, 60000);

  it("registers no terminal tools on the chat (fs-chain-only) path", async () => {
    const ctx = await baseContext();
    await mountFsChain(ctx, { cwd: os.tmpdir() });
    const names = toolNames(ctx);
    for (const tool of TERMINAL_TOOLS) expect(names).not.toContain(tool);
    expect(ctx.terminals.listBackends()).toEqual([]);
  }, 60000);

  it("excludes terminal tools from the automation-dev persona", async () => {
    const ctx = await baseContext();
    const dispose = await mountCodingStack(ctx, {
      cwd: os.tmpdir(),
      sandboxMode: "danger-full-access",
      role: "automation-dev",
    });
    try {
      const names = toolNames(ctx);
      for (const tool of TERMINAL_TOOLS) expect(names).not.toContain(tool);
      expect(names).not.toContain("bash");
    } finally {
      await dispose();
    }
  }, 60000);
});
