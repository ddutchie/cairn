// Live-mounted plugin fibers expose dsh services through the ambient
// `ctx.<name>` shape; probes here read into those via `any` rather than
// re-declaring dsh's service interfaces in test code.
/* eslint-disable @typescript-eslint/no-explicit-any */
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

import { mountCodingStack } from "./cordis-coding-tools";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

describe.skipIf(process.env.CORDIS_LIVE !== "1")("cordis coding stack (gated on CORDIS_LIVE=1; SKIPPED by default)", () => {
  it("mounts coding tools via mountCodingStack and runs a bash turn", async () => {
    const ctx = new Context();
    await ctx.plugin(sessionPlugin);
    await ctx.plugin(llmPlugin);
    await ctx.plugin(systemPromptPlugin, { persona: "", includeHarnessIdentity: false });
    await ctx.plugin(agentPlugin);
    await ctx.plugin(toolsPlugin, { mode: "native" });

    // The extracted coding capability stack (step 2a).
    const disposeCoding = await mountCodingStack(ctx, { cwd: "/tmp" });

    const plug = ctx.plugin.bind(ctx) as unknown as (p: unknown, c?: unknown) => Promise<unknown>;
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
    for (const e of agent.session.snapshotEvents()) {
      if (e.type === "assistant/message") {
        const t = e.data.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        if (t) finalText = t;
      }
      if (e.type === "tool/call") { if (String((e.data as any).name).includes("bash")) bashCalled = true; }
    }
    console.log("CODING FINAL:", finalText);
    disposeCoding();
    expect(bashCalled).toBe(true);
    expect(finalText).toContain("hello-cordis");
  });
});
