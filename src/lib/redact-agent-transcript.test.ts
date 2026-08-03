import { describe, expect, it } from "vitest";
import { redactAgentToolCall, redactSensitiveText, redactToolOutput, redactTranscriptValue } from "./redact-agent-transcript";

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

  it("redacts authorization schemes and parsed JSON output", () => {
    expect(redactSensitiveText("Authorization: Bearer abc123")).toBe("Authorization: [redacted]");
    expect(redactAgentToolCall({ name: "svc__x__get", output: JSON.stringify({ authorization: "Bearer abc123", ok: true }) }).output)
      .toBe(JSON.stringify({ authorization: "[redacted]", ok: true }));
    expect(redactAgentToolCall({ name: "bash", output: '"TOKEN=abc"' }).output).toBe('"TOKEN=[redacted]"');
  });

  it("keeps the tool-call shape while redacting persisted fields", () => {
    expect(redactAgentToolCall({ name: "bash", args: { command: "TOKEN=abc run" }, output: "token=xyz" })).toEqual({
      name: "bash",
      args: { command: "TOKEN=[redacted] run" },
      output: "token=[redacted]",
    });
  });

  it("redacts error fields on tool calls", () => {
    expect(redactAgentToolCall({ name: "bash", error: "API_KEY=abc failed" }).error).toBe("API_KEY=[redacted] failed");
    expect(redactAgentToolCall({ name: "bash" }).error).toBeUndefined();
  });

  it("redacts the new keys via the plain-text fallback (non-JSON output)", () => {
    expect(redactToolOutput("AUTH=abc123 COOKIE=xyz CREDENTIAL=cred PRIVATE_KEY=key")).toBe(
      "AUTH=[redacted] COOKIE=[redacted] CREDENTIAL=[redacted] PRIVATE_KEY=[redacted]"
    );
  });

  it("redacts the new keys via the invalid-JSON fallback", () => {
    expect(redactToolOutput('{bad json "cookie":"a=1; b=2", "private_key":"pem"}')).toBe(
      '{bad json "cookie":"[redacted]", "private_key":"[redacted]"}'
    );
  });

  it("caps oversized tool outputs before parsing or redacting the full payload", () => {
    const large = JSON.stringify({ data: "x".repeat(50_000), apiKey: "secret" });
    expect(redactToolOutput(large)!.length).toBeLessThanOrEqual(8_000);
    const nonJson = ("token=abc ").repeat(20_000);
    expect(redactToolOutput(nonJson)!.length).toBeLessThanOrEqual(8_000);
  });
});
