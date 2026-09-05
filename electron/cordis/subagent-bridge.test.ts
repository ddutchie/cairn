/**
 * Unit tests for the continuable-messaging additions to cairnSubagentPlugin:
 * agent-message follow-ups surface as trace tokens, and turn/start resets
 * the streamed-delta guards so a child's later turns aren't skipped.
 * Fake ctx + synthetic session/events — no live model.
 */
import { describe, it, expect } from "vitest";
import { cairnSubagentPlugin } from "./cairn-plugins";

type Handler = (session: unknown, event: unknown) => void;

interface Sent { channel: string; payload: Record<string, unknown> }

function makeCtx() {
  let handler: Handler | null = null;
  const sent: Sent[] = [];
  const ctx = {
    on: (ev: string, fn: Handler) => {
      if (ev === "session/event") handler = fn;
      return () => { handler = null; };
    },
  };
  const send = (channel: string, payload: Record<string, unknown>) => {
    sent.push({ channel, payload });
  };
  const emit = (session: unknown, event: unknown) => handler?.(session, event);
  return { ctx, emit, sent, send };
}

const child = (id: string, parentSession = "parent-1") => ({
  id,
  header: { origin: "subagent", parentSession },
});

const userMessage = (text: string, source?: Record<string, unknown>) => ({
  type: "user/message",
  seq: 1,
  data: { message: { content: [{ type: "text", text }], ...(source ? { source } : {}) } },
});

const traces = (sent: Sent[]) =>
  (sent.filter((s) => s.channel === "session:projection" && (s.payload as { kind?: string }).kind === "subagent-trace")
    .map((s) => s.payload.data) as Array<Record<string, unknown>>);

describe("cairnSubagentPlugin continuable messaging", () => {
  it("surfaces agent-message follow-ups as trace tokens", () => {
    const { ctx, emit, sent, send } = makeCtx();
    cairnSubagentPlugin(ctx as never, { send, sessionId: "parent-1" });

    emit(child("child-1"), userMessage("do research"));
    emit(
      child("child-1"),
      userMessage("dig deeper into the second source", { kind: "agent-message", form: "relay", senderSessionId: "parent-1" }),
    );

    const tokens = traces(sent).filter((t) => t.trace === "token");
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.some((t) => String(t.delta ?? "").includes("dig deeper"))).toBe(true);
  });

  it("resets streamed guards on turn/start so later turns are not skipped", () => {
    const { ctx, emit, sent, send } = makeCtx();
    cairnSubagentPlugin(ctx as never, { send, sessionId: "parent-1" });

    emit(child("child-1"), userMessage("task"));
    // Turn 1 streams "AB" live, then the final message gap-fills nothing.
    emit(child("child-1"), { type: "assistant/chunk", seq: 2, data: { chunk: { type: "text-delta", text: "AB" } } });
    emit(child("child-1"), {
      type: "assistant/message", seq: 3,
      data: { message: { content: [{ type: "text", text: " Laters" }] } },
    });
    // Turn 2 (e.g. after a send_message follow-up): same text must stream again.
    emit(child("child-1"), { type: "turn/start", seq: 4, data: {} });
    emit(child("child-1"), { type: "assistant/chunk", seq: 5, data: { chunk: { type: "text-delta", text: "AB" } } });

    const deltas = traces(sent).filter((t) => t.trace === "token").map((t) => String(t.delta ?? ""));
    expect(deltas.filter((d) => d === "AB")).toHaveLength(2);
  });

  it("ignores children of other sessions", () => {
    const { ctx, emit, sent, send } = makeCtx();
    cairnSubagentPlugin(ctx as never, { send, sessionId: "parent-1" });

    emit(child("child-9", "other-parent"), userMessage("hello"));
    expect(traces(sent)).toHaveLength(0);
  });
});
