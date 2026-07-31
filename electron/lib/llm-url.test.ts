import { describe, expect, it } from "vitest";
import { normaliseBaseUrl, buildApiUrl } from "./llm";

describe("normaliseBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normaliseBaseUrl("https://api.openai.com/")).toBe("https://api.openai.com");
    expect(normaliseBaseUrl("https://api.openai.com///")).toBe("https://api.openai.com");
  });

  it("preserves a trailing /v1 (no longer stripped)", () => {
    expect(normaliseBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });

  it("preserves a /v1 that is not at the end", () => {
    expect(normaliseBaseUrl("https://api-gateway.merge.dev/v1/openai")).toBe(
      "https://api-gateway.merge.dev/v1/openai",
    );
  });
});

describe("buildApiUrl", () => {
  it("appends /v1 when the base has no version segment", () => {
    expect(buildApiUrl("https://api.openai.com", "chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildApiUrl("https://api.openai.com", "models")).toBe("https://api.openai.com/v1/models");
  });

  it("does not double up when the base ends in /v1", () => {
    expect(buildApiUrl("https://api.openai.com/v1", "chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("respects a /v1 segment that is not at the end of the path", () => {
    expect(buildApiUrl("https://api-gateway.merge.dev/v1/openai", "chat/completions")).toBe(
      "https://api-gateway.merge.dev/v1/openai/chat/completions",
    );
    expect(buildApiUrl("https://api-gateway.merge.dev/v1/openai", "models")).toBe(
      "https://api-gateway.merge.dev/v1/openai/models",
    );
  });

  it("handles trailing slashes on the base and leading slashes on the path", () => {
    expect(buildApiUrl("https://api.openai.com/", "/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("handles a versioned local endpoint", () => {
    expect(buildApiUrl("http://localhost:1234/v1", "models")).toBe("http://localhost:1234/v1/models");
    expect(buildApiUrl("http://localhost:1234", "models")).toBe("http://localhost:1234/v1/models");
  });

  it("supports other version numbers", () => {
    expect(buildApiUrl("https://example.com/v2/openai", "chat/completions")).toBe(
      "https://example.com/v2/openai/chat/completions",
    );
  });

  it("tolerates a base URL without a scheme", () => {
    expect(buildApiUrl("api.openai.com", "models")).toBe("api.openai.com/v1/models");
  });
});
