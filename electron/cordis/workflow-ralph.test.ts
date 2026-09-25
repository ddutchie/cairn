/**
 * workflow-ralph tests — dsh-workflow seam (dsh-workflow-ptc engine over the
 * Node PTC runtime) + the `workflow` / `ralph` model tools. Since dsh 0.1.7
 * the engine injects the per-turn fs/subprocess/sandbox services, so engine
 * and tools all mount per coding turn.
 *
 * Proves (no live model, no child agents spawned):
 *  - mount: the real mountCodingStack registers `workflow` + `ralph` and the
 *    engine service is live; the chat (fs-chain-only) path mounts none of it;
 *  - fail-closed: an unparseable script becomes an isError tool result
 *    (SCRIPT_PARSE before any child starts);
 *  - bounded iteration (no double-runaway): ralph rejects a model-requested
 *    maxRounds above the 256 deployment ceiling, and the engine rejects a
 *    maxTotalAgents above the 1000 run backstop — both synchronously, before
 *    any agent starts.
 */
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { Context } from "@deepseek-ai/cordis";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import subagentServicePlugin from "@deepseek-ai/dsh-subagent";
import { apply as spawnProviderApply, inject as spawnProviderInject, name as spawnProviderName } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { WorkflowError } from "@deepseek-ai/dsh-workflow";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { mountCodingStack, mountFsChain } from "./cordis-coding-tools";

function toolNames(ctx: Context): string[] {
  const tools = ctx.tools as unknown as {
    schemas(): Array<{ name?: string; function?: { name?: string } }>;
  };
  return tools.schemas().map((s) => s.function?.name ?? s.name ?? "");
}

let counter = 0;
function callId(): ReturnType<typeof ToolCallId> {
  counter += 1;
  return ToolCallId(`workflow-test-${counter}`);
}

/** Globals mirror coding.live.test.ts so mountCodingStack resolves headless. */
async function mountGlobals(ctx: Context): Promise<void> {
  await ctx.plugin(sessionPlugin as never, {} as never);
  await ctx.plugin(llmPlugin as never, {} as never);
  await ctx.plugin(systemPromptPlugin as never, { personaPrefix: "", includeHarnessIdentity: false } as never);
  await ctx.plugin(agentPlugin as never, {} as never);
  await ctx.plugin(toolsPlugin as never, { mode: "native" } as never);
  const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection");
  await ctx.plugin(ProjectionRegistry as never, {} as never);
  await ctx.plugin(subagentServicePlugin as never, {} as never);
  await ctx.plugin(
    { apply: spawnProviderApply, inject: spawnProviderInject, name: spawnProviderName } as never,
    { providerName: "spawn" } as never,
  );
}

/** Full production composition: globals + one coding turn (engine included). */
async function codingContext(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await mountGlobals(ctx);
  const disposeCoding = await mountCodingStack(ctx, { cwd: os.tmpdir(), sandboxMode: "danger-full-access" });
  return {
    ctx,
    dispose: async () => {
      await disposeCoding();
      await ctx.fiber.dispose();
    },
  };
}

function resultText(out: { content: Array<{ type?: string; text?: string }> }): string {
  return out.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

describe("workflow + ralph mounting", () => {
  it("registers the engine + workflow/ralph tools in coding turns", async () => {
    const { ctx, dispose } = await codingContext();
    try {
      const engine = (ctx as unknown as { workflowEngine?: unknown }).workflowEngine;
      expect(engine).toBeDefined();
      const names = toolNames(ctx);
      expect(names).toContain("workflow");
      expect(names).toContain("ralph");
    } finally {
      await dispose();
    }
  }, 90000);

  it("registers no workflow tools on the chat (fs-chain-only) path", async () => {
    const ctx = new Context();
    try {
      await mountGlobals(ctx);
      await mountFsChain(ctx, { cwd: os.tmpdir() });
      // Engine and model tools are coding-turn scoped; chat sees neither.
      expect((ctx as unknown as { workflowEngine?: unknown }).workflowEngine).toBeUndefined();
      const names = toolNames(ctx);
      expect(names).not.toContain("workflow");
      expect(names).not.toContain("ralph");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 90000);
});

describe("workflow + ralph bounds (fail-closed, no runaway)", () => {
  it("runs a script end-to-end in the sandboxed PTC process", async () => {
    const { ctx, dispose } = await codingContext();
    try {
      const engine = (ctx as unknown as {
        workflowEngine: { start: (req: unknown) => { result: Promise<unknown>; dispose(): Promise<void> } };
      }).workflowEngine;
      const run = engine.start({
        script: "log('hello'); return { answer: 41 + 1 }",
        meta: { name: "smoke", description: "no-agent smoke run" },
        parent: { session: (ctx as unknown as { sessions: { create(): unknown } }).sessions.create() },
      });
      try {
        expect(await run.result).toMatchObject({ value: { answer: 42 } });
      } finally {
        await run.dispose();
      }
    } finally {
      await dispose();
    }
  }, 90000);

  it("fails a malformed script closed (SCRIPT_PARSE, no child starts)", async () => {
    const { ctx, dispose } = await codingContext();
    try {
      const out = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: callId(),
        name: "workflow",
        arguments: {
          script: "export const meta = { name: \"oops\" }",
          meta: { name: "bad-script", description: "meta-in-body slip" },
        },
        agent: {} as never,
      });
      expect(out.isError).toBe(true);
      expect(resultText(out)).toMatch(/meta rides/i);
    } finally {
      await dispose();
    }
  }, 90000);

  it("ralph rejects maxRounds above the 256 deployment ceiling", async () => {
    const { ctx, dispose } = await codingContext();
    try {
      const out = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: callId(),
        name: "ralph",
        arguments: { objective: "Do nothing.", maxRounds: 257 },
        agent: {} as never,
      });
      expect(out.isError).toBe(true);
      expect(resultText(out)).toMatch(/exceeds the deployment ceiling 256/);
    } finally {
      await dispose();
    }
  }, 90000);

  it("engine rejects maxTotalAgents above the 1000 run backstop", async () => {
    const { ctx, dispose } = await codingContext();
    try {
      const engine = (ctx as unknown as {
        workflowEngine: { start: (req: unknown) => unknown };
      }).workflowEngine;
      let thrown: unknown;
      try {
        engine.start({
          script: "return 1",
          meta: { name: "over-cap", description: "cap probe" },
          maxTotalAgents: 1001,
          parent: {},
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkflowError);
      expect((thrown as { code?: string }).code).toBe("INVALID_ARGUMENT");
      expect(String((thrown as Error).message)).toMatch(/exceeds the engine ceiling/);
    } finally {
      await dispose();
    }
  }, 90000);
});
