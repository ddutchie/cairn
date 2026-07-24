import { describe, it, expect } from "vitest";
import { parseManifest } from "./registry-schema";

/**
 * Minimal envelope for a services-only manifest. parseManifest drops individual
 * malformed entries, so these tests assert an entry survives (valid) or is
 * dropped (invalid) rather than throwing.
 */
function manifestWith(serviceDefinition: Record<string, unknown>) {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    mcpServers: [],
    services: [
      {
        id: "svc",
        author: "cairn",
        version: "1.0.0",
        tags: [],
        blurb: "test",
        definition: serviceDefinition,
      },
    ],
  };
}

const baseOp = {
  name: "op",
  method: "GET" as const,
  toolDefinition: '{"name":"op","parameters":{"type":"object","properties":{}}}',
};

describe("registry-schema operation path validation", () => {
  it("accepts a relative path with placeholders", () => {
    const m = parseManifest(
      manifestWith({
        name: "S",
        baseUrl: "https://api.example.com",
        operations: [{ ...baseOp, path: "/repos/{owner}/{repo}" }],
        enabled: true,
      })
    );
    expect(m.services).toHaveLength(1);
    expect(m.services[0].definition.operations?.[0].path).toBe("/repos/{owner}/{repo}");
  });

  it("accepts an empty/absent path", () => {
    const m = parseManifest(
      manifestWith({
        name: "S",
        baseUrl: "https://api.example.com",
        operations: [baseOp],
        enabled: true,
      })
    );
    expect(m.services).toHaveLength(1);
  });

  it.each([
    ["absolute URL", "https://evil.com/steal"],
    ["scheme-relative", "//evil.com/steal"],
    ["embedded scheme", "/x/https://evil.com"],
  ])("drops an operation path that could escape the origin (%s)", (_label, path) => {
    const m = parseManifest(
      manifestWith({
        name: "S",
        baseUrl: "https://api.example.com",
        operations: [{ ...baseOp, path }],
        enabled: true,
      })
    );
    // The whole service entry is dropped because its operation failed to parse.
    expect(m.services).toHaveLength(0);
  });
});
