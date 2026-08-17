import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingPanel } from "./ThinkingPanel";

/**
 * Regression suite for the Thinking panel's expanded/collapsed behaviour.
 *
 * Guards against the streaming flash bug: the panel must derive "expanded while
 * thinking" from props (no state-driven auto-collapse effects that could
 * re-open on a remount), honour a single manual override, and auto-collapse
 * the moment the answer (companionContent) starts streaming.
 */

function expanded(): boolean {
  return screen.getByRole("button").getAttribute("aria-expanded") === "true";
}

describe("ThinkingPanel expanded state", () => {
  it("auto-expands while the model is thinking (reasoning present, no answer yet)", () => {
    render(<ThinkingPanel streaming text="step by step" companionContent="" />);
    expect(expanded()).toBe(true);
  });

  it("collapses by default for a persisted (non-streaming) message", () => {
    render(<ThinkingPanel text="step by step" />);
    expect(expanded()).toBe(false);
  });

  it("auto-collapses the moment companion content starts streaming", () => {
    const { rerender } = render(<ThinkingPanel streaming text="step by step" companionContent="" />);
    expect(expanded()).toBe(true);

    rerender(<ThinkingPanel streaming text="step by step" companionContent="The answer" />);
    expect(expanded()).toBe(false);
  });

  it("first click collapses the panel and the override sticks across the content transition", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkingPanel streaming text="step by step" companionContent="" />);
    expect(expanded()).toBe(true);

    await user.click(screen.getByRole("button"));
    expect(expanded()).toBe(false);

    // The user's choice persists once the answer starts streaming.
    rerender(<ThinkingPanel streaming text="step by step" companionContent="The answer" />);
    expect(expanded()).toBe(false);
  });

  it("keeps a user's collapse while still thinking even across a remount", async () => {
    const user = userEvent.setup();
    // Unique reasoning text so the persisted-override key doesn't collide with
    // other tests (the module-scoped override survives remounts).
    const text = "remount collapse reasoning trace";
    const { unmount } = render(<ThinkingPanel streaming text={text} companionContent="" />);
    expect(expanded()).toBe(true);
    await user.click(screen.getByRole("button"));
    expect(expanded()).toBe(false);
    unmount();

    // A fresh mount (Virtuoso remount mid-stream) must honour the persisted choice.
    render(<ThinkingPanel streaming text={text} companionContent="" />);
    expect(expanded()).toBe(false);
  });
});
