/**
 * Unit tests for host-side subagent control validation
 * (electron/cordis/subagent-control.ts). Bad-request paths reject before
 * touching the shared context, so they run without booting Cordis.
 */
import { describe, it, expect } from "vitest";
import {
  listSubagentChildren,
  interruptSubagentChild,
  messageSubagentChild,
  SubagentControlError,
} from "./subagent-control";

describe("subagent-control validation", () => {
  it("list rejects empty parent ids", async () => {
    await expect(listSubagentChildren("")).rejects.toMatchObject({ code: "bad-request" });
    await expect(listSubagentChildren("   ")).rejects.toMatchObject({ code: "bad-request" });
  });

  it("interrupt rejects empty ids", async () => {
    await expect(interruptSubagentChild("", "child-1")).rejects.toMatchObject({ code: "bad-request" });
    await expect(interruptSubagentChild("parent-1", "")).rejects.toMatchObject({ code: "bad-request" });
  });

  it("message rejects empty ids, empty text, and oversized text", async () => {
    await expect(messageSubagentChild("", "child-1", "hi")).rejects.toMatchObject({ code: "bad-request" });
    await expect(messageSubagentChild("parent-1", "", "hi")).rejects.toMatchObject({ code: "bad-request" });
    await expect(messageSubagentChild("parent-1", "child-1", "   ")).rejects.toMatchObject({ code: "bad-request" });
    await expect(messageSubagentChild("parent-1", "child-1", "x".repeat(8001))).rejects.toMatchObject({ code: "bad-request" });
  });

  it("control errors carry stable codes", () => {
    expect(new SubagentControlError("parent-unavailable", "nope").code).toBe("parent-unavailable");
  });
});
