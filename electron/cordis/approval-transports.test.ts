/**
 * Unit tests for the ctx.cairn.confirm() seam (docs/approval-gating-audit.md
 * §5 Phase C item 9): the session-scoped transport registry and the interactive
 * transport's lifecycle — synthetic pending chip → approval card → decision →
 * chip completion, with fail-closed timeout/abort. No live model.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createInteractiveConfirmTransport,
  setConfirmTransport,
  getConfirmTransport,
  type PluginConfirmOutcome,
} from "./approval-transports";
import { getSessionGrants, clearSessionGrants } from "./approval-grants";

type Decision = { approved: boolean; grant?: "session" | "command" };

function makeDeps(sessionId: string, opts: { neverRespond?: boolean; timeoutMs?: number; decide?: (callId: string) => Decision } = {}) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let respondWith: ((decision: Decision) => void) | null = null;
  const transport = createInteractiveConfirmTransport({
    sessionId,
    send: (channel, payload) => { sent.push({ channel, payload }); },
    registerPending: (callId, resolve) => {
      if (!opts.neverRespond) {
        setTimeout(() => resolve(opts.decide?.(callId) ?? { approved: true }), 0);
      } else {
        respondWith = (d: Decision) => resolve(d);
      }
      return () => {};
    },
    timeoutMs: opts.timeoutMs,
  });
  return { transport, sent, respond: (d: Decision) => (respondWith as unknown as (d: Decision) => void)(d) };
}

const events = (sent: Array<{ payload: Record<string, unknown> }>, kind: string): number =>
  sent.filter((s) => s.payload.kind === kind).length;

beforeEach(() => clearSessionGrants("px"));

describe("confirm transport registry", () => {
  it("binds, replaces, and unbinds per session", () => {
    expect(getConfirmTransport("a")).toBeUndefined();
    const t1 = createInteractiveConfirmTransport({ sessionId: "a", send: () => {}, registerPending: () => () => {} });
    setConfirmTransport("a", t1);
    expect(getConfirmTransport("a")).toBe(t1);
    setConfirmTransport("a", undefined);
    expect(getConfirmTransport("a")).toBeUndefined();
  });
});

describe("interactive confirm transport", () => {
  it("approve: synthesizes pending chip → card → completion, records grant:'session'", async () => {
    const { transport, sent } = makeDeps("px", { decide: () => ({ approved: true, grant: "session" }) });
    const outcome = await transport.confirm({ title: "Publish draft?", toolName: "publish_note", args: { id: "n1" } });
    expect(outcome).toBe<PluginConfirmOutcome>("allowed-once");
    expect(events(sent, "tool")).toBe(2); // pending + end
    expect(sent[0].payload).toMatchObject({ data: { name: "publish_note", status: "pending" } });
    expect(sent[sent.length - 1].payload).toMatchObject({ data: { status: "end", ok: true } });
    expect(getSessionGrants("px").tools.has("publish_note")).toBe(true);
  });

  it("deny: settles rejected with a denied completion and no grant", async () => {
    const { transport, sent } = makeDeps("px", { decide: () => ({ approved: false }) });
    const outcome = await transport.confirm({ toolName: "publish_note" });
    expect(outcome).toBe("rejected");
    expect(sent[sent.length - 1].payload).toMatchObject({ data: { status: "end", ok: false } });
    expect(getSessionGrants("px").tools.size).toBe(0);
  });

  it("unanswered ask expires fail-closed and emits the expiry event", async () => {
    const { transport, sent } = makeDeps("px", { neverRespond: true, decide: () => ({ approved: true, grant: "session" }), timeoutMs: 5 });
    const outcome = await transport.confirm({ toolName: "deploy" });
    await new Promise((r) => setTimeout(r, 15));
    expect(outcome).toBe("cancelled");
    expect(sent.filter((s) => s.payload.kind === "approval" && (s.payload.data as { status?: string }).status === "expired")).toHaveLength(1);
    // The timeout won — no standing grant may leak through.
    expect(getSessionGrants("px").tools.has("deploy")).toBe(false);
    expect(sent[sent.length - 1].payload).toMatchObject({ data: { status: "end", ok: false } });
  });

  it("pre-aborted signal settles cancelled immediately without asking", async () => {
    const { transport, sent } = makeDeps("px", { decide: () => ({ approved: true }) });
    const ctrl = new AbortController();
    ctrl.abort();
    const outcome = await transport.confirm({ toolName: "x", signal: ctrl.signal });
    expect(outcome).toBe("cancelled");
    // A dead request surfaces nothing at all — no chip, no card, no completion.
    expect(sent).toHaveLength(0);
  });
});
