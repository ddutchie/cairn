/**
 * Unit tests for doom-loop detection in the agent loop.
 */

import { describe, it, expect } from "vitest";
import { toolCallSignature, DOOM_LOOP_THRESHOLD } from "./pi-agent-loop";

describe("toolCallSignature", () => {
  it("is stable across key order", () => {
    expect(toolCallSignature("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }))
      .toBe(toolCallSignature("edit", { edits: [{ newText: "y", oldText: "x" }], path: "a.ts" }));
  });

  it("distinguishes different args", () => {
    expect(toolCallSignature("edit", { path: "a.ts" }))
      .not.toBe(toolCallSignature("edit", { path: "b.ts" }));
  });

  it("distinguishes different tools", () => {
    expect(toolCallSignature("read", { path: "a.ts" }))
      .not.toBe(toolCallSignature("write", { path: "a.ts" }));
  });
});

describe("DOOM_LOOP_THRESHOLD", () => {
  it("matches opencode's threshold of 3", () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
  });
});
