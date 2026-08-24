import { describe, expect, it } from "vitest";
import { dispatchSessionProjection, makeSessionProjection } from "./session-projection";

describe("session projection envelope", () => {
  it("preserves the session, discriminant, and data", () => {
    expect(makeSessionProjection("s1", "retry", { attempt: 2, maxRetries: 3, delayMs: 10, error: "busy" }))
      .toEqual({ sessionId: "s1", kind: "retry", data: { attempt: 2, maxRetries: 3, delayMs: 10, error: "busy" } });
  });

  it("dispatches only the matching kind", () => {
    const seen: string[] = [];
    dispatchSessionProjection(makeSessionProjection("s1", "retry", { attempt: 1, maxRetries: 3, delayMs: 10, error: "busy" }), {
      retry: () => { seen.push("retry"); },
    });
    expect(seen).toEqual(["retry"]);
  });
});
