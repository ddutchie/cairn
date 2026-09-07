/**
 * workflow-ralph tests — dsh-workflow seam (worker-thread engine, global) +
 * the `workflow` / `ralph` model tools (coding turns only).
 *
 * Proves (no live model, no child agents spawned):
 *  - mount: the real mountCodingStack registers `workflow` + `ralph` and the
 *    engine service is live; the chat (fs-chain-only) path registers neither;
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
import WorkerThreadWorkflowEngine from "@deepseek-ai/dsh-workflow-worker-thread";
import { WorkflowError } from "@deepseek-ai/dsh-workflow";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { mountCodingStack, mountFsChain } from "./cordis-coding-tools";

const ENGINE_CONFIG = {
  provider: "spawn",
  maxConcurrentAgents: 0,
  maxTotalAgents: 1000,
  maxItemsPerCall: 4096,
  syncTimeoutMs: 5000,
  disposeGraceMs: 5000,
};

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
  await ctx.plugin(systemPromptPlugin as never, { persona: "", includeHarnessIdentity: false } as never);
  await ctx.plugin(agentPlugin as never, {} as never);
  await ctx.plugin(toolsPlugin as never, { mode: "native" } as never);
  const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection");
  await ctx.plugin(ProjectionRegistry as never, {} as never);
  await ctx.plugin(subagentServicePlugin as never, {} as never);
  await ctx.plugin(
    { apply: spawnProviderApply, inject: spawnProviderInject, name: spawnProviderName } as never,
    { providerName: "spawn" } as never,
  );
  await ctx.plugin(WorkerThreadWorkflowEngine as never, ENGINE_CONFIG as never);
}

/** Full production composition: globals + engine + one coding turn. */
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
      // The engine seam is global (like the terminals registry); the model
      // tools are turn-scoped, so chat sees the seam but no tools.
      expect((ctx as unknown as { workflowEngine?: unknown }).workflowEngine).toBeDefined();
      const names = toolNames(ctx);
      expect(names).not.toContain("workflow");
      expect(names).not.toContain("ralph");
    } finally {
      await ctx.fiber.dispose();
    }
  }, 90000);
});

describe("workflow + ralph bounds (fail-closed, no runaway)", () => {
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
