import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ConversationMessageBubble } from "./ConversationMessageBubble";
import type { ConversationMessage } from "./conversation-message";

/**
 * Regression suite for the empty-content bubble.
 *
 * The content bubble carries its own padding and background (`chat-bubble-ai`),
 * so rendering it with an empty `content` produced a visibly blank second
 * "message" underneath the thinking panel. That is the state of every
 * reasoning-only or tool-only step, where the model streams thinking (or calls a
 * tool) before writing any text.
 *
 * Chat never showed it because its live turn is drawn by `ToolCallIndicator`,
 * which guards on `hasContent`; the Coding agent streams through real
 * `AgentMessage`s and so hit the unguarded shared bubble. These tests pin the
 * guard into the shared component so the two paths cannot drift again.
 */

function message(over: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** The content bubble is the only element carrying the chat-bubble-* class. */
function bubbleCount(container: HTMLElement): number {
  return container.querySelectorAll("[class*='chat-bubble-']").length;
}

describe("ConversationMessageBubble — empty content", () => {
  it("renders NO content bubble for a reasoning-only streaming message", () => {
    const { container } = render(
      <ConversationMessageBubble message={message({ reasoning: "thinking hard", isStreaming: true })} />,
    );
    expect(bubbleCount(container)).toBe(0);
  });

  it("renders NO content bubble for a whitespace-only message", () => {
    const { container } = render(
      <ConversationMessageBubble message={message({ content: "   \n  ", reasoning: "r", isStreaming: true })} />,
    );
    expect(bubbleCount(container)).toBe(0);
  });

  it("renders the content bubble once text arrives alongside reasoning", () => {
    const { container } = render(
      <ConversationMessageBubble message={message({ content: "the answer", reasoning: "r", isStreaming: true })} />,
    );
    expect(bubbleCount(container)).toBe(1);
    expect(container.textContent).toContain("the answer");
  });

  it("renders NO content bubble for a tool-only message (no text, not streaming)", () => {
    const { container } = render(
      <ConversationMessageBubble
        message={message({ toolCalls: [{ callId: "c1", name: "read", label: "read", running: false, ok: true }] })}
      />,
    );
    expect(bubbleCount(container)).toBe(0);
  });

  it("still shows a bubble (for the cursor) when a streaming turn has nothing else on screen", () => {
    // Equivalent of Chat's "Thinking…" placeholder — a live turn must never
    // render as completely empty.
    const { container } = render(
      <ConversationMessageBubble message={message({ isStreaming: true })} />,
    );
    expect(bubbleCount(container)).toBe(1);
  });

  it("renders a settled message with content normally", () => {
    const { container } = render(
      <ConversationMessageBubble message={message({ content: "done" })} />,
    );
    expect(bubbleCount(container)).toBe(1);
    expect(container.textContent).toContain("done");
  });

  it("renders the user bubble for a normal user message", () => {
    const { container } = render(
      <ConversationMessageBubble message={message({ role: "user", content: "hello" })} />,
    );
    expect(bubbleCount(container)).toBe(1);
  });

  it("does not render an empty user bubble for an image-only message", () => {
    const { container } = render(
      <ConversationMessageBubble
        message={message({ role: "user", images: [{ url: "data:,", name: "shot.png", kind: "image" }] })}
      />,
    );
    expect(bubbleCount(container)).toBe(0);
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("keeps error and system messages unaffected (they have their own layout)", () => {
    const err = render(<ConversationMessageBubble message={message({ role: "error", content: "boom" })} />);
    expect(err.container.textContent).toContain("boom");

    const sys = render(<ConversationMessageBubble message={message({ role: "system", content: "compacted" })} />);
    expect(sys.container.textContent).toContain("compacted");
  });
});
