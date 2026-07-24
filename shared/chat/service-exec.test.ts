import { describe, it, expect } from "vitest";
import {
  namespaceServiceTool,
  parseServiceToolName,
  isServiceToolName,
  parseToolDefinition,
  serviceToOpenAI,
  serviceOperationsToOpenAI,
  resolveOperation,
  normalizeOperations,
  coerceArgs,
  buildRequest,
  buildOperationRequest,
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
// toolDefinition is always set on the test cfg; alias so the widened optional
// type (string | undefined) doesn't require a non-null assertion at each use.
const toolDef = cfg.toolDefinition as string;

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
    expect(parseToolDefinition(toolDef).name).toBe("search");
    const wrapped = JSON.stringify({ type: "function", function: { name: "x", description: "d", parameters: {} } });
    expect(parseToolDefinition(wrapped).name).toBe("x");
  });
  it("namespaces the OpenAI function name", () => {
    expect(serviceToOpenAI(cfg).function.name).toBe("svc__svc1__search");
  });
});

describe("service-exec: arg coercion", () => {
  it("coerces stringified numbers to their declared type", () => {
    const out = coerceArgs({ q: "hi", n: "10" }, parseToolDefinition(toolDef).parameters);
    expect(out.n).toBe(10);
    expect(out.q).toBe("hi");
  });
});

describe("service-exec: request building", () => {
  it("puts args on the query string for GET", () => {
    const { url, init } = buildRequest(cfg, { q: "hi", n: 3 }, cfg.headers!, parseToolDefinition(toolDef).parameters);
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

describe("service-exec: multi-operation", () => {
  const github: CustomServiceRuntimeConfig = {
    id: "github",
    baseUrl: "https://api.github.com",
    headers: { Authorization: "Bearer literal" },
    operations: [
      {
        name: "get_issue",
        method: "GET",
        path: "/repos/{owner}/{repo}/issues/{number}",
        toolDefinition: JSON.stringify({ name: "get_issue", description: "Get an issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "integer" } } } }),
        responseKeys: ["title", "state"],
      },
      {
        name: "create_issue",
        method: "POST",
        path: "/repos/{owner}/{repo}/issues",
        toolDefinition: JSON.stringify({ name: "create_issue", description: "Create an issue", parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } } } }),
        paramLocations: { title: "body", body: "body" },
      },
    ],
  };

  it("exposes one namespaced tool per operation", () => {
    const tools = serviceOperationsToOpenAI(github);
    expect(tools.map((t) => t.function.name)).toEqual(["svc__github__get_issue", "svc__github__create_issue"]);
  });

  it("resolves a namespaced tool name back to its operation", () => {
    const op = resolveOperation(github, "svc__github__create_issue");
    expect(op?.toolName).toBe("create_issue");
    expect(op?.method).toBe("POST");
    expect(resolveOperation(github, "svc__github__nope")).toBeNull();
    expect(resolveOperation(github, "svc__other__get_issue")).toBeNull();
  });

  it("fills path placeholders and puts the rest on the query (GET)", () => {
    const op = resolveOperation(github, "svc__github__get_issue")!;
    const params = parseToolDefinition(op.toolDefinition).parameters;
    const { url, init } = buildOperationRequest(op, { owner: "cairn", repo: "app", number: 42 }, {}, params);
    expect(url).toBe("https://api.github.com/repos/cairn/app/issues/42");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("fills path + routes declared args to the JSON body (POST)", () => {
    const op = resolveOperation(github, "svc__github__create_issue")!;
    const params = parseToolDefinition(op.toolDefinition).parameters;
    const { url, init } = buildOperationRequest(op, { owner: "cairn", repo: "app", title: "Bug", body: "It broke" }, {}, params);
    expect(url).toBe("https://api.github.com/repos/cairn/app/issues");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Bug", body: "It broke" });
  });

  it("URL-encodes path values", () => {
    const op = resolveOperation(github, "svc__github__get_issue")!;
    const { url } = buildOperationRequest(op, { owner: "a b", repo: "x/y", number: 1 }, {}, undefined);
    expect(url).toContain("/repos/a%20b/x%2Fy/issues/1");
  });

  it("normalizes a legacy single-op config into one operation", () => {
    const ops = normalizeOperations(cfg);
    expect(ops).toHaveLength(1);
    expect(ops[0].toolName).toBe("search");
    expect(ops[0].url).toBe("https://api.example.com/search");
    // buildRequest (legacy) still works via the normalized op.
    const { url } = buildRequest(cfg, { q: "hi" }, {}, undefined);
    expect(url).toContain("q=hi");
  });

  it("always sends static query params, model args override them", () => {
    const weather: CustomServiceRuntimeConfig = {
      id: "meteo",
      baseUrl: "https://api.open-meteo.com/v1",
      operations: [
        {
          name: "get_weather",
          method: "GET",
          path: "/forecast",
          query: { current: "temperature_2m,wind_speed_10m" },
          toolDefinition: JSON.stringify({ name: "get_weather", description: "w", parameters: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } } } }),
        },
      ],
    };
    const op = resolveOperation(weather, "svc__meteo__get_weather")!;
    // Model omits `current` (the bug): the static query still forces it.
    const { url } = buildOperationRequest(op, { latitude: 52.52, longitude: 13.41 }, {}, undefined);
    expect(url).toContain("current=temperature_2m%2Cwind_speed_10m");
    expect(url).toContain("latitude=52.52");
    // A model-supplied value of the same name overrides the static default.
    const op2 = resolveOperation(weather, "svc__meteo__get_weather")!;
    const { url: url2 } = buildOperationRequest(op2, { latitude: 1, longitude: 2, current: "rain" }, {}, undefined);
    expect(url2).toContain("current=rain");
  });
});
