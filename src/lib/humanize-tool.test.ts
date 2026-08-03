import { describe, expect, it } from "vitest";
import { humanizeTool, humanizedText } from "./humanize-tool";

describe("humanizeTool", () => {
  it("turns coding tools into concise English summaries", () => {
    expect(humanizedText("write", { path: "runbook.md" })).toBe("Wrote runbook.md");
    expect(humanizedText("grep", { pattern: "retry" })).toBe("Searched the code for “retry”");
  });

  it("prefers the model's description for shell commands", () => {
    expect(humanizedText("bash", { command: "rm -rf tmp", description: "Cleaned the generated files" }))
      .toBe("Cleaned the generated files");
  });

  it("handles unknown and external tools without exposing an argument dump", () => {
    expect(humanizeTool("svc__slack__post_message", { channel: "alerts", text: "hello" }))
      .toEqual({ pre: "Used", obj: "post_message" });
    expect(humanizedText("mystery_tool")).toBe("Used mystery_tool");
  });

  it("bounds long display objects", () => {
    const result = humanizeTool("read", { path: "a".repeat(300) });
    expect(result.obj).toHaveLength(160);
    expect(result.obj?.endsWith("…")).toBe(true);
  });
});
