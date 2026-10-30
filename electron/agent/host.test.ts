import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHost, type HostDeps, type PromptRequest } from "./host";
import { presetRules } from "./rules";
import { makeHarness, makeTools } from "./test-harness";

const call = (name: string, args: Record<string, unknown>, id: string) => fauxToolCall(name, args as never, { id });
const toolUse = (...calls: ReturnType<typeof call>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const tick = () => new Promise((r) => setTimeout(r, 20));

async function setup(init: Partial<HostDeps> = {}) {
  const root = init.root ?? await mkdtemp(path.join(os.tmpdir(), "agent-host-"));
  const h = makeHarness();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: Array<{ channel: string; payload: any }> = [];
  const streamFn = h.opts().streamFn;
  const host = new AgentHost({
    send: (channel, payload) => sent.push({ channel, payload }),
    routeStream: () => ({ model: h.faux.getModel(), streamFn }),
    askTtlMs: 2_000,
    ...init,
    root,
  });
  const executed: Array<{ name: string; args: unknown }> = [];
  const req = (over: Partial<PromptRequest> = {}): PromptRequest => ({
    sessionId: "s1", prompt: "hello", cwd: "/ws",
    profile: { id: "coding", interactive: true, mode: "ask" },
    route: { baseUrl: "http://x", model: "m", api: "openai-completions" },
    systemPrompt: "sys", tools: makeTools(executed), ...over,
  });
  const of = (type: string) => sent.filter((s) => s.channel === "session:event" && s.payload.event.type === type);
  const proj = (kind: string) => sent.filter((s) => s.channel === "session:projection" && s.payload.kind === kind);
  return { root, h, host, sent, req, executed, of, proj };
}

describe("AgentHost", () => {
  it("runs a turn, forwards renderer events and persists the log", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("hi there")]);
    await t.host.prompt(t.req());
    expect(t.of("turn/start")).toHaveLength(1);
    expect(t.of("assistant/message")).toHaveLength(1);
    expect(t.of("turn/end")[0].payload.event.data.reason.kind).toBe("stop");
    expect(t.proj("title")[0].payload.data.title).toBe("hello");
    expect(await readdir(path.join(t.root, "s1"))).toContain("session.cairn.jsonl");
    expect(t.host.isRunning("s1")).toBe(false);
  });

  it("numbers renderer events in order", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("a")]);
    await t.host.prompt(t.req());
    const seqs = t.sent.filter((s) => s.channel === "session:event").map((s) => s.payload.event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("round-trips an approval through respondTool; a wrong nonce is refused", async () => {
    const t = await setup();
    t.h.faux.setResponses([toolUse(call("write_file", { path: "src/a.ts" }, "c1")), fauxAssistantMessage("done")]);
    const run = t.host.prompt(t.req());
    await tick();
    const ask = t.proj("approval").find((p) => p.payload.data.status === "required")!.payload.data;
    expect(t.host.pendingAsks("s1")).toHaveLength(1);
    expect(t.host.respondTool("s1", "c1", "wrong-nonce", { approved: true })).toBe(false);
    expect(t.host.respondTool("s1", "c1", undefined, { approved: true })).toBe(false);
    expect(t.host.respondTool("s1", "c1", ask.nonce, { approved: true })).toBe(true);
    await run;
    expect(t.executed.map((e) => e.name)).toEqual(["write_file"]);
    expect(t.proj("approval").some((p) => p.payload.data.status === "resolved")).toBe(true);
    expect(t.host.pendingAsks("s1")).toHaveLength(0);
  });

  it("an 'always allow' grant survives a restart because it is in the log", async () => {
    const t = await setup();
    t.h.faux.setResponses([toolUse(call("write_file", { path: "src/a.ts" }, "c1")), fauxAssistantMessage("ok")]);
    const run = t.host.prompt(t.req());
    await tick();
    t.host.respondTool("s1", "c1", t.proj("approval")[0].payload.data.nonce, { approved: true, grant: "session" });
    await run;

    const t2 = await setup({ root: t.root });
    t2.h.faux.setResponses([toolUse(call("write_file", { path: "src/b.ts" }, "c2")), fauxAssistantMessage("again")]);
    await t2.host.prompt(t2.req());
    expect(t2.proj("approval").filter((p) => p.payload.data.status === "required")).toHaveLength(0);
    expect(t2.executed.map((e) => e.name)).toEqual(["write_file"]);
  });

  it("restores conversation history after a restart", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("first answer")]);
    await t.host.prompt(t.req());
    const t2 = await setup({ root: t.root });
    t2.h.faux.setResponses([fauxAssistantMessage("second")]);
    await t2.host.prompt(t2.req({ prompt: "follow up" }));
    const loaded = await t2.host.loadMessages("s1");
    expect(loaded.messages.map((m) => [m.role, m.content])).toEqual([["user", "hello"], ["assistant", "first answer"], ["user", "follow up"], ["assistant", "second"]]);
  });

  it("rejects a second prompt while one is running and aborts cleanly", async () => {
    const t = await setup();
    t.h.faux.setResponses([toolUse(call("write_file", { path: "src/a.ts" }, "c1")), fauxAssistantMessage("never")]);
    const run = t.host.prompt(t.req());
    await tick();
    expect(t.host.runningIds()).toEqual(["s1"]);
    await expect(t.host.prompt(t.req())).rejects.toThrow(/busy/);
    t.host.abort("s1");
    await run;
    expect(t.of("turn/end").at(-1)!.payload.event.data.reason.kind).toBe("aborted");
    expect(t.host.isRunning("s1")).toBe(false);
  });

  it("replay shows tool calls with their results", async () => {
    const t = await setup({ globalRules: () => presetRules("workspace-edits") });
    t.h.faux.setResponses([toolUse(call("echo", { text: "x" }, "c1")), fauxAssistantMessage("done")]);
    await t.host.prompt(t.req());
    const { messages, usage } = await t.host.loadMessages("s1");
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls).toMatchObject([{ tool: "echo", callId: "c1", ok: true, output: "echo:x" }]);
    expect(assistant.content).toBe("done");
    expect(usage?.promptTokens).toBeGreaterThan(0);
  });

  it("reports each assistant message for usage accounting", async () => {
    const seen: Array<[string, number]> = [];
    const t = await setup({ onAssistantMessage: (id, m) => seen.push([id, m.usage.input]) });
    t.h.faux.setResponses([toolUse(call("echo", { text: "x" }, "c1")), fauxAssistantMessage("done")]);
    await t.host.prompt(t.req());
    expect(seen.map(([id]) => id)).toEqual(["s1", "s1"]);
  });

  it("a renamed title is pinned, survives a restart and wins over the derived one", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    await t.host.prompt(t.req());
    expect(await t.host.rename("s1", "  My chat  ")).toBe("My chat");
    expect(t.proj("title").at(-1)!.payload.data.title).toBe("My chat");
    const t2 = await setup({ root: t.root });
    expect(await t2.host.title("s1")).toBe("My chat");
    await t2.host.prompt(t2.req({ prompt: "another" }));
    expect(await t2.host.title("s1")).toBe("My chat");
    await expect(t.host.rename("s1", "   ")).rejects.toThrow();
  });

  it("destroy removes the log", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("x")]);
    await t.host.prompt(t.req());
    await t.host.destroy("s1");
    expect(await readdir(t.root)).toEqual([]);
    expect(await t.host.title("s1")).toBeNull();
  });
});
