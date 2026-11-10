import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildContextView } from "./context";
import { runTurn } from "./loop";
import { drive, makeHarness, ofType } from "./test-harness";

describe("loop bookkeeping", () => {
  it("logs a Stop hook's follow-up so a replayed history matches the live one", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    let asked = false;
    const events = await drive(runTurn(h.opts({ hooks: { stop: async () => (asked ? {} : ((asked = true), { continueWith: "run the tests" })) } })));
    const users = ofType(events, "user/message");
    expect(users[1]).toMatchObject({ content: "continue: run the tests", synthetic: true });
    const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    const replay = buildContextView(events.filter((e) => e.type !== "assistant/delta").map((event, i) => ({ event, time: i })));
    expect(replay.map((m) => m.role)).toEqual(h.history.map((m) => m.role));
    expect(text(replay[2])).toBe(text(h.history[2]));
  });

  it("says so when a reply is cut off at the output limit", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("half a sent", { stopReason: "length" })]);
    const events = await drive(runTurn(h.opts()));
    expect(ofType(events, "error")[0].message).toMatch(/cut off/);
    expect(ofType(events, "turn/end")[0].reason).toBe("stop");
  });
});
