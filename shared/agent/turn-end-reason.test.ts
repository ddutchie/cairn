import { describe, expect, it } from "vitest";
import { describeTurnEndReason, isBenignTurnEnd, pointsToAISettings } from "./turn-end-reason";

describe("isBenignTurnEnd", () => {
  it("treats the engine's normal end as benign", () => {
    expect(isBenignTurnEnd("stop")).toBe(true);
  });

  it("keeps the older session-log name and cancellation benign", () => {
    expect(isBenignTurnEnd("completed")).toBe(true);
    expect(isBenignTurnEnd("aborted")).toBe(true);
  });

  it.each(["error", "max-steps", "overflow"])("reports %s", (kind) => {
    expect(isBenignTurnEnd(kind)).toBe(false);
  });
});

describe("describeTurnEndReason", () => {
  it("quotes the failure message without inventing a code", () => {
    expect(describeTurnEndReason({ kind: "error", error: { message: "the model crashed" } })).toBe("Agent turn failed: the model crashed");
  });

  it("keeps a real code and labels internal failures", () => {
    expect(describeTurnEndReason({ kind: "error", error: { message: "slow", code: "RATE" } })).toBe("Agent turn failed (RATE): slow");
    expect(describeTurnEndReason({ kind: "error", error: { message: "boom", code: "UNKNOWN" } })).toBe("Agent turn failed — internal error: boom");
  });

  it("explains the engine's other ends in words", () => {
    expect(describeTurnEndReason({ kind: "max-steps" })).toContain("step limit");
    expect(describeTurnEndReason({ kind: "overflow" })).toContain("context");
    expect(describeTurnEndReason({ kind: "stop" })).not.toContain("abnormally");
  });
});

describe("provider failures", () => {
  const describeFailure = (message: string) => describeTurnEndReason({ kind: "error", error: { message } });

  it.each([
    '401: {"message":"Incorrect API key provided"}',
    '401 {"type":"error","error":{"type":"authentication_error","message":"Incorrect API key provided"}}',
    "HTTP 401: Incorrect API key provided",
  ])("explains a rejected key and keeps the provider's words: %s", (raw) => {
    const text = describeFailure(raw);
    expect(text).toBe("The provider rejected your API key. Check it in Settings → AI. (Incorrect API key provided)");
    expect(pointsToAISettings(text)).toBe(true);
  });

  it("explains rate limits without sending the user to settings", () => {
    const text = describeFailure("429: Too Many Requests");
    expect(text).toContain("limiting requests");
    expect(pointsToAISettings(text)).toBe(false);
  });

  it.each(["connect ECONNREFUSED 127.0.0.1:11434", "fetch failed", "Connection error."])("explains an unreachable provider: %s", (raw) => {
    expect(describeFailure(raw)).toContain("Couldn't reach the provider");
  });

  it("shows a missing key on its own", () => {
    expect(describeFailure("Missing API key. Add one for this provider in Settings → AI.")).toBe("Missing API key. Add one for this provider in Settings → AI.");
  });

  it("does not take numbers inside other messages for a status", () => {
    expect(describeFailure("Tool 401 exploded")).toBe("Agent turn failed: Tool 401 exploded");
  });

  it("copes with a status and no detail", () => {
    expect(describeFailure("401")).toBe("The provider rejected your API key. Check it in Settings → AI.");
  });
});
