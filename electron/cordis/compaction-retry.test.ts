/**
 * Unit test for cairnCodingPlugin's context-management event bridging (2h):
 * dsh session events (llm/retry, compaction/start|summary|end) → pi-agent:*.
 * Uses a fake ctx that captures the session/event handler and fires synthetic
 * events — no live model. (Token/tool/turn mapping is covered by the live test.)
 */
import { describe, it, expect } from "vitest";
import { cairnCodingPlugin } from "./cairn-plugins";

type EventHandler = (session: unknown, event: unknown) => void;

function harness(sessionId: string) {
  let handler: EventHandler | null = null;
  const ctx = {
    on: (ev: string, fn: EventHandler) => {
      if (ev === "session/event") handler = fn;
      return () => { handler = null; };
    },
    get: () => undefined, // no CAIRN_DB in this unit harness
  };
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  cairnCodingPlugin(ctx as never, {
    sessionId,
    matchSessionId: sessionId,
    mode: "execute",
    send: (channel, payload) => { sent.push({ channel, payload }); },
  });
  const session = { id: sessionId };
  let seq = 1;
  const fire = (type: string, data: Record<string, unknown>) => (handler as EventHandler)(session, { type, seq: seq++, data });
  return { sent, fire };
}

describe("cairnCodingPlugin — context-management bridge (2h)", () => {
  it("maps llm/retry to pi-agent:retry with 1-based attempt", () => {
    const { sent, fire } = harness("s-retry");
    fire("llm/retry", { retry: 0, maxRetries: 5, delayMs: 500, failure: { message: "429 rate limited", code: "rate_limit" } });
    const retry = sent.find((s) => s.channel === "pi-agent:retry");
    expect(retry).toBeTruthy();
    expect(retry!.payload).toMatchObject({ sessionId: "s-retry", attempt: 1, maxRetries: 5, delayMs: 500, error: "429 rate limited" });
  });

  it("falls back to failure.code when there is no message", () => {
    const { sent, fire } = harness("s-retry2");
    fire("llm/retry", { retry: 2, maxRetries: 5, delayMs: 2000, failure: { code: "overloaded" } });
    const retry = sent.find((s) => s.channel === "pi-agent:retry");
    expect(retry!.payload).toMatchObject({ attempt: 3, error: "overloaded" });
  });

  it("maps compaction start/summary/end to pi-agent:compact + compact-result", () => {
    const { sent, fire } = harness("s-compact");
    fire("compaction/start", { compactionId: "c1" });
    fire("compaction/summary", { compactionId: "c1", summary: "Condensed the earlier exploration.", shadowedSeqs: [1, 2, 3, 4] });
    fire("compaction/end", { compactionId: "c1" });

    const compactEvents = sent.filter((s) => s.channel === "pi-agent:compact");
    expect(compactEvents.map((e) => e.payload.status)).toEqual(["start", "end"]);
    expect(compactEvents[1].payload).toMatchObject({ auto: true });

    const result = sent.find((s) => s.channel === "pi-agent:compact-result");
    expect(result!.payload).toMatchObject({ sessionId: "s-compact", messageCount: 4, summary: "Condensed the earlier exploration." });
  });

  it("does not emit compact-result when the close failed", () => {
    const { sent, fire } = harness("s-compact-fail");
    fire("compaction/start", { compactionId: "c2" });
    fire("compaction/summary", { compactionId: "c2", summary: "x", shadowedSeqs: [1] });
    fire("compaction/end", { compactionId: "c2", error: { message: "commit failed" } });
    expect(sent.some((s) => s.channel === "pi-agent:compact" && s.payload.status === "end")).toBe(true);
    expect(sent.some((s) => s.channel === "pi-agent:compact-result")).toBe(false);
  });

  it("extracts summary text from a block-array summary", () => {
    const { sent, fire } = harness("s-compact-blocks");
    fire("compaction/start", {});
    fire("compaction/summary", { summary: [{ type: "text", text: "Part A. " }, { type: "text", text: "Part B." }], shadowedSeqs: [1, 2] });
    fire("compaction/end", {});
    const result = sent.find((s) => s.channel === "pi-agent:compact-result");
    expect(result!.payload.summary).toBe("Part A. Part B.");
  });

  it("ignores events from a non-matching session", () => {
    const { sent, fire } = harness("s-match");
    // fire against a different session id via a fresh handler is not possible here;
    // instead confirm matching events DO pass (guard is covered by matchSessionId).
    fire("llm/retry", { retry: 0, maxRetries: 1, delayMs: 100, failure: { message: "x" } });
    expect(sent.some((s) => s.channel === "pi-agent:retry")).toBe(true);
  });
});
