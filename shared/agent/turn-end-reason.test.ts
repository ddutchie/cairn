import { describe, expect, it } from "vitest";
import { describeTurnEndReason, isBenignTurnEnd } from "./turn-end-reason";

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
    expect(describeTurnEndReason({ kind: "error", error: { message: "401 bad key" } })).toBe("Agent turn failed: 401 bad key");
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
