import { describe, expect, it } from "vitest";
import { overallPhase, streamingPhase } from "./work-phase";

describe("streamingPhase", () => {
  const turn = { hasContent: false, hasReasoning: false, toolRunning: false };

  it("is sending until the turn has produced anything", () => {
    expect(streamingPhase(turn)).toBe("sending");
  });

  it("is thinking once reasoning streams, and responding once the answer does", () => {
    expect(streamingPhase({ ...turn, hasReasoning: true })).toBe("thinking");
    expect(streamingPhase({ ...turn, hasReasoning: true, hasContent: true })).toBe("responding");
  });

  it("a running tool wins over text already written this turn", () => {
    expect(streamingPhase({ hasContent: true, hasReasoning: true, toolRunning: true })).toBe("tools");
  });
});

describe("overallPhase", () => {
  it("is generic working by default", () => {
    expect(overallPhase({})).toBe("working");
  });

  it("surfaces blocking states in order of how much they need the user", () => {
    expect(overallPhase({ retrying: true })).toBe("retrying");
    expect(overallPhase({ retrying: true, compacting: true })).toBe("compacting");
    expect(overallPhase({ retrying: true, compacting: true, waiting: true })).toBe("waiting");
  });
});
