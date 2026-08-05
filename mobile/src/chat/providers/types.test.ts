import { describe, expect, it } from "vitest";
import { assistantTurnIsSendable } from "./types";
import type { UIPart } from "./types";

const text = (t: string): UIPart => ({ type: "text", text: t });
const tool = (): UIPart => ({ type: "tool-search", toolCallId: "c1", state: "input-available" });

describe("assistantTurnIsSendable", () => {
  // Regression: a thinking model that stops mid-reasoning leaves an assistant
  // turn with no text and no tool call (reasoning isn't a text part). Replaying
  // it trips the provider's "content or tool_calls must be set" 400.
  it("rejects an assistant turn with no text and no tool call", () => {
    expect(assistantTurnIsSendable("assistant", [])).toBe(false);
    expect(assistantTurnIsSendable("assistant", [text("")])).toBe(false);
    expect(assistantTurnIsSendable("assistant", [text("   ")])).toBe(false);
  });

  it("accepts an assistant turn with text", () => {
    expect(assistantTurnIsSendable("assistant", [text("the draft")])).toBe(true);
  });

  it("accepts an assistant turn with a tool call and no text", () => {
    expect(assistantTurnIsSendable("assistant", [tool()])).toBe(true);
  });

  it("never rejects non-assistant roles", () => {
    expect(assistantTurnIsSendable("user", [text("")])).toBe(true);
    expect(assistantTurnIsSendable("system", [])).toBe(true);
  });
});
