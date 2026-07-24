import { describe, it, expect } from "vitest";
import {
  namespaceServiceTool,
  parseServiceToolName,
  isServiceToolName,
  parseToolDefinition,
  serviceToOpenAI,
  coerceArgs,
  buildRequest,
  filterResponse,
  sampleArgsFromSchema,
  type CustomServiceRuntimeConfig,
} from "./service-exec";

const cfg: CustomServiceRuntimeConfig = {
  id: "svc1",
  apiUrl: "https://api.example.com/search",
  method: "GET",
  headers: { Authorization: "Bearer literal" },
  toolDefinition: JSON.stringify({
    name: "search",
    description: "Search things",
    parameters: { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } } },
  }),
};

describe("service-exec: name namespacing", () => {
  it("round-trips a namespaced tool name", () => {
    const n = namespaceServiceTool("svc1", "search");
    expect(n).toBe("svc__svc1__search");
    expect(parseServiceToolName(n)).toEqual({ serviceId: "svc1", toolName: "search" });
    expect(isServiceToolName(n)).toBe(true);
    expect(isServiceToolName("create_note")).toBe(false);
  });
  it("rejects malformed namespaced names", () => {
    expect(parseServiceToolName("svc__")).toBeNull();
    expect(parseServiceToolName("nope")).toBeNull();
  });
});

describe("service-exec: tool definition", () => {
  it("parses bare and OpenAI-wrapped definitions", () => {
    expect(parseToolDefinition(cfg.toolDefinition).name).toBe("search");
    const wrapped = JSON.stringify({ type: "function", function: { name: "x", description: "d", parameters: {} } });
    expect(parseToolDefinition(wrapped).name).toBe("x");
  });
  it("namespaces the OpenAI function name", () => {
    expect(serviceToOpenAI(cfg).function.name).toBe("svc__svc1__search");
  });
});

describe("service-exec: arg coercion", () => {
  it("coerces stringified numbers to their declared type", () => {
    const out = coerceArgs({ q: "hi", n: "10" }, parseToolDefinition(cfg.toolDefinition).parameters);
    expect(out.n).toBe(10);
    expect(out.q).toBe("hi");
  });
});

describe("service-exec: request building", () => {
  it("puts args on the query string for GET", () => {
    const { url, init } = buildRequest(cfg, { q: "hi", n: 3 }, cfg.headers!, parseToolDefinition(cfg.toolDefinition).parameters);
    expect(url).toContain("q=hi");
    expect(url).toContain("n=3");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
  it("puts args in a JSON body for POST + adds content-type", () => {
    const post = { ...cfg, method: "POST" as const };
    const { init } = buildRequest(post, { q: "hi" }, {}, undefined);
    expect(init.body).toBe(JSON.stringify({ q: "hi" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("service-exec: response filtering", () => {
  it("keeps only wanted keys at any depth", () => {
    const filtered = filterResponse({ web: { results: [{ title: "T", url: "U", junk: 1 }] } }, ["title", "url"]);
    expect(filtered).toEqual({ web: { results: [{ title: "T", url: "U" }] } });
  });
  it("returns everything when no keys given", () => {
    expect(filterResponse({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("service-exec: sample args", () => {
  it("populates required fields with typed placeholders", () => {
    const params = { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["q"] };
    const sample = sampleArgsFromSchema(params);
    expect(sample.q).toBe("test");
    expect(sample.n).toBeUndefined(); // not required, no hint
  });
});
