import { describe, it, expect } from "vitest";
import { hasPromptFired, markPromptFired, forgetSessionPrompts } from "./agent-prompt-guard";

describe("agent-prompt-guard", () => {
  it("tracks whether a session has fired a prompt, defaulting to false", () => {
    expect(hasPromptFired("s-1")).toBe(false);
    markPromptFired("s-1");
    expect(hasPromptFired("s-1")).toBe(true);
  });

  it("is additive across sessions (survives pane remounts)", () => {
    markPromptFired("a");
    markPromptFired("b");
    expect(hasPromptFired("a")).toBe(true);
    expect(hasPromptFired("b")).toBe(true);
    expect(hasPromptFired("c")).toBe(false);
  });

  it("forgets a session when it is destroyed so the guard resets", () => {
    markPromptFired("gone");
    expect(hasPromptFired("gone")).toBe(true);
    forgetSessionPrompts("gone");
    expect(hasPromptFired("gone")).toBe(false);
  });

  it("forgetSessionPrompts only affects the target session", () => {
    markPromptFired("keep");
    markPromptFired("drop");
    forgetSessionPrompts("drop");
    expect(hasPromptFired("keep")).toBe(true);
    expect(hasPromptFired("drop")).toBe(false);
  });
});
