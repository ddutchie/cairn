/**
 * Token-breakdown image-content guard.
 *
 * A multimodal user message carries an OpenAI parts array
 * (`[{type:"text"}, {type:"image_url", image_url:{url:"data:...base64..."}}]`)
 * rather than a plain string. `calculatePromptBreakdown` used to stringify that
 * whole array, so the giant base64 data URL was tokenised verbatim — inflating
 * the conversation count (and the context ring) by orders of magnitude.
 *
 * These tests lock in that image parts contribute a small flat estimate, NOT
 * the length of their base64 payload, and that text parts are still counted.
 */
import { describe, it, expect } from "vitest";
import { calculatePromptBreakdown, type OpenAIMessage } from "./llm";

// A ~40KB base64 data URL — realistic for a small screenshot. If this were
// tokenised, it would be tens of thousands of tokens.
const BIG_DATA_URL = "data:image/png;base64," + "A".repeat(40_000);

function multimodalUser(text: string): OpenAIMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: BIG_DATA_URL } },
    ],
  } as unknown as OpenAIMessage;
}

describe("calculatePromptBreakdown image handling", () => {
  it("does not tokenise the base64 data URL of an image part", () => {
    const b = calculatePromptBreakdown(undefined, [multimodalUser("what is this?")]);
    // The 40KB base64 blob alone would be well over 10k tokens if counted.
    expect(b.conversation).toBeLessThan(2_000);
  });

  it("still counts the text part of a multimodal message", () => {
    const withText = calculatePromptBreakdown(undefined, [multimodalUser("describe the architecture diagram in detail please")]);
    const noText = calculatePromptBreakdown(undefined, [multimodalUser("")]);
    expect(withText.conversation).toBeGreaterThan(noText.conversation);
  });

  it("counts a plain-string message the same as before", () => {
    const b = calculatePromptBreakdown(undefined, [
      { role: "user", content: "hello world" },
    ]);
    expect(b.conversation).toBeGreaterThan(0);
    expect(b.conversation).toBeLessThan(20);
  });

  it("is dominated by the flat per-image estimate, not payload size", () => {
    const small = calculatePromptBreakdown(undefined, [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100) } },
        ],
      } as unknown as OpenAIMessage,
    ]);
    const big = calculatePromptBreakdown(undefined, [multimodalUser("hi")]);
    // A 400x larger base64 payload must not change the count — images are flat.
    expect(big.conversation).toBe(small.conversation);
  });
});
