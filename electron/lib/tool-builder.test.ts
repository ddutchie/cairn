import { describe, it, expect, vi } from "vitest";

// tool-builder imports secure-store (→ electron) for isPlaceholder.
vi.mock("electron", () => ({
  app: { isReady: () => false, getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  extractJsonKeys,
  suggestResponseKeys,
  synthesizeParams,
  hasPlaceholder,
  detectSecretHeaders,
  parseAuthHint,
  validateServiceDraft,
  validateMcpDraft,
  inferTransport,
  NOISY_KEYS,
} from "./tool-builder";

describe("tool-builder key extraction", () => {
  it("descends into results arrays", () => {
    const sample = {
      success: true,
      results: [{ title: "a", url: "u1", snippet: "s" }],
      number_of_results: 1,
    };
    const keys = extractJsonKeys(sample);
    expect(keys).toContain("title");
    expect(keys).toContain("url");
    expect(keys).toContain("snippet");
    expect(keys).toContain("results");
  });

  it("descends into items arrays and nested objects", () => {
    const sample = { data: { items: [{ id: 1, meta: { author: "x" } }] } };
    const keys = extractJsonKeys(sample);
    expect(keys).toEqual(expect.arrayContaining(["data", "items", "id", "meta", "author"]));
  });

  it("returns empty for primitives", () => {
    expect(extractJsonKeys("hello")).toEqual([]);
    expect(extractJsonKeys(42)).toEqual([]);
  });
});

describe("tool-builder suggestResponseKeys (optimizer port)", () => {
  it("drops NOISY_KEYS and keeps signal keys", () => {
    const sample = {
      success: true,
      status: "ok",
      query: "cats",
      number_of_results: 2,
      results: [{ title: "a", url: "u", snippet: "s" }],
    };
    const { responseKeys } = suggestResponseKeys(sample);
    expect(responseKeys).toContain("results");
    expect(responseKeys).toContain("title");
    expect(responseKeys).toContain("url");
    expect(responseKeys).toContain("snippet");
    for (const noisy of ["success", "status", "query", "number_of_results"]) {
      expect(responseKeys).not.toContain(noisy);
    }
  });

  it("reports token savings (after <= before)", () => {
    const sample = {
      success: true,
      version: "1.0",
      results: [{ title: "a", url: "u", snippet: "long snippet ".repeat(20), junk: "x".repeat(200) }],
    };
    const { tokensBefore, tokensAfter, savedPct } = suggestResponseKeys(sample);
    expect(tokensAfter).toBeLessThanOrEqual(tokensBefore);
    expect(savedPct).toBeGreaterThanOrEqual(0);
  });

  it("NOISY_KEYS matches the documented denylist", () => {
    expect([...NOISY_KEYS].sort()).toEqual(
      ["api", "number_of_results", "page", "query", "search_query", "status", "success", "type", "version"].sort()
    );
  });
});

describe("tool-builder param synthesis", () => {
  it("strings → 'test', others → 1", () => {
    const params = synthesizeParams({
      properties: { q: { type: "string" }, limit: { type: "number" }, on: { type: "boolean" } },
    });
    expect(params).toEqual({ q: "test", limit: 1, on: 1 });
  });

  it("honours default and example", () => {
    const params = synthesizeParams({
      properties: { q: { type: "string", default: "dogs" }, n: { type: "number", example: 5 } },
    });
    expect(params).toEqual({ q: "dogs", n: 5 });
  });

  it("empty for no properties", () => {
    expect(synthesizeParams(undefined)).toEqual({});
    expect(synthesizeParams({})).toEqual({});
  });
});

describe("tool-builder placeholder detection", () => {
  it("recognises all placeholder tokens", () => {
    for (const t of ["<API_KEY>", "YOUR_API_KEY", "<ACCESS_TOKEN>", "<TOKEN>"]) {
      expect(hasPlaceholder(t)).toBe(true);
      expect(hasPlaceholder(`Bearer ${t}`)).toBe(true);
    }
    expect(hasPlaceholder("Bearer sk-real")).toBe(false);
  });

  it("detects which headers need secrets", () => {
    const headers = {
      Authorization: "Bearer <API_KEY>",
      "Content-Type": "application/json",
      "X-Api-Key": "YOUR_API_KEY",
    };
    expect(detectSecretHeaders(headers).sort()).toEqual(["Authorization", "X-Api-Key"]);
  });
});

describe("tool-builder auth hint parsing", () => {
  it("non-auth status → needsAuth false", () => {
    expect(parseAuthHint(200, {}, "{}").needsAuth).toBe(false);
    expect(parseAuthHint(404, {}, "not found").needsAuth).toBe(false);
  });

  it("WWW-Authenticate Bearer → bearer scheme", () => {
    const hint = parseAuthHint(401, { "www-authenticate": 'Bearer realm="api"' }, "");
    expect(hint).toMatchObject({ needsAuth: true, scheme: "bearer", headerName: "Authorization" });
  });

  it("Basic challenge → basic scheme", () => {
    const hint = parseAuthHint(401, { "www-authenticate": "Basic" }, "");
    expect(hint.scheme).toBe("basic");
  });

  it("api-key body hint → apikey scheme", () => {
    const hint = parseAuthHint(403, {}, JSON.stringify({ error: "missing api_key" }));
    expect(hint.needsAuth).toBe(true);
    expect(["apikey", "query"]).toContain(hint.scheme);
  });

  it("unknown auth → unknown scheme", () => {
    const hint = parseAuthHint(401, {}, "forbidden");
    expect(hint).toMatchObject({ needsAuth: true, scheme: "unknown" });
  });
});

describe("tool-builder finalize validation", () => {
  const validToolDef = JSON.stringify({ name: "search", description: "d", parameters: {} });

  it("accepts a well-formed service draft", () => {
    const res = validateServiceDraft({
      name: "Search",
      apiUrl: "https://api.example.com",
      method: "GET",
      toolDefinition: validToolDef,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects bad url / method / tool def", () => {
    const res = validateServiceDraft({
      name: "",
      apiUrl: "ftp://nope",
      method: "PATCH" as never,
      toolDefinition: "{not json",
    });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects tool def without a function name", () => {
    const res = validateServiceDraft({
      name: "X",
      apiUrl: "https://x.com",
      method: "GET",
      toolDefinition: JSON.stringify({ description: "no name" }),
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("function name");
  });

  it("validates MCP drafts + infers transport", () => {
    expect(validateMcpDraft({ name: "W", baseUrl: "https://mcp.x.com/sse" }).ok).toBe(true);
    expect(validateMcpDraft({ name: "", baseUrl: "nope" }).ok).toBe(false);
    expect(inferTransport("https://mcp.x.com/sse")).toBe("sse");
    expect(inferTransport("https://mcp.x.com/mcp")).toBe("http");
  });
});
