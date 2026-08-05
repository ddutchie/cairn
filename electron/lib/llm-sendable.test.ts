import { describe, expect, it } from "vitest";
import { isSendableMessage } from "./llm";

describe("isSendableMessage", () => {
  // Regression: a "thinking" model that times out or stops streaming
  // mid-reasoning persists an assistant turn whose only payload was reasoning
  // (stripped before re-send). Replaying it makes OpenAI-compatible providers
  // reject the whole request: "content or tool_calls must be set" (400).
  it("drops an assistant turn with neither content nor tool_calls", () => {
    expect(isSendableMessage({ role: "assistant", content: null })).toBe(false);
    expect(isSendableMessage({ role: "assistant", content: "" })).toBe(false);
    expect(isSendableMessage({ role: "assistant", content: "   " })).toBe(false);
    expect(isSendableMessage({ role: "assistant", content: "", tool_calls: [] })).toBe(false);
  });

  it("keeps an assistant turn that has content", () => {
    expect(isSendableMessage({ role: "assistant", content: "here is the draft" })).toBe(true);
  });

  it("keeps an assistant turn that has tool_calls even with empty content", () => {
    expect(
      isSendableMessage({ role: "assistant", content: null, tool_calls: [{ id: "c1" }] }),
    ).toBe(true);
  });

  it("never filters non-assistant roles, even when empty", () => {
    // user/system/tool turns with empty content are the caller's concern; the
    // provider only rejects assistant turns for the missing-payload reason.
    expect(isSendableMessage({ role: "user", content: "" })).toBe(true);
    expect(isSendableMessage({ role: "system", content: null })).toBe(true);
    expect(isSendableMessage({ role: "tool", content: "" })).toBe(true);
  });
});
