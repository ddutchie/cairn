// Session-event `data` fields are heterogeneous unions across every event
// type dsh emits; the tests probe specific runtime shapes via `as any` on
// paths where a full discriminated cast would triple the test size for
// zero value. Kept as `any` at the test boundary.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { collapseDerivedToMessages } from "./session-replay";
import { foldSurface, deriveEventMessage } from "@deepseek-ai/dsh-session";

describe("Context Ring & Replay on real saved jsonl sessions", () => {
  it("replays v4 role:tool results (dsh session format v4)", () => {
    const events = [
      {
        seq: 0,
        type: "user/message",
        data: { role: "user", content: [{ type: "text", text: "get the note" }], source: { kind: "user" } },
        surfaceOp: "append",
      },
      {
        seq: 1,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [{ type: "tool-call", id: "call-v4", name: "get_note", arguments: { noteId: "n-1" } }],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      },
      {
        seq: 2,
        type: "tool/result",
        data: {
          message: {
            role: "tool",
            toolCallId: "call-v4",
            content: [{ type: "text", text: JSON.stringify({ id: "n-1", title: "V4 note", content: "..." }) }],
          },
        },
        surfaceOp: "append",
      },
      {
        seq: 3,
        type: "assistant/message",
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            source: { provider: "deepseek", model: "deepseek-reasoner" },
          },
        },
        surfaceOp: "append",
      },
    ];
    const derived = foldSurface(events as any).nodes
      .map((seq) => deriveEventMessage(events[seq] as any))
      .filter((m): m is NonNullable<ReturnType<typeof deriveEventMessage>> => m !== null);
    const replayed = collapseDerivedToMessages(derived as any);
    expect(replayed.length).toBe(2);
    const call = replayed[1].toolCalls?.[0];
    expect(call?.tool).toBe("get_note");
    expect(call?.cairnRef).toEqual({ type: "note", id: "n-1", title: "V4 note" });
  });

});


