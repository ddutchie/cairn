/**
 * Live end-to-end check of AgentHost with the real fs/bash tools and a real
 * model. Opt-in: CAIRN_LIVE_TESTS=1 (same overrides as provider.live.test.ts).
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { describe, expect, it } from "vitest";
import { endpointUp, LIVE_TESTS_ENABLED } from "../lib/bench-endpoint";
import { AgentHost } from "./host";
import { presetRules } from "./rules";
import { bashTool, fsTools, todoTool } from "./tools/index";

const BASE = process.env.AGENT_LIVE_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.AGENT_LIVE_MODEL ?? "claude-sonnet-4-5";
const KEY = process.env.AGENT_LIVE_API_KEY ?? "";
const up = LIVE_TESTS_ENABLED && (await endpointUp(BASE, KEY));

/** Wait for the first approval card and answer it; false if none appears in time. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function answerFirstAsk(t: { host: AgentHost; projections: (k: string) => Array<{ payload: any }> }, approved: boolean): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ask = t.projections("approval").find((p) => p.payload.data.status === "required");
    if (ask) return t.host.respondTool("live1", ask.payload.data.callId, ask.payload.data.nonce, { approved });
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!up)(`live host: ${MODEL} @ ${BASE}`, () => {
  async function setup(mode: "ask" | "yolo" = "ask") {
    const root = await mkdtemp(path.join(os.tmpdir(), "live-host-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "live-ws-"));
    await writeFile(path.join(cwd, "greeting.txt"), "hello from the workspace\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent: Array<{ channel: string; payload: any }> = [];
    const host = new AgentHost({
      root,
      send: (channel, payload) => sent.push({ channel, payload }),
      globalRules: () => presetRules("workspace-edits"),
      askTtlMs: 60_000,
    });
    const tools = [...fsTools({ cwd, rgPath }), bashTool({ cwd }), todoTool()];
    const req = (prompt: string) => ({
      sessionId: "live1", prompt, cwd, tools,
      profile: { id: "coding", interactive: true, mode, externalAlwaysAsks: true },
      route: { baseUrl: BASE, model: MODEL, apiKey: KEY, api: "openai-completions" as const, maxTokens: 2048 },
      systemPrompt: "You are a terse coding assistant. Use the tools; never invent file contents or command output.",
      maxSteps: 8,
    });
    const events = (type: string) => sent.filter((s) => s.channel === "session:event" && s.payload.event.type === type);
    const projections = (kind: string) => sent.filter((s) => s.channel === "session:projection" && s.payload.kind === kind);
    return { root, cwd, host, sent, req, events, projections };
  }

  it("reads a file, edits it inside the workspace without asking, and survives a restart", async () => {
    const t = await setup();
    await t.host.prompt(t.req("Read greeting.txt, then use the edit tool to change the word 'hello' to 'goodbye' in it. Then say done."));
    const calls = t.events("tool/call").map((e) => e.payload.event.data.name);
    expect(calls).toContain("read");
    expect(calls).toContain("edit");
    expect(await readFile(path.join(t.cwd, "greeting.txt"), "utf8")).toContain("goodbye from the workspace");
    expect(t.projections("approval").filter((p) => p.payload.data.status === "required")).toHaveLength(0);
    expect(t.events("turn/end").at(-1)!.payload.event.data.reason.kind).toBe("stop");

    // Restart: a new host over the same log remembers the conversation.
    const host2 = new AgentHost({ root: t.root, send: () => undefined, globalRules: () => presetRules("workspace-edits") });
    const replay = await host2.loadMessages("live1");
    expect(replay.messages[0]).toMatchObject({ role: "user" });
    expect(replay.messages.some((m) => m.toolCalls?.some((c) => c.tool === "edit" && c.ok))).toBe(true);
    await host2.prompt({ ...t.req("What word did you change 'hello' into? Answer with just that word."), tools: [] });
    const answer = host2.loadMessages("live1").then((r) => r.messages.at(-1)?.content ?? "");
    expect((await answer).toLowerCase()).toContain("goodbye");
  }, 120_000);

  it("asks before running a shell command, runs it once approved, and the output reaches the model", async () => {
    const t = await setup();
    const run = t.host.prompt(t.req("Run the shell command `echo cairn-live-$((20+22))` with the bash tool and tell me its output."));
    const approved = await answerFirstAsk(t, true);
    await run;
    expect(approved).toBe(true);
    const result = t.events("tool/result").find((e) => e.payload.event.data.name === "bash");
    expect(result?.payload.event.data.output).toContain("cairn-live-42");
    const last = (await t.host.loadMessages("live1")).messages.at(-1)!;
    expect(last.content).toContain("cairn-live-42");
  }, 150_000);

  it("a denied command does not run and the model is told why", async () => {
    const t = await setup();
    const run = t.host.prompt(t.req("Use bash to create the file denied.txt containing the word nope (e.g. `echo nope > denied.txt`)."));
    await answerFirstAsk(t, false);
    await run;
    await expect(readFile(path.join(t.cwd, "denied.txt"), "utf8")).rejects.toThrow();
    expect(t.events("tool/result").some((e) => e.payload.event.data.name === "bash" && e.payload.event.data.error)).toBe(true);
  }, 150_000);
});
