import { describe, expect, it } from "vitest";
import { toLiveConversationMessage, withLiveTurn, type LiveTurnState } from "./conversation-live";
import type { ConversationMessage } from "./conversation-message";

/**
 * The live-turn adapter is the single place every surface (chat, coding,
 * pop-out) turns in-flight controller state into a renderable message. It
 * replaces chat's separate `ToolCallIndicator` tree, so its behaviour has to be
 * pinned: an idle turn must produce nothing, and a malformed tool-args payload
 * must not throw (args are re-parsed on every token, so a throw here would take
 * down the transcript mid-stream — the pop-out's original bare `JSON.parse`
 * would have).
 */

function state(over: Partial<LiveTurnState> = {}): LiveTurnState {
  return {
    isLoading: false,
    streamingContent: "",
    streamingThought: "",
    toolCalls: [],
    subagents: [],
    ...over,
  };
}

const AT = "2026-01-01T00:00:00.000Z";

describe("toLiveConversationMessage", () => {
  it("returns null when the turn has nothing to show", () => {
    expect(toLiveConversationMessage("s1", state(), AT)).toBeNull();
  });

  it("returns a message as soon as the turn is merely loading", () => {
    const live = toLiveConversationMessage("s1", state({ isLoading: true }), AT);
    expect(live).toMatchObject({ id: "stream-s1", role: "assistant", content: "", isStreaming: true });
  });

  it("carries streamed text and reasoning", () => {
    const live = toLiveConversationMessage("s1", state({ streamingContent: "hi", streamingThought: "hmm" }), AT);
    expect(live).toMatchObject({ content: "hi", reasoning: "hmm" });
  });

  it("omits reasoning when empty rather than passing an empty string", () => {
    const live = toLiveConversationMessage("s1", state({ streamingContent: "hi" }), AT);
    expect(live?.reasoning).toBeUndefined();
  });

  it("maps a running tool call, preserving approval fields", () => {
    const live = toLiveConversationMessage("s1", state({
      toolCalls: [{
        tool: "mcp__atlassian__create_issue", label: "create issue", status: "running",
        callId: "c1", args: '{"project":"CAI"}', confirmRequired: true, approvalNonce: "n1",
      }],
    }), AT);
    expect(live?.toolCalls?.[0]).toMatchObject({
      callId: "c1",
      name: "mcp__atlassian__create_issue",
      label: "create issue",
      args: { project: "CAI" },
      running: true,
      ok: true,
      confirmRequired: true,
      approvalNonce: "n1",
    });
  });

  it("marks a finished tool call as not running and honours ok:false", () => {
    const live = toLiveConversationMessage("s1", state({
      toolCalls: [{ tool: "read", label: "read", status: "done", ok: false, error: "boom" }],
    }), AT);
    expect(live?.toolCalls?.[0]).toMatchObject({ running: false, ok: false, error: "boom" });
  });

  it("degrades malformed tool args to undefined instead of throwing", () => {
    for (const args of ['{"a":', "not json", "[]", "null", "12"]) {
      const live = toLiveConversationMessage("s1", state({
        toolCalls: [{ tool: "t", label: "t", status: "running", args }],
      }), AT);
      expect(live?.toolCalls?.[0].args).toBeUndefined();
    }
  });

  it("treats a subagent-only turn as live", () => {
    const live = toLiveConversationMessage("s1", state({ subagents: [{ id: "child" }] }), AT);
    expect(live?.subagents).toHaveLength(1);
  });

  it("uses the supplied createdAt verbatim (stable across tokens)", () => {
    expect(toLiveConversationMessage("s1", state({ isLoading: true }), AT)?.createdAt).toBe(AT);
  });
});

describe("withLiveTurn", () => {
  const settled: ConversationMessage[] = [
    { id: "m1", role: "user", content: "hello", createdAt: AT },
  ];

  it("appends the live turn last", () => {
    const live = toLiveConversationMessage("s1", state({ streamingContent: "hi" }), AT);
    expect(withLiveTurn(settled, live).map((m) => m.id)).toEqual(["m1", "stream-s1"]);
  });

  it("returns a copy of the transcript when there is no live turn", () => {
    const result = withLiveTurn(settled, null);
    expect(result).toEqual(settled);
    expect(result).not.toBe(settled);
  });
});
