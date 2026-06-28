import { describe, it, expect, vi } from "vitest";

// custom-services imports secure-store (which pulls in electron). Stub it; we
// only test the pure helpers here.
vi.mock("electron", () => ({
  app: { isReady: () => false, getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  namespaceServiceTool,
  parseServiceToolName,
  isServiceToolName,
  parseToolDefinition,
  serviceToOpenAI,
  buildRequest,
  filterResponse,
  type CustomServiceRuntimeConfig,
} from "./custom-services";

const baseCfg: CustomServiceRuntimeConfig = {
  id: "svc1",
  apiUrl: "https://api.example.com/search",
  method: "GET",
  headers: { Authorization: "Bearer literal" },
  toolDefinition: JSON.stringify({
    name: "search",
    description: "Search things",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  }),
  responseKeys: [],
};

describe("custom-services namespacing", () => {
  it("namespaces + round-trips", () => {
    const ns = namespaceServiceTool("svc1", "search");
    expect(ns).toBe("svc__svc1__search");
    expect(parseServiceToolName(ns)).toEqual({ serviceId: "svc1", toolName: "search" });
  });

  it("rejects MCP + builtin names", () => {
    expect(parseServiceToolName("mcp__srv1__search")).toBeNull();
    expect(parseServiceToolName("read")).toBeNull();
    expect(isServiceToolName("svc__a__b")).toBe(true);
    expect(isServiceToolName("mcp__a__b")).toBe(false);
  });
});

describe("custom-services tool definition parsing", () => {
  it("parses a bare definition object", () => {
    const def = parseToolDefinition(baseCfg.toolDefinition);
    expect(def.name).toBe("search");
    expect(def.description).toBe("Search things");
    expect(def.parameters).toEqual({ type: "object", properties: { q: { type: "string" } } });
  });

  it("parses the full OpenAI wrapper form", () => {
    const def = parseToolDefinition(
      JSON.stringify({ type: "function", function: { name: "lookup", description: "d" } })
    );
    expect(def.name).toBe("lookup");
  });

  it("serviceToOpenAI namespaces the function name", () => {
    expect(serviceToOpenAI(baseCfg).function.name).toBe("svc__svc1__search");
  });
});

describe("custom-services request building", () => {
  it("GET puts args on the query string", () => {
    const { url, init } = buildRequest(baseCfg, { q: "cats", limit: 5 }, { Authorization: "Bearer x" });
    expect(url).toBe("https://api.example.com/search?q=cats&limit=5");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer x" });
  });

  it("DELETE also uses query params", () => {
    const { url, init } = buildRequest({ ...baseCfg, method: "DELETE" }, { id: "7" }, {});
    expect(url).toBe("https://api.example.com/search?id=7");
    expect(init.body).toBeUndefined();
  });

  it("POST puts args in a JSON body and defaults Content-Type", () => {
    const { url, init } = buildRequest({ ...baseCfg, method: "POST" }, { q: "cats" }, {});
    expect(url).toBe("https://api.example.com/search");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ q: "cats" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("POST keeps a caller-supplied Content-Type (case-insensitive)", () => {
    const { init } = buildRequest({ ...baseCfg, method: "POST" }, {}, { "content-type": "text/plain" });
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("GET serialises object args to JSON and skips null/undefined", () => {
    const { url } = buildRequest(baseCfg, { filter: { a: 1 }, skip: null, miss: undefined }, {});
    expect(url).toContain("filter=%7B%22a%22%3A1%7D");
    expect(url).not.toContain("skip");
    expect(url).not.toContain("miss");
  });
});

describe("custom-services response filtering", () => {
  it("returns value unchanged when no keys given", () => {
    const v = { a: 1, b: 2 };
    expect(filterResponse(v, [])).toBe(v);
    expect(filterResponse(v, undefined)).toBe(v);
  });

  it("keeps top-level wanted keys and their whole subtree", () => {
    const v = { title: "x", junk: "y", nested: { keep: 1 } };
    expect(filterResponse(v, ["title", "nested"])).toEqual({ title: "x", nested: { keep: 1 } });
  });

  it("surfaces a wanted key nested deeper", () => {
    const v = { data: { results: [{ name: "a", score: 9 }, { name: "b", score: 3 }] } };
    expect(filterResponse(v, ["name"])).toEqual({
      data: { results: [{ name: "a" }, { name: "b" }] },
    });
  });

  it("maps arrays at the top level", () => {
    const v = [{ name: "a", x: 1 }, { name: "b", x: 2 }];
    expect(filterResponse(v, ["name"])).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("drops object branches that contain no wanted keys", () => {
    const v = { wanted: 1, empty: { nope: 2 } };
    expect(filterResponse(v, ["wanted"])).toEqual({ wanted: 1 });
  });
});
