import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Listener = (e: { sessionId: string; event: { type: string; data?: unknown } }) => void;
const listeners = new Set<Listener>();
const abort = vi.fn(async () => ({}));

vi.mock("@/lib/ipc/session", () => ({
  sessionClient: {
    onEvent: (cb: Listener) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    onProjection: () => () => {},
    abort: (...a: unknown[]) => abort(...(a as [])),
  },
}));

import { useSessionConversation } from "./useSessionConversation";

const emit = (type: string, data?: unknown) => listeners.forEach((l) => l({ sessionId: "chat-1", event: { type, data } }));

describe("useSessionConversation stop", () => {
  it("hands the stopped turn's tool calls and text to the adapter instead of dropping them", () => {
    const onTurnEnd = vi.fn();
    const { result } = renderHook(() => useSessionConversation({ sessionId: "chat-1", adapter: { onTurnEnd } }));
    act(() => {
      emit("turn/start");
      emit("assistant/chunk", { chunk: { type: "text-delta", text: "Looking…" } });
      emit("tool/call", { callId: "c1", name: "search_notes", args: { query: "x" } });
    });
    act(() => { result.current.stop(); });
    expect(abort).toHaveBeenCalledWith("chat-1");
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    const [reason, snapshot] = onTurnEnd.mock.calls[0];
    expect(reason).toBe("aborted");
    expect(snapshot.text).toBe("Looking…");
    expect(snapshot.toolCalls.map((t: { callId?: string; status: string }) => [t.callId, t.status])).toEqual([["c1", "done"]]);
    // The live view is cleared, and an idle stop persists nothing.
    expect(result.current.toolCalls).toEqual([]);
    act(() => { result.current.stop(); });
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("also saves a stopped turn that only has reasoning so far", () => {
    const onTurnEnd = vi.fn();
    const { result } = renderHook(() => useSessionConversation({ sessionId: "chat-1", adapter: { onTurnEnd } }));
    act(() => {
      emit("turn/start");
      emit("assistant/chunk", { chunk: { type: "reasoning-delta", text: "Thinking it through" } });
    });
    act(() => { result.current.stop(); });
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.calls[0][1].thought).toBe("Thinking it through");
  });
});
