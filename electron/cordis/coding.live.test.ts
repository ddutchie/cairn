import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import agentLoopPlugin from "@deepseek-ai/dsh-agent-loop";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// Default-export plugin objects (have .apply/.inject/.name)
import planModePlugin from "@deepseek-ai/dsh-plan-mode";
import sandboxLocalPlugin from "@deepseek-ai/dsh-sandbox-local";
import sandboxPolicyPlugin from "@deepseek-ai/dsh-sandbox-policy";
import fsSandboxPlugin from "@deepseek-ai/dsh-fs-sandbox";
// Named-export plugin objects
import { apply as fsObsApply, name as fsObsName } from "@deepseek-ai/dsh-fs-observation-policy";
import { apply as toolBashApply, inject as toolBashInject, name as toolBashName } from "@deepseek-ai/dsh-tool-bash";
import { apply as toolFsApply, inject as toolFsInject, name as toolFsName } from "@deepseek-ai/dsh-tool-fs";
import { apply as toolFsSearchApply, inject as toolFsSearchInject, name as toolFsSearchName } from "@deepseek-ai/dsh-tool-fs-search";
import { apply as toolStrApply, inject as toolStrInject, name as toolStrName } from "@deepseek-ai/dsh-tool-str-replace-editor";
import { apply as toolTodoApply, inject as toolTodoInject, name as toolTodoName } from "@deepseek-ai/dsh-tool-todo";
import { apply as shellEnvApply, inject as shellEnvInject, name as shellEnvName } from "@deepseek-ai/dsh-shell-env";
import { apply as agentInstApply, name as agentInstName } from "@deepseek-ai/dsh-agent-instructions";
import subprocessLocalPlugin from "@deepseek-ai/dsh-subprocess-local";
import bashLocalPlugin from "@deepseek-ai/dsh-bash-local";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

describe("cordis coding stack (gated on CORDIS_LIVE=1)", () => {
  it("mounts coding tools and runs a bash turn", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    const ctx = new Context();
    await ctx.plugin(sessionPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(systemPromptPlugin, { persona: "" });
    await ctx.plugin(agentPlugin);
    await ctx.plugin(toolsPlugin, { mode: "native" });
    // capability stack (dsh-base order)
    const plug = ctx.plugin.bind(ctx) as unknown as (p: unknown, c?: unknown) => Promise<unknown>;
    await plug(sandboxLocalPlugin);
    await plug(sandboxPolicyPlugin, { mode: "danger-full-access", workspaceRoot: "/tmp" });
    await plug(fsSandboxPlugin, { cwd: "/tmp" });
    await plug({ apply: fsObsApply, name: fsObsName });
    await plug(planModePlugin, { section: "You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Explore first. Do not edit files or run mutations." });
    await plug(subprocessLocalPlugin);
    await plug(bashLocalPlugin);
    await plug({ apply: shellEnvApply, inject: shellEnvInject as never, name: shellEnvName }, {});
    await plug({ apply: toolBashApply, inject: toolBashInject as never, name: toolBashName }, {});
    await plug({ apply: toolFsApply, inject: toolFsInject as never, name: toolFsName }, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 });
    await plug({ apply: toolFsSearchApply, inject: toolFsSearchInject as never, name: toolFsSearchName }, { globMaxResults: 1000, grepMaxMatches: 500, grepMaxLineBytes: 4096, searchMetaMaxBytes: 10000, rawOutputMaxBytes: 100000, graceMs: 100, stderrMaxBytes: 10000, timeoutMs: 30000, sampleOverCapGlobResults: false });
    await plug({ apply: toolStrApply, inject: toolStrInject as never, name: toolStrName }, { maxOutputChars: 16000 });
    await plug({ apply: toolTodoApply, inject: toolTodoInject as never, name: toolTodoName }, { allowParallelInProgress: true });
    await plug({ apply: agentInstApply, name: agentInstName }, { maxBytes: 65536, maxSourceBytes: 500000 });
    // model adapter
    await plug({ name: llmPiAiName, inject: llmPiAiInject as never, apply: llmPiAiApply }, {
      providers: { cairn: { api: "openai-responses", baseURL: BASE, displayName: "Cairn", models: [{ id: MODEL, contextWindow: 262144, maxTokens: 8192 }], apiKeyEnv: "CORDIS_DUMMY_KEY" } },
    });
    await plug(agentLoopPlugin, { agents: [] });

    const toolNames = ctx.tools.schemas().map((s) => s.name);
    console.log("CODING TOOLS:", toolNames.filter((n) => /bash|read|write|grep|glob|edit|ls|todo|plan|search|str_replace/.test(n)).join(", "));
    expect(toolNames).toContain("bash");

    const selection = { provider: "cairn", model: MODEL };
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId("sess-code"),
      meta: { cwd: "/tmp" },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    await agent.whenIdle();
    agent.followup(createUserMessage({ content: [{ type: "text", text: "Run the bash command 'echo hello-cordis' and report the output." }], source: { kind: "user" } }));
    await agent.whenIdle();

    let finalText = "";
    let bashCalled = false;
    for (const e of agent.session.events) {
      if (e.type === "assistant/message") {
        const t = e.data.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        if (t) finalText = t;
      }
      if (e.type === "tool/call") { if (String((e.data as any).name).includes("bash")) bashCalled = true; }
    }
    console.log("CODING FINAL:", finalText);
    expect(bashCalled).toBe(true);
    expect(finalText).toContain("hello-cordis");
  });
});
