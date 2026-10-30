import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHost, type HostDeps, type PromptRequest } from "./host";
import { presetRules } from "./rules";
import { subagentTools } from "./tools/subagent";
import { makeHarness, makeTools } from "./test-harness";

const call = (name: string, args: Record<string, unknown>, id: string) => fauxToolCall(name, args as never, { id });
const toolUse = (...calls: ReturnType<typeof call>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const tick = () => new Promise((r) => setTimeout(r, 20));
/** Wait for a condition instead of guessing how long the machine needs. */
const until = async (cond: () => boolean, ms = 3_000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await tick(); };

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
    await until(() => t.host.runningIds().length > 0);
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

  it("sends attached images with the prompt and logs them for replay", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("nice")]);
    await t.host.prompt(t.req({ images: [{ mediaType: "image/png", data: "AAAA", name: "a.png" }] }));
    const reopened = new AgentHost({ root: t.root, send: () => {}, routeStream: () => ({ model: t.h.faux.getModel(), streamFn: t.h.opts().streamFn }) });
    const first = (await reopened.loadMessages("s1")).messages[0];
    expect(first).toMatchObject({ role: "user", content: "hello" });
    t.h.faux.setResponses([fauxAssistantMessage("again")]);
    await reopened.prompt(t.req({ prompt: "and now?" }));
    const log = await (await import("node:fs/promises")).readFile(path.join(t.root, "s1", "session.cairn.jsonl"), "utf8");
    expect(log).toContain('"images":[{"mediaType":"image/png","data":"AAAA","name":"a.png"}]');
  });

  it("compacts on demand, logging and projecting the compaction", async () => {
    const t = await setup();
    for (const text of ["one", "two", "three"]) {
      t.h.faux.setResponses([fauxAssistantMessage(`reply to ${text}`)]);
      await t.host.prompt(t.req({ prompt: text.repeat(10_000) }));
    }
    t.h.faux.setResponses([fauxAssistantMessage("a summary")]);
    expect(await t.host.compact("s1", "/ws", t.req().route)).toBe(true);
    expect(t.proj("compact-result")[0].payload.data.summary).toBe("a summary");
    expect(t.proj("compact").at(-1)?.payload.data).toMatchObject({ status: "end", auto: false });
  });

  it("refuses to compact a session that is mid-turn", async () => {
    const t = await setup();
    t.h.faux.setResponses([fauxAssistantMessage("slow")]);
    const running = t.host.prompt(t.req());
    await expect(t.host.compact("s1", "/ws", t.req().route)).rejects.toThrow(/busy/);
    await running;
  });

  describe("subagents", () => {
    async function withSubagents() {
      const t = await setup();
      const childTools = makeTools(t.executed);
      const deps = {
        run: async (parent: string, r: { childId?: string; prompt: string }) => {
          const childId = r.childId ?? `${parent}.sub-${Math.random().toString(16).slice(2, 8)}`;
          const out = await t.host.prompt(t.req({ sessionId: childId, parentSession: parent, prompt: r.prompt, tools: childTools }));
          return { childId, ...out };
        },
        list: (parent: string) => t.host.listChildren(parent),
        interrupt: () => false,
        transcript: (parent: string) => t.host.transcript(parent),
      };
      const parentTools = [...makeTools(t.executed), ...subagentTools(deps)];
      return { ...t, parentTools };
    }

    it("runs a child in its own log and returns its report to the parent", async () => {
      const t = await withSubagents();
      t.h.faux.setResponses([
        toolUse(call("subagent", { description: "look around", prompt: "find the answer" }, "c1")),
        fauxAssistantMessage("the answer is 42"),
        fauxAssistantMessage("the subagent says 42"),
      ]);
      await t.host.prompt(t.req({ tools: t.parentTools }));

      const result = t.of("tool/result")[0].payload.event.data;
      expect(result.output).toContain("the answer is 42");
      const traces = t.proj("subagent-trace").map((p) => p.payload.data);
      expect(traces.map((d) => d.trace)).toEqual(expect.arrayContaining(["status", "usage"]));
      expect(traces.every((d) => d.parentSession === "s1")).toBe(true);
      expect(traces.find((d) => d.status === "start")).toMatchObject({ instruction: "find the answer" });
      expect(traces.find((d) => d.status === "done")).toBeTruthy();

      const children = await t.host.listChildren("s1");
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ running: false, label: "find the answer" });
      expect((await readdir(t.root)).filter((n) => n.startsWith("s1.sub-"))).toHaveLength(1);
      // The child's own turn never shows up as a parent turn.
      expect(t.of("turn/start")).toHaveLength(1);
      expect(t.proj("title")).toHaveLength(1);
    });

    it("asks through the parent session, so one approval card answers it", async () => {
      const t = await withSubagents();
      t.h.faux.setResponses([
        toolUse(call("subagent", { description: "write it", prompt: "write a.ts" }, "c1")),
        toolUse(call("write_file", { path: "/ws/a.ts" }, "w1")),
        fauxAssistantMessage("wrote it"),
        fauxAssistantMessage("done"),
      ]);
      const running = t.host.prompt(t.req({ tools: t.parentTools }));
      await until(() => t.host.pendingAsks("s1").length > 0);
      const ask = t.host.pendingAsks("s1")[0];
      expect(ask).toMatchObject({ sessionId: "s1", callId: "w1", tool: "write_file" });
      expect(t.host.respondTool("s1", "w1", ask.nonce, { approved: true })).toBe(true);
      await running;
      expect(t.executed.map((e) => e.name)).toContain("write_file");
      const approvals = t.proj("approval").map((p) => p.payload.data);
      expect(approvals.find((a) => a.status === "required")).toMatchObject({ callId: "w1", sessionId: "s1" });
    });

    it("lets `delegate` see the conversation and `send_message` continue a child", async () => {
      const t = await withSubagents();
      t.h.faux.setResponses([
        toolUse(call("delegate", { description: "review", prompt: "review it" }, "c1")),
        fauxAssistantMessage("looks fine"),
        fauxAssistantMessage("parent done"),
      ]);
      await t.host.prompt(t.req({ prompt: "ship the feature", tools: t.parentTools }));
      const [child] = await t.host.listChildren("s1");
      const first = (await t.host.loadMessages(child.id)).messages[0].content;
      expect(first).toContain("<parent_conversation>");
      expect(first).toContain("ship the feature");

      t.h.faux.setResponses([
        toolUse(call("send_message", { id: child.id, message: "and the tests?" }, "c2")),
        fauxAssistantMessage("tests pass"),
        fauxAssistantMessage("parent again"),
      ]);
      await t.host.prompt(t.req({ prompt: "follow up", tools: t.parentTools }));
      expect(t.of("tool/result").at(-1)?.payload.event.data.output).toContain("tests pass");
      expect((await t.host.loadMessages(child.id)).messages.filter((m) => m.role === "user")).toHaveLength(2);
    });

    it("deletes a session's subagents with it", async () => {
      const t = await withSubagents();
      t.h.faux.setResponses([toolUse(call("subagent", { description: "x", prompt: "y" }, "c1")), fauxAssistantMessage("r"), fauxAssistantMessage("ok")]);
      await t.host.prompt(t.req({ tools: t.parentTools }));
      await t.host.destroy("s1");
      expect(await readdir(t.root)).toEqual([]);
    });
  });
});
