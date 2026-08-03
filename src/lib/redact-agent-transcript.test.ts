import { describe, expect, it } from "vitest";
import { redactAgentToolCall, redactSensitiveText, redactTranscriptValue } from "./redact-agent-transcript";

describe("redact agent transcript", () => {
  it("redacts sensitive keys recursively", () => {
    expect(redactTranscriptValue({ headers: { Authorization: "Bearer abc" }, nested: { apiKey: "key" } })).toEqual({
      headers: { Authorization: "[redacted]" },
      nested: { apiKey: "[redacted]" },
    });
  });

  it("redacts sensitive assignments in command and output text", () => {
    expect(redactSensitiveText("API_KEY=abc TOKEN:xyz ordinary")).toBe("API_KEY=[redacted] TOKEN:[redacted] ordinary");
  });

  it("keeps the tool-call shape while redacting persisted fields", () => {
    expect(redactAgentToolCall({ name: "bash", args: { command: "TOKEN=abc run" }, output: "token=xyz" })).toEqual({
      name: "bash",
      args: { command: "TOKEN=[redacted] run" },
      output: "token=[redacted]",
    });
  });
});
