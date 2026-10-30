import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./events";
import type { Gate } from "./gate";
import { runTurn } from "./loop";
import { repairInterrupted } from "./repair";
import { createReviewerState, type Reviewer } from "./reviewer";
import { presetRules, type Rule } from "./rules";
import { defineTool } from "./tools";
import { Type } from "@earendil-works/pi-ai";
import { drive, makeHarness, makeTools, ofType, toolResults, types, type Harness } from "./test-harness";

const call = (name: string, args: Record<string, unknown>, id: string) => fauxToolCall(name, args as never, { id });
const toolUse = (...calls: ReturnType<typeof call>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

/** Approve/deny every ask as it appears. */
const answer = (gate: Gate, decision: { approved: boolean; grant?: "tool" | "command" }) => (ev: AgentEvent) => {
  if (ev.type === "approval/asked") gate.resolve(ev.ask.sessionId, ev.ask.callId, ev.ask.nonce, decision);
};

const textOfResult = (h: Harness, i = 0) => {
  const r = toolResults(h.history)[i];
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};

describe("runTurn: basics", () => {
  it("streams a plain answer and records history", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("hello there")]);
    const events = await drive(runTurn(h.opts()));
    const t = types(events);
    expect(t[0]).toBe("turn/start");
    expect(t[1]).toBe("user/message");
    expect(t).toContain("assistant/delta");
    expect(t.at(-2)).toBe("assistant/message");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
    expect(ofType(events, "assistant/delta").map((e) => e.text).join("")).toBe("hello there");
    expect(h.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs a READ tool without asking and feeds the result back to the model", async () => {
    const h = makeHarness();
    let seen: Message[] = [];
    h.faux.setResponses([
      toolUse(call("echo", { text: "hi" }, "c1")),
      (ctx) => { seen = ctx.messages; return fauxAssistantMessage("done"); },
    ]);
    const events = await drive(runTurn(h.opts()));
    expect(types(events)).not.toContain("approval/asked");
    expect(ofType(events, "tool/result")[0]).toMatchObject({ callId: "c1", text: "echo:hi", isError: false });
    expect(seen.some((m) => m.role === "toolResult")).toBe(true);
    expect(h.executed).toEqual([{ name: "echo", args: { text: "hi" } }]);
  });

  it("emits tool/call before any approval or result for that call", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("write_file", { path: "a.ts" }, "c1")), fauxAssistantMessage("ok")]);
    const t = types(await drive(runTurn(h.opts()), answer(h.gate, { approved: true })));
    expect(t.indexOf("tool/call")).toBeLessThan(t.indexOf("approval/asked"));
    expect(t.indexOf("approval/asked")).toBeLessThan(t.indexOf("approval/decided"));
    expect(t.indexOf("approval/decided")).toBeLessThan(t.indexOf("tool/result"));
  });

  it("stops at maxSteps", async () => {
    const h = makeHarness();
    h.faux.setResponses(Array.from({ length: 5 }, (_, i) => toolUse(call("echo", { text: String(i) }, `c${i}`))));
    const events = await drive(runTurn(h.opts({ maxSteps: 2 })));
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "max-steps" });
  });

  it("reports a failed model request", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid api key" })]);
    const events = await drive(runTurn(h.opts()));
    expect(ofType(events, "error")[0].message).toContain("invalid api key");
    expect(types(events)).not.toContain("retry");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "error" });
  });
});

describe("runTurn: retry and overflow", () => {
  const fail = (msg: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage: msg });
  const noWait = async () => {};

  it("retries a transient failure before any output and then succeeds", async () => {
    const h = makeHarness();
    h.faux.setResponses([fail("503 Service Unavailable: overloaded"), fail("overloaded"), fauxAssistantMessage("finally")]);
    const events = await drive(runTurn(h.opts({ sleep: noWait })));
    const retries = ofType(events, "retry");
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries[0]).toMatchObject({ maxAttempts: 5, error: expect.stringContaining("overloaded") });
    expect(types(events)).not.toContain("error");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
    expect(h.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("gives up after maxRetries and reports the error", async () => {
    const h = makeHarness();
    h.faux.setResponses(Array.from({ length: 6 }, () => fail("overloaded")));
    const events = await drive(runTurn(h.opts({ sleep: noWait, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } })));
    expect(ofType(events, "retry")).toHaveLength(2);
    expect(ofType(events, "error")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "error" });
  });

  it("does not retry when disabled", async () => {
    const h = makeHarness();
    h.faux.setResponses([fail("overloaded"), fauxAssistantMessage("never")]);
    const events = await drive(runTurn(h.opts({ sleep: noWait, retry: { enabled: false, maxRetries: 5, baseDelayMs: 1 } })));
    expect(types(events)).not.toContain("retry");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "error" });
  });

  it("backs off with the policy's delays and stops waiting on abort", async () => {
    const h = makeHarness();
    const ctl = new AbortController();
    const waits: number[] = [];
    h.faux.setResponses([fail("overloaded"), fauxAssistantMessage("never")]);
    const events = await drive(runTurn(h.opts({
      signal: ctl.signal,
      retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
      sleep: async (ms) => { waits.push(ms); ctl.abort(); },
    })));
    expect(waits[0]).toBeGreaterThanOrEqual(900);
    expect(waits[0]).toBeLessThanOrEqual(1100);
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "aborted" });
  });

  it("does not retry a context overflow; it ends the turn so the caller can compact", async () => {
    const h = makeHarness();
    h.faux.setResponses([fail("This model's maximum context length is 8192 tokens (prompt is too long)"), fauxAssistantMessage("never")]);
    const events = await drive(runTurn(h.opts({ sleep: noWait })));
    expect(types(events)).toContain("context/overflow");
    expect(types(events)).not.toContain("retry");
    expect(types(events)).not.toContain("error");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "overflow" });
  });
});

describe("runTurn: approvals", () => {
  it("asks, then runs the tool once the human approves", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("write_file", { path: "src/a.ts" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true }));
    const ask = ofType(events, "approval/asked")[0].ask;
    expect(ask).toMatchObject({ tool: "write_file", risk: "WRITE_LOCAL", preview: "src/a.ts", grants: ["tool"] });
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: true, by: "human" });
    expect(h.executed).toHaveLength(1);
  });

  it("does not run a denied tool and tells the model", async () => {
    const h = makeHarness();
    let reply = "";
    h.faux.setResponses([
      toolUse(call("write_file", { path: "a.ts" }, "c1")),
      (ctx) => { reply = JSON.stringify(ctx.messages.at(-1)); return fauxAssistantMessage("understood"); },
    ]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: false }));
    expect(h.executed).toHaveLength(0);
    expect(ofType(events, "tool/result")[0]).toMatchObject({ isError: true, text: "The user denied this tool call." });
    expect(reply).toContain("denied");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
  });

  it("registers the ask before emitting it, so an instant answer cannot be lost", async () => {
    const h = makeHarness();
    h.gate.onAsk((ask) => { h.gate.resolve(ask.sessionId, ask.callId, ask.nonce, { approved: true }); });
    h.faux.setResponses([toolUse(call("write_file", { path: "a.ts" }, "c1")), fauxAssistantMessage("ok")]);
    await drive(runTurn(h.opts()));
    expect(h.executed).toHaveLength(1);
  });

  it("a tool grant becomes a rule and silences later asks for that tool", async () => {
    const h = makeHarness();
    h.faux.setResponses([
      toolUse(call("write_file", { path: "a.ts" }, "c1")),
      toolUse(call("write_file", { path: "b.ts" }, "c2")),
      fauxAssistantMessage("ok"),
    ]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true, grant: "tool" }));
    expect(ofType(events, "approval/asked")).toHaveLength(1);
    expect(ofType(events, "rule/added")[0].rule).toMatchObject({ source: "grant", match: { tool: "write_file" } });
    expect(ofType(events, "approval/decided")[1]).toMatchObject({ approved: true, by: "rule" });
    expect(h.executed).toHaveLength(2);
  });

  it("a command grant covers only that exact command", async () => {
    const h = makeHarness();
    h.faux.setResponses([
      toolUse(call("bash", { command: "make ship" }, "c1")),
      toolUse(call("bash", { command: "make   ship" }, "c2")),
      toolUse(call("bash", { command: "make ship --force" }, "c3")),
      fauxAssistantMessage("ok"),
    ]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true, grant: "command" }));
    expect(ofType(events, "approval/asked").map((e) => e.ask.preview)).toEqual(['{"command":"make ship"}', '{"command":"make ship --force"}']);
  });

  it("ignores a tool grant offered for an EXEC call", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("bash", { command: "ls -la" }, "c1")), toolUse(call("bash", { command: "rm x" }, "c2")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true, grant: "tool" }));
    expect(ofType(events, "rule/added")).toHaveLength(0);
    expect(ofType(events, "approval/asked")).toHaveLength(2);
  });

  it("allows Cairn writes without asking when the preset is on", async () => {
    const h = makeHarness({ rules: presetRules("cairn-data") });
    h.faux.setResponses([toolUse(call("note_write", { title: "t" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()));
    expect(types(events)).not.toContain("approval/asked");
    expect(h.executed).toHaveLength(1);
  });

  it("denies instead of waiting when the profile has no approver", async () => {
    const h = makeHarness({ profile: { interactive: false } });
    h.faux.setResponses([toolUse(call("bash", { command: "make" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()));
    expect(types(events)).not.toContain("approval/asked");
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: false, by: "headless" });
    expect(h.executed).toHaveLength(0);
  });

  it("times out an unanswered ask and denies", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("write_file", { path: "a.ts" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts({ askTtlMs: 20 })));
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: false, by: "timeout" });
    expect(h.executed).toHaveLength(0);
  });
});

describe("runTurn: policy", () => {
  it("plan mode refuses writes outright", async () => {
    const h = makeHarness({ profile: { mode: "plan" }, rules: presetRules("cairn-data") });
    h.faux.setResponses([toolUse(call("note_write", { title: "t" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()));
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: false, by: "plan" });
    expect(textOfResult(h)).toContain("Plan mode is read-only");
  });

  it("the profile's denied tools never run", async () => {
    const h = makeHarness({ profile: { mode: "yolo", deniedTools: ["bash"] } });
    h.faux.setResponses([toolUse(call("bash", { command: "ls" }, "c1")), fauxAssistantMessage("ok")]);
    await drive(runTurn(h.opts()));
    expect(h.executed).toHaveLength(0);
  });

  it("yolo runs unresolved calls but still asks for protected paths", async () => {
    const h = makeHarness({ profile: { mode: "yolo" } });
    h.faux.setResponses([toolUse(call("bash", { command: "make" }, "c1"), call("write_file", { path: ".env" }, "c2")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: false }));
    expect(ofType(events, "approval/asked").map((e) => e.ask.tool)).toEqual(["write_file"]);
    expect(h.executed.map((e) => e.name)).toEqual(["bash"]);
  });

  it("asks on the third identical call even in yolo, and remembers an approval", async () => {
    const h = makeHarness({ profile: { mode: "yolo" } });
    const same = (id: string) => toolUse(call("bash", { command: "make" }, id));
    h.faux.setResponses([same("c1"), same("c2"), same("c3"), same("c4"), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true }));
    const asks = ofType(events, "approval/asked");
    expect(asks).toHaveLength(1);
    expect(asks[0].ask.callId).toBe("c3");
    expect(asks[0].ask.reason).toContain("Repeated identical");
    expect(h.executed).toHaveLength(4);
  });
});

describe("runTurn: tool-call hygiene", () => {
  it("rejects invalid arguments without asking or running", async () => {
    const h = makeHarness();
    // pi-ai coerces compatible scalars (42 → "42"), so use a missing required field.
    h.faux.setResponses([toolUse(call("write_file", {}, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()));
    expect(types(events)).not.toContain("approval/asked");
    expect(textOfResult(h)).toContain("Invalid arguments");
    expect(h.executed).toHaveLength(0);
  });

  it("answers an unknown tool with an error result", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("nope", {}, "c1")), fauxAssistantMessage("ok")]);
    await drive(runTurn(h.opts()));
    expect(textOfResult(h)).toBe("Unknown tool: nope");
  });

  it("turns a throwing tool into an error result and keeps going", async () => {
    const h = makeHarness();
    h.faux.setResponses([toolUse(call("boom", {}, "c1")), fauxAssistantMessage("recovered")]);
    const events = await drive(runTurn(h.opts()));
    expect(ofType(events, "tool/result")[0]).toMatchObject({ isError: true, text: "Tool error: kaboom" });
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
  });

  it("treats a throwing risk() as EXEC and asks", async () => {
    const executed: never[] = [];
    const tools = [defineTool({
      name: "weird", description: "x", parameters: Type.Object({}),
      risk: () => { throw new Error("bad"); },
      execute: async () => ({ content: "ran" }),
    }), ...makeTools(executed)];
    const h = makeHarness({ tools });
    h.faux.setResponses([toolUse(call("weird", {}, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: false }));
    expect(ofType(events, "approval/asked")[0].ask.risk).toBe("EXEC");
  });

  it("gives every call in a multi-call step exactly one result, in order", async () => {
    const h = makeHarness();
    h.faux.setResponses([
      toolUse(call("echo", { text: "a" }, "c1"), call("write_file", { path: "x.ts" }, "c2"), call("echo", { text: "b" }, "c3")),
      fauxAssistantMessage("ok"),
    ]);
    await drive(runTurn(h.opts()), answer(h.gate, { approved: false }));
    expect(toolResults(h.history).map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  it("runs consecutive parallel tools concurrently", async () => {
    let active = 0;
    let peak = 0;
    const slow = (name: string) => defineTool({
      name, description: "slow", parameters: Type.Object({}), risk: () => ({ class: "READ" }), concurrency: "parallel",
      execute: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return { content: name }; },
    });
    const h = makeHarness({ tools: [slow("a"), slow("b")] });
    h.faux.setResponses([toolUse(call("a", {}, "c1"), call("b", {}, "c2")), fauxAssistantMessage("ok")]);
    await drive(runTurn(h.opts()));
    expect(peak).toBe(2);
  });

  it("repairs a history that ends in an unanswered tool call", async () => {
    const h = makeHarness();
    h.history.push({ role: "user", content: "earlier", timestamp: 1 }, fauxAssistantMessage([fauxToolCall("write_file", { path: "a" } as never, { id: "old" })], { stopReason: "toolUse" }));
    let seen: Message[] = [];
    h.faux.setResponses([(ctx) => { seen = ctx.messages; return fauxAssistantMessage("ok"); }]);
    await drive(runTurn(h.opts()));
    const repaired = seen.find((m) => m.role === "toolResult");
    expect(repaired && repaired.role === "toolResult" && repaired.toolCallId).toBe("old");
  });
});

describe("runTurn: abort", () => {
  it("aborting during an ask denies the call, closes history and ends the turn", async () => {
    const h = makeHarness();
    const ctl = new AbortController();
    h.faux.setResponses([toolUse(call("write_file", { path: "a.ts" }, "c1"), call("echo", { text: "x" }, "c2")), fauxAssistantMessage("never")]);
    const events = await drive(runTurn(h.opts({ signal: ctl.signal })), (ev) => { if (ev.type === "approval/asked") ctl.abort(); });
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "aborted" });
    expect(toolResults(h.history).map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    expect(h.executed.map((e) => e.name)).not.toContain("write_file");
    expect(h.gate.pending("s1")).toHaveLength(0);
  });

  it("does not start when already aborted", async () => {
    const h = makeHarness();
    const ctl = new AbortController();
    ctl.abort();
    const events = await drive(runTurn(h.opts({ signal: ctl.signal })));
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "aborted" });
  });
});

describe("runTurn: auto mode reviewer", () => {
  const verdicts = (...v: Array<Awaited<ReturnType<Reviewer>> | Error>): Reviewer => {
    let i = 0;
    return async () => { const next = v[Math.min(i++, v.length - 1)]; if (next instanceof Error) throw next; return next; };
  };
  const auto = () => makeHarness({ profile: { mode: "auto" } });

  it("runs a call the reviewer allows, without asking", async () => {
    const h = auto();
    h.faux.setResponses([toolUse(call("bash", { command: "make" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts({ reviewer: verdicts({ verdict: "allow", reason: "matches the request" }) })));
    expect(types(events)).not.toContain("approval/asked");
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: true, by: "reviewer", reason: "matches the request" });
    expect(h.executed).toHaveLength(1);
  });

  it("returns the reviewer's reason to the model when it blocks", async () => {
    const h = auto();
    h.faux.setResponses([toolUse(call("bash", { command: "rm -rf /" }, "c1")), fauxAssistantMessage("ok")]);
    await drive(runTurn(h.opts({ reviewer: verdicts({ verdict: "block", reason: "deletes outside the workspace" }) })));
    expect(h.executed).toHaveLength(0);
    expect(textOfResult(h)).toBe("Blocked by safety review: deletes outside the workspace. Find a safer approach or ask the user.");
  });

  it("shows the reviewer's reason on the approval card when it asks", async () => {
    const h = auto();
    h.faux.setResponses([toolUse(call("bash", { command: "git push origin main" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts({ reviewer: verdicts({ verdict: "ask", reason: "pushes to a remote" }) })), answer(h.gate, { approved: true }));
    expect(ofType(events, "approval/asked")[0].ask.reason).toBe("pushes to a remote");
    expect(h.executed).toHaveLength(1);
  });

  it.each([
    ["throws", new Error("model down")],
  ])("falls back to a human ask when the reviewer %s", async (_n, failure) => {
    const h = auto();
    h.faux.setResponses([toolUse(call("bash", { command: "make" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts({ reviewer: verdicts(failure) })), answer(h.gate, { approved: false }));
    expect(ofType(events, "approval/asked")[0].ask.reason).toContain("unavailable");
    expect(h.executed).toHaveLength(0);
  });

  it("asks a human when no reviewer is configured", async () => {
    const h = auto();
    h.faux.setResponses([toolUse(call("bash", { command: "make" }, "c1")), fauxAssistantMessage("ok")]);
    const events = await drive(runTurn(h.opts()), answer(h.gate, { approved: true }));
    expect(ofType(events, "approval/asked")).toHaveLength(1);
  });

  it("never lets the reviewer override a deny rule", async () => {
    const deny: Rule = { id: "d", effect: "deny", scope: "global", source: "user", match: { command: { prefix: ["rm"] } } };
    const h = makeHarness({ profile: { mode: "auto" }, rules: [deny] });
    h.faux.setResponses([toolUse(call("bash", { command: "rm x" }, "c1")), fauxAssistantMessage("ok")]);
    const reviewer: Reviewer = async () => ({ verdict: "allow", reason: "fine" });
    const events = await drive(runTurn(h.opts({ reviewer })));
    expect(ofType(events, "approval/decided")[0]).toMatchObject({ approved: false, by: "rule" });
    expect(h.executed).toHaveLength(0);
  });

  it("pauses auto mode after three consecutive blocks and asks a human from then on", async () => {
    const h = auto();
    const state = createReviewerState();
    const block = (id: string, cmd: string) => toolUse(call("bash", { command: cmd }, id));
    h.faux.setResponses([block("c1", "a"), block("c2", "b"), block("c3", "c"), block("c4", "d"), fauxAssistantMessage("ok")]);
    const reviewer = verdicts({ verdict: "block", reason: "no" });
    const events = await drive(runTurn(h.opts({ reviewer, reviewerState: state })), answer(h.gate, { approved: true }));
    expect(ofType(events, "auto/paused")).toHaveLength(1);
    expect(state.paused).toBe(true);
    const asks = ofType(events, "approval/asked");
    expect(asks).toHaveLength(1);
    expect(asks[0].ask.callId).toBe("c4");
    expect(asks[0].ask.reason).toContain("paused");
  });

  it("an allow resets the consecutive-block counter", async () => {
    const h = auto();
    const state = createReviewerState();
    const step = (id: string, cmd: string) => toolUse(call("bash", { command: cmd }, id));
    h.faux.setResponses([step("c1", "a"), step("c2", "b"), step("c3", "c"), step("c4", "d"), step("c5", "e"), fauxAssistantMessage("ok")]);
    const reviewer = verdicts(
      { verdict: "block", reason: "x" }, { verdict: "block", reason: "x" }, { verdict: "allow", reason: "ok" },
      { verdict: "block", reason: "x" }, { verdict: "block", reason: "x" },
    );
    const events = await drive(runTurn(h.opts({ reviewer, reviewerState: state })));
    expect(ofType(events, "auto/paused")).toHaveLength(0);
    expect(state.totalBlocks).toBe(4);
  });
});

describe("repairInterrupted", () => {
  it("is a no-op for a complete history", () => {
    const msgs: Message[] = [{ role: "user", content: "hi", timestamp: 1 }, fauxAssistantMessage("yo")];
    expect(repairInterrupted(msgs)).toEqual(msgs);
  });
});
