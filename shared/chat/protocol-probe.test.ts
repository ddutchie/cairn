import { describe, it, expect } from "vitest";
import { classifyProtocolProbe, protocolProbeRequest } from "./protocol-probe";

describe("classifyProtocolProbe", () => {
  it("reads OpenCode's per-model refusal as unsupported, not missing", () => {
    expect(classifyProtocolProbe(400, '{"error":{"message":"Model does not support this protocol."}}')).toBe("unsupported");
  });

  it("treats a validation error about the probe body as available", () => {
    expect(classifyProtocolProbe(400, '{"error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}')).toBe("available");
    expect(classifyProtocolProbe(422, '{"detail":"input must not be empty"}')).toBe("available");
    expect(classifyProtocolProbe(200, "{}")).toBe("available");
  });

  it("separates missing routes, refused keys and unreadable answers", () => {
    expect(classifyProtocolProbe(404, "Not Found")).toBe("missing");
    expect(classifyProtocolProbe(405, "")).toBe("missing");
    expect(classifyProtocolProbe(401, "bad key")).toBe("auth");
    expect(classifyProtocolProbe(400, "Bad Request")).toBe("unknown");
    expect(classifyProtocolProbe(502, "upstream")).toBe("unknown");
  });
});

describe("protocolProbeRequest", () => {
  it("never asks for a real generation", () => {
    expect(protocolProbeRequest("completions", "m")).toMatchObject({ path: "chat/completions", body: { model: "m", messages: [], max_tokens: 1 } });
    expect(protocolProbeRequest("responses", "m")).toMatchObject({ path: "responses", body: { model: "m", input: [] } });
    expect(protocolProbeRequest("anthropic-messages", "m")).toMatchObject({ path: "messages", headers: { "anthropic-version": "2023-06-01" } });
  });
});
