import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate, type AskInput } from "./gate";

const input = (over: Partial<AskInput> = {}): AskInput => ({
  sessionId: "s1", callId: "c1", tool: "bash", risk: "EXEC", title: "bash", preview: "make", reason: "No rule", grants: ["command"], ...over,
});

describe("Gate", () => {
  let gate: Gate;
  beforeEach(() => { gate = new Gate(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves with the human's decision", async () => {
    const { ask, outcome } = gate.open(input());
    expect(gate.resolve("s1", "c1", ask.nonce, { approved: true })).toBe(true);
    await expect(outcome).resolves.toEqual({ approved: true, by: "human", grant: undefined });
  });

  it("can be answered synchronously from an onAsk listener", async () => {
    gate.onAsk((ask) => { gate.resolve(ask.sessionId, ask.callId, ask.nonce, { approved: true }); });
    const { outcome } = gate.open(input());
    await expect(outcome).resolves.toMatchObject({ approved: true, by: "human" });
  });

  it("rejects a wrong nonce and leaves the ask pending", async () => {
    const { ask, outcome } = gate.open(input());
    expect(gate.resolve("s1", "c1", "forged", { approved: true })).toBe(false);
    expect(gate.pending("s1")).toHaveLength(1);
    gate.resolve("s1", "c1", ask.nonce, { approved: false });
    await expect(outcome).resolves.toMatchObject({ approved: false, by: "human" });
  });

  it("does not let one session answer another's ask", () => {
    const a = gate.open(input({ sessionId: "A" }));
    expect(gate.resolve("B", "c1", a.ask.nonce, { approved: true })).toBe(false);
    expect(gate.pending("A")).toHaveLength(1);
  });

  it("keeps only grants that were offered", async () => {
    const { ask, outcome } = gate.open(input({ grants: ["command"] }));
    gate.resolve("s1", "c1", ask.nonce, { approved: true, grant: "tool" });
    await expect(outcome).resolves.toMatchObject({ approved: true, grant: undefined });
  });

  it("drops the grant on a denial", async () => {
    const { ask, outcome } = gate.open(input());
    gate.resolve("s1", "c1", ask.nonce, { approved: false, grant: "command" });
    await expect(outcome).resolves.toMatchObject({ approved: false, grant: undefined });
  });

  it("fails closed on timeout", async () => {
    vi.useFakeTimers();
    const { outcome } = gate.open(input(), { ttlMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(outcome).resolves.toEqual({ approved: false, by: "timeout" });
    expect(gate.pending("s1")).toHaveLength(0);
  });

  it("fails closed on abort, including an already-aborted signal", async () => {
    const ctl = new AbortController();
    const first = gate.open(input(), { signal: ctl.signal });
    ctl.abort();
    await expect(first.outcome).resolves.toEqual({ approved: false, by: "abort" });
    await expect(gate.open(input({ callId: "c2" }), { signal: ctl.signal }).outcome).resolves.toEqual({ approved: false, by: "abort" });
  });

  it("cancelSession settles only that session", async () => {
    const a = gate.open(input({ sessionId: "A" }));
    const b = gate.open(input({ sessionId: "B" }));
    gate.cancelSession("A");
    await expect(a.outcome).resolves.toEqual({ approved: false, by: "cleared" });
    expect(gate.pending("B")).toHaveLength(1);
    gate.clear();
    await expect(b.outcome).resolves.toEqual({ approved: false, by: "cleared" });
  });

  it("re-opening the same call supersedes the earlier ask", async () => {
    const first = gate.open(input());
    const second = gate.open(input());
    await expect(first.outcome).resolves.toEqual({ approved: false, by: "cleared" });
    expect(gate.resolve("s1", "c1", first.ask.nonce, { approved: true })).toBe(false);
    expect(gate.resolve("s1", "c1", second.ask.nonce, { approved: true })).toBe(true);
  });

  it("survives a throwing transport", () => {
    gate.onAsk(() => { throw new Error("transport down"); });
    expect(() => gate.open(input())).not.toThrow();
  });

  it("unsubscribes listeners", () => {
    const seen: string[] = [];
    const off = gate.onAsk((a) => seen.push(a.callId));
    gate.open(input({ callId: "x" }));
    off();
    gate.open(input({ callId: "y" }));
    expect(seen).toEqual(["x"]);
  });
});
