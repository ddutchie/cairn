/**
 * Session guards — pins today's exact refusal events.
 *
 * Every `session:*` refusal emits `session:projection` (error) + `session:busy`
 * in that order. Only `rejectPrompt` (a refused prompt that consumed the
 * renderer's spinner) also emits `session:event` with a `turn/end`. The busy
 * payload carries `message` ONLY for `rejectPrompt`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const windowSend = vi.hoisted(() => vi.fn());
const tapSend = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: windowSend } }] },
}));

import { getIpcHandler } from "./registry";
import { rejectInvalidId, rejectBusy, rejectPrompt, onSession } from "./session-guards";

beforeEach(() => {
  windowSend.mockClear();
  tapSend.mockClear();
});

const channels = () => windowSend.mock.calls.map(([c]) => c as string);
const payloads = () => windowSend.mock.calls.map(([, p]) => p as Record<string, unknown>);

describe("rejectInvalidId", () => {
  it("emits projection error + busy with reason invalid-id, no turn/end", () => {
    rejectInvalidId("..");

    expect(channels()).toEqual(["session:projection", "session:busy"]);
    const [projection, busy] = payloads();
    expect(projection).toMatchObject({ sessionId: "..", kind: "error", data: { message: "Invalid session id.", code: "invalid-id" } });
    expect(busy).toEqual({ sessionId: "..", reason: "invalid-id" });
    expect("message" in (busy as object)).toBe(false);
  });

  it("normalises a missing id to 'unknown' (today's String(raw ?? 'unknown') rule)", () => {
    const out = rejectInvalidId(undefined);
    expect(out).toBe("unknown");
    const [projection, busy] = payloads();
    expect(projection).toMatchObject({ sessionId: "unknown" });
    expect(busy).toEqual({ sessionId: "unknown", reason: "invalid-id" });
  });

  it("rejects empty and over-long ids the same way", () => {
    rejectInvalidId("");
    expect(channels()).toEqual(["session:projection", "session:busy"]);
    windowSend.mockClear();
    rejectInvalidId("x".repeat(200));
    expect(channels()).toEqual(["session:projection", "session:busy"]);
    expect(payloads()[0]).toMatchObject({ data: { code: "invalid-id" } });
  });
});

describe("rejectBusy", () => {
  it("emits projection + busy with already-running, no message on busy, no turn/end", () => {
    rejectBusy("s1");

    expect(channels()).toEqual(["session:projection", "session:busy"]);
    const [projection, busy] = payloads();
    expect(projection).toMatchObject({
      sessionId: "s1", kind: "error",
      data: { message: "Session is busy — already running.", code: "already-running" },
    });
    expect(busy).toEqual({ sessionId: "s1", reason: "already-running" });
  });

  it("preserves each call site's message verbatim", () => {
    const messages = [
      "Session is busy — already running.",
      "Session is busy — cannot toggle plan mode while running.",
      "Session is busy — try again when the agent finishes.",
      "Session is busy — cannot clear while running.",
      "Session is busy — cannot destroy while clearing.",
      "Session is busy — please wait for the current turn to finish.",
    ];
    for (const message of messages) {
      windowSend.mockClear();
      rejectBusy("s1", message);
      const [projection, busy] = payloads();
      expect(projection).toMatchObject({ data: { message, code: "already-running" } });
      expect(busy).toEqual({ sessionId: "s1", reason: "already-running" });
      expect("message" in (busy as object)).toBe(false);
    }
  });

  it("sends the projection to the tap when present, busy still broadcasts", () => {
    rejectBusy("s1", "Session is busy — already running.", "already-running", tapSend);

    expect(tapSend).toHaveBeenCalledTimes(1);
    expect(tapSend.mock.calls[0]?.[0]).toBe("session:projection");
    expect(tapSend.mock.calls[0]?.[1]).toMatchObject({ sessionId: "s1", kind: "error" });
    expect(channels()).toEqual(["session:busy"]);
  });
});

describe("rejectPrompt", () => {
  it("emits projection + busy (with message) + turn/end, in order", () => {
    rejectPrompt("s1", "Local LLM provider is disabled.", "localllm-disabled");

    expect(channels()).toEqual(["session:projection", "session:busy", "session:event"]);
    const [projection, busy, event] = payloads();
    expect(projection).toMatchObject({
      sessionId: "s1", kind: "error",
      data: { message: "Local LLM provider is disabled.", code: "localllm-disabled" },
    });
    expect(busy).toEqual({ sessionId: "s1", reason: "localllm-disabled", message: "Local LLM provider is disabled." });
    expect(event).toMatchObject({ sessionId: "s1" });
    const inner = (event as { event: { type: string; data: unknown } }).event;
    expect(inner.type).toBe("turn/end");
    expect(inner.data).toMatchObject({ reason: { kind: "error", error: { message: "Local LLM provider is disabled." } } });
  });
});

describe("onSession", () => {
  it("refuses an invalid id without running the handler", async () => {
    const handler = vi.fn();
    onSession("session:test-guard", handler);

    const listener = getIpcHandler("session:test-guard") as (e: unknown, req: unknown) => unknown;
    await listener({}, { sessionId: ".." });

    expect(handler).not.toHaveBeenCalled();
    expect(channels()).toEqual(["session:projection", "session:busy"]);
    expect(payloads()[0]).toMatchObject({ sessionId: "..", data: { code: "invalid-id" } });
  });

  it("passes a valid id through to the handler with no refusal events", async () => {
    const handler = vi.fn();
    onSession("session:test-guard-ok", handler);

    const listener = getIpcHandler("session:test-guard-ok") as (e: unknown, req: unknown) => unknown;
    await listener({}, { sessionId: "pi-abc123" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ sessionId: "pi-abc123" });
    expect(windowSend).not.toHaveBeenCalled();
  });
});
