import { describe, expect, it } from "vitest";
import { approvalPreview, riskForTool } from "./tool-risk";

describe("tool approval presentation rules", () => {
  it("classifies local, executable, and external tools", () => {
    expect(riskForTool("read")).toBe("READ");
    expect(riskForTool("write")).toBe("WRITE_LOCAL");
    expect(riskForTool("bash")).toBe("EXEC");
    expect(riskForTool("mcp__tavily__search")).toBe("EXTERNAL");
  });

  it("clamps previews by both line and character bounds", () => {
    const preview = approvalPreview("bash", { command: Array.from({ length: 8 }, (_, i) => `${i}: ${"x".repeat(90)}`).join("\n") });
    expect(preview.split("\n")).toHaveLength(5);
    expect(preview.length).toBeLessThanOrEqual(421);
    expect(preview.endsWith("…")).toBe(true);
  });
});
