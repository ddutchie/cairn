/**
 * Engine → renderer contract. The adapter is the only thing between the loop's events and the UI's
 * fold, and a dropped event fails silently (no type error, no crash), so this pins both ends:
 *  - every AgentEvent type is classified (the Record is exhaustive, so a new event type won't compile
 *    until someone decides what the renderer sees), and each classification is checked against the adapter;
 *  - a scripted turn through the real loop and the renderer's real fold produces what the UI needs.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createSessionEventFold, type FoldedStats, type FoldedToolResult, type FoldedUsage } from "../../../shared/agent/session-event-fold";
import type { AgentEvent } from "../events";
import { runTurn } from "../loop";
import { drive, makeHarness } from "../test-harness";
import { createAdapter } from "./adapter";

type Visibility = "event" | "projection" | "log-only";

/** A representative event for every AgentEvent type and where the renderer learns of it. */
const SAMPLES: { [T in AgentEvent["type"]]: { visibility: Visibility; event: Extract<AgentEvent, { type: T }> } } = {
  "turn/start": { visibility: "event", event: { type: "turn/start", sessionId: "s", profile: "chat" } },
  "user/message": { visibility: "log-only", event: { type: "user/message", content: "hi" } },
  "assistant/delta": { visibility: "event", event: { type: "assistant/delta", text: "x" } },
  "assistant/thinking": { visibility: "event", event: { type: "assistant/thinking", text: "x" } },
  "assistant/message": { visibility: "event", event: { type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "x" }] } as never } },
  "tool/call": { visibility: "event", event: { type: "tool/call", callId: "c", name: "echo", args: {}, risk: "READ" } },
  "approval/asked": { visibility: "projection", event: { type: "approval/asked", ask: { sessionId: "s", callId: "c", nonce: "n", tool: "bash", title: "t", preview: "p", reason: "r", risk: "EXEC", grants: [], expiresAt: 1 } as never } },
  "approval/decided": { visibility: "projection", event: { type: "approval/decided", callId: "c", approved: true, by: "human" } },
  "rule/added": { visibility: "log-only", event: { type: "rule/added", rule: {} as never } },
  "tool/result": { visibility: "event", event: { type: "tool/result", callId: "c", name: "echo", text: "ok", isError: false } },
  "auto/paused": { visibility: "projection", event: { type: "auto/paused", reason: "too many blocks" } },
  "retry": { visibility: "projection", event: { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 100, error: "e" } },
  "context/overflow": { visibility: "projection", event: { type: "context/overflow" } },
  "compaction": { visibility: "projection", event: { type: "compaction", summary: "s", keepCount: 2, tokensBefore: 10, trigger: "threshold" } },
  "session/title": { visibility: "projection", event: { type: "session/title", title: "t" } },
  "goal/changed": { visibility: "projection", event: { type: "goal/changed", operation: "create", goal: null } },
  "schedule/changed": { visibility: "log-only", event: { type: "schedule/changed", operation: "add", schedule: {} as never } },
  "error": { visibility: "projection", event: { type: "error", message: "boom" } },
  "turn/end": { visibility: "event", event: { type: "turn/end", reason: "stop" } },
};

describe("adapter coverage", () => {
  for (const [type, { visibility, event }] of Object.entries(SAMPLES)) {
    it(`${type} is ${visibility}`, () => {
      const out = createAdapter("s", () => 1)(event);
      const seen: Visibility = out.events.length ? "event" : out.projections.length ? "projection" : "log-only";
      expect(seen).toBe(visibility);
    });
  }
});

/** Run a scripted turn through the real loop and adapter, folding with the renderer's own fold. */
async function runThroughRenderer(script: Parameters<ReturnType<typeof makeHarness>["faux"]["setResponses"]>[0], respond?: (ev: AgentEvent) => void) {
  const h = makeHarness();
  h.faux.setResponses(script);
  const adapt = createAdapter("s1");
  const seen = { text: "", usage: [] as FoldedUsage[], stats: [] as FoldedStats[], calls: [] as Array<{ callId?: string; name: string }>, results: [] as FoldedToolResult[], order: [] as string[], turnEnd: undefined as string | undefined };
  const fold = createSessionEventFold({
    onTurnStart: () => seen.order.push("turn-start"),
    onText: (t) => { seen.text += t; },
    onUsage: (u) => seen.usage.push(u),
    onStats: (s) => seen.stats.push(s),
    onToolCall: (c) => { seen.calls.push(c); seen.order.push(`call:${c.name}`); },
    onToolResult: (r) => { seen.results.push(r); seen.order.push(`result:${r.name}`); },
    onAssistantMessage: () => seen.order.push("assistant-message"),
    onTurnEnd: (reason) => { seen.turnEnd = reason; seen.order.push("turn-end"); },
  });
  const projections: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const events = await drive(runTurn(h.opts()), (ev) => {
    respond?.(ev);
    if (ev.type === "approval/asked") h.gate.resolve(ev.ask.sessionId, ev.ask.callId, ev.ask.nonce, { approved: true });
  });
  for (const ev of events) {
    const out = adapt(ev);
    out.events.forEach(fold);
    for (const p of out.projections) projections.push({ kind: p.kind, data: p.data as Record<string, unknown> });
  }
  return { seen, projections, h };
}

describe("a scripted turn as the renderer sees it", () => {
  it("a plain answer reaches the fold with text, usage, stats and a clean end", async () => {
    const { seen } = await runThroughRenderer([fauxAssistantMessage("hello there")]);
    expect(seen.text).toBe("hello there");
    expect(seen.usage.length).toBeGreaterThan(0);
    expect(seen.stats.length).toBe(1);
    expect(seen.turnEnd).toBe("stop");
    expect(seen.order[0]).toBe("turn-start");
    expect(seen.order.at(-1)).toBe("turn-end");
  });

  it("a tool turn shows the call, then its result with args attached, in order", async () => {
    const { seen } = await runThroughRenderer([
      fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    expect(seen.calls).toEqual([expect.objectContaining({ callId: "c1", name: "echo" })]);
    expect(seen.results).toEqual([expect.objectContaining({ callId: "c1", name: "echo", ok: true, output: "echo:hi", args: { text: "hi" } })]);
    expect(seen.order.indexOf("call:echo")).toBeLessThan(seen.order.indexOf("result:echo"));
    expect(seen.text).toBe("done");
  });

  it("a failing tool is folded as an error result, not dropped", async () => {
    const { seen } = await runThroughRenderer([
      fauxAssistantMessage([fauxToolCall("boom", {}, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("sorry"),
    ]);
    expect(seen.results).toEqual([expect.objectContaining({ callId: "c1", ok: false, error: expect.stringContaining("kaboom") })]);
  });

  it("an approval is raised and then cleared as projections the UI can match up", async () => {
    const { projections, seen } = await runThroughRenderer([
      fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    const approvals = projections.filter((p) => p.kind === "approval");
    expect(approvals.map((p) => p.data.status)).toEqual(["required", "resolved"]);
    expect(approvals[0].data).toMatchObject({ callId: "c1", name: "bash" });
    expect(approvals[1].data).toMatchObject({ callId: "c1", approved: true });
    expect(seen.results[0]).toMatchObject({ ok: true });
  });

  it("an upstream failure ends the turn as an error with a visible message", async () => {
    const { seen, projections } = await runThroughRenderer([fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })]);
    expect(seen.turnEnd).toBe("error");
    expect(projections.some((p) => p.kind === "error" && String(p.data.message).includes("invalid api key"))).toBe(true);
  });

  it("a retried failure surfaces a retry projection and the turn still completes", async () => {
    const { seen, projections } = await runThroughRenderer([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "upstream 500" }),
      fauxAssistantMessage("recovered"),
    ]);
    expect(projections.find((p) => p.kind === "retry")?.data).toMatchObject({ attempt: 1, error: "upstream 500" });
    expect(seen.text).toBe("recovered");
    expect(seen.turnEnd).toBe("stop");
  });
});
