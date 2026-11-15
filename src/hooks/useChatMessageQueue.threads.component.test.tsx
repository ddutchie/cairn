import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { _resetChatMessageQueues, queuedFor, useChatMessageQueue, useQueueDrain, waitForSessionIdle } from "./useChatMessageQueue";
import { useSessionConversation } from "./useSessionConversation";

afterEach(() => {
  _resetChatMessageQueues();
  vi.unstubAllGlobals();
});

const msg = (id: string) => ({ id, content: id });

describe("per-thread message queues", () => {
  it("keeps a thread's queue while another thread is shown, and across a remount", () => {
    const { result, rerender, unmount } = renderHook(({ thread }) => useChatMessageQueue(thread), { initialProps: { thread: "a" } });
    act(() => { result.current.enqueue(msg("a1")); result.current.enqueue(msg("a2")); });
    expect(result.current.queued.map((m) => m.id)).toEqual(["a1", "a2"]);

    rerender({ thread: "b" });
    expect(result.current.queued).toEqual([]);
    act(() => { result.current.enqueue(msg("b1")); });

    rerender({ thread: "a" });
    expect(result.current.queued.map((m) => m.id)).toEqual(["a1", "a2"]);

    unmount();
    const again = renderHook(() => useChatMessageQueue("a"));
    expect(again.result.current.queued.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(queuedFor("b").map((m) => m.id)).toEqual(["b1"]);
  });

  it("drains and clears a thread that is not the one shown", () => {
    const { result } = renderHook(() => useChatMessageQueue("a"));
    act(() => { result.current.enqueue(msg("b1"), "b"); result.current.enqueue(msg("b2"), "b"); result.current.enqueue(msg("a1")); });
    let drained: { id: string } | null = null;
    act(() => { drained = result.current.drainNext("b"); });
    expect(drained).toEqual(msg("b1"));
    expect(queuedFor("b").map((m) => m.id)).toEqual(["b2"]);
    expect(result.current.queued.map((m) => m.id)).toEqual(["a1"]);
    act(() => { result.current.clearQueue("b"); });
    expect(queuedFor("b")).toEqual([]);
  });

  it("promote moves a message to the head; front enqueue puts one back first", () => {
    const { result } = renderHook(() => useChatMessageQueue("a"));
    act(() => { ["1", "2", "3"].forEach((id) => result.current.enqueue(msg(id))); });
    act(() => { result.current.promoteQueued("3"); });
    expect(result.current.queued.map((m) => m.id)).toEqual(["3", "1", "2"]);
    act(() => { result.current.enqueue(msg("0"), undefined, true); });
    expect(result.current.queued.map((m) => m.id)).toEqual(["0", "3", "1", "2"]);
  });

  it("a queue without a key is private to its owner", () => {
    const one = renderHook(() => useChatMessageQueue());
    const two = renderHook(() => useChatMessageQueue());
    act(() => { one.result.current.enqueue(msg("x")); });
    expect(one.result.current.queued).toHaveLength(1);
    expect(two.result.current.queued).toHaveLength(0);
  });
});

describe("useQueueDrain scope", () => {
  it("does not treat switching from a running thread to an idle one as a turn ending", () => {
    const drained: string[] = [];
    const next = vi.fn(() => "queued");
    const { rerender } = renderHook(
      ({ loading, scope }) => useQueueDrain(loading, next, (m) => drained.push(m), scope),
      { initialProps: { loading: true, scope: "a" } },
    );
    rerender({ loading: false, scope: "b" });   // switched thread: a is still running
    expect(drained).toEqual([]);
    rerender({ loading: true, scope: "a" });    // back on a
    rerender({ loading: false, scope: "a" });   // a's turn ends
    expect(drained).toEqual(["queued"]);
  });
});

describe("waitForSessionIdle", () => {
  it("waits until the main process reports the session idle", async () => {
    const answers = [true, true, false];
    const isRunning = vi.fn(async () => ({ running: answers.shift() ?? false }));
    vi.stubGlobal("window", Object.assign(window, { electron: { session: { isRunning } } }));
    expect(await waitForSessionIdle("s", 5_000)).toBe(true);
    expect(isRunning).toHaveBeenCalledTimes(3);
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("gives up when the session is still running at the deadline", async () => {
    vi.stubGlobal("window", Object.assign(window, { electron: { session: { isRunning: async () => ({ running: true }) } } }));
    expect(await waitForSessionIdle("s", 200)).toBe(false);
    delete (window as unknown as { electron?: unknown }).electron;
  });
});

describe("session running state", () => {
  it("a thread is running from the moment of sending, so leaving and returning before the turn starts still shows it busy", () => {
    const { result, rerender } = renderHook(({ id }) => useSessionConversation({ sessionId: id }), { initialProps: { id: "chat-a" } });
    act(() => { result.current.startPrompt(() => { /* dispatched to the main process */ }); });
    expect(result.current.isLoading).toBe(true);
    rerender({ id: "chat-b" });
    expect(result.current.isLoading).toBe(false);
    rerender({ id: "chat-a" });
    expect(result.current.isLoading).toBe(true);
  });
});
