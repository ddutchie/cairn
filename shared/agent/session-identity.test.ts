import { describe, expect, it } from "vitest";
import { chatSessionId, chatThreadId } from "./session-identity";

describe("popout session identity", () => {
  it("round-trips a chat thread through the shared session id", () => {
    expect(chatThreadId(chatSessionId("thread-42"))).toBe("thread-42");
  });
});
