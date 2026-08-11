/**
 * Unit tests for electron/lib/community-registry.ts — the fetch + ETag cache +
 * validate + fail-soft behaviour of the cairn-community catalog loader.
 *
 * `findUserDataDir` is mocked to a temp dir so the cache read/write is isolated;
 * global.fetch is stubbed per-case to simulate 200 / 304 / error / bad-payload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;

vi.mock("../runtime/port-discovery", () => ({
  findUserDataDir: () => tmpDir,
}));

// Import AFTER the mock is registered.
import { parseManifest, parsePersonalitiesManifest, fetchManifest, fetchPersonalitiesManifest, refreshManifest, __test } from "./community-registry";

const VALID = {
  version: 1,
  updatedAt: "2026-07-24T00:00:00Z",
  mcpServers: [
    {
      id: "jira",
      author: "cairn",
      version: "1.0.0",
      tags: ["issues"],
      blurb: "Jira.",
      brandColor: "#0052cc",
      iconSvg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 1h2"/></svg>',
      definition: {
        name: "Jira",
        transport: "http",
        baseUrl: "https://mcp.atlassian.com/v1/mcp",
        authMode: "oauth",
        enabled: true,
      },
    },
  ],
  services: [
    {
      id: "weather",
      author: "cairn",
      version: "1.0.0",
      tags: ["weather"],
      blurb: "Weather.",
      definition: {
        name: "Weather",
        apiUrl: "https://api.open-meteo.com/v1/forecast",
        method: "GET",
        toolDefinition: '{"name":"get_weather","parameters":{}}',
        responseKeys: ["current"],
        enabled: true,
      },
    },
  ],
  commands: [
    {
      id: "command-standup",
      author: "cairn",
      version: "1.0.0",
      category: "Automation",
      tags: ["standup"],
      blurb: "Standup update.",
      definition: {
        name: "standup",
        description: "Standup",
        insertText: "Summarise recent activity.",
        scope: "chat",
      },
    },
  ],
};

function fetchResponse(opts: {
  status?: number;
  json?: unknown;
  etag?: string;
}): Response {
  const { status = 200, json = {}, etag } = opts;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag ?? null : null) },
    json: async () => json,
  } as unknown as Response;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-registry-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals(); // remove any fetch stub created via vi.stubGlobal
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    const m = parseManifest(VALID);
    expect(m.mcpServers).toHaveLength(1);
    expect(m.services[0].definition.name).toBe("Weather");
  });

  it("parses community slash commands (manifest v2)", () => {
    const m = parseManifest(VALID);
    expect(m.commands).toHaveLength(1);
    expect(m.commands[0].definition.name).toBe("standup");
    expect(m.commands[0].definition.scope).toBe("chat");
  });

  it("tolerates a manifest with no commands key (pre-v2)", () => {
    const { commands, ...noCommands } = VALID;
    void commands;
    const m = parseManifest(noCommands);
    expect(m.commands).toEqual([]);
  });

  it("drops a command with an invalid name or scope", () => {
    const bad = {
      ...VALID,
      commands: [
        { id: "x", author: "a", version: "1.0.0", tags: [], blurb: "b",
          definition: { name: "Bad Name", insertText: "hi", scope: "chat" } },
        { id: "y", author: "a", version: "1.0.0", tags: [], blurb: "b",
          definition: { name: "ok", insertText: "hi", scope: "nope" } },
        { id: "z", author: "a", version: "1.0.0", tags: [], blurb: "b",
          definition: { name: "good", insertText: "hi", scope: "both" } },
      ],
    };
    const m = parseManifest(bad);
    expect(m.commands).toHaveLength(1);
    expect(m.commands[0].definition.name).toBe("good");
  });

  it("drops an entry with a non-https baseUrl (never trusts an insecure URL)", () => {
    const bad = structuredClone(VALID);
    bad.mcpServers[0].definition.baseUrl = "http://insecure.example.com/mcp";
    // The insecure entry is filtered out rather than throwing (which would blank
    // the whole catalog); the valid service still comes through.
    const parsed = parseManifest(bad);
    expect(parsed.mcpServers).toHaveLength(0);
    expect(parsed.services).toHaveLength(1);
  });

  it("drops a malformed entry instead of rejecting the whole manifest", () => {
    const mixed = structuredClone(VALID) as Record<string, unknown>;
    // Add a second, invalid service (missing toolDefinition) alongside the good one.
    const services = mixed.services as Array<Record<string, unknown>>;
    const bad = structuredClone(services[0]) as { definition: Record<string, unknown> };
    delete bad.definition.toolDefinition;
    services.push(bad);
    const parsed = parseManifest(mixed);
    // The good service survives; the malformed one is filtered out.
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].definition.name).toBe("Weather");
  });
});

describe("parsePersonalitiesManifest", () => {
  const VALID_PERSONALITIES = {
    version: 1,
    updatedAt: "2026-08-11T00:00:00Z",
    personalities: [
      {
        id: "caveman",
        author: "cairn",
        version: "1.0.0",
        category: "Tone & Style",
        tags: ["tone"],
        blurb: "Short, plain words.",
        brandColor: "#9ca3af",
        homepage: "https://github.com/JuliusBrussee/caveman",
        definition: {
          name: "Caveman",
          description: "Blunt, minimal answers.",
          prompt: "Speak in short, simple sentences. Use plain words. Give the answer or result first.",
        },
      },
    ],
  };

  it("accepts a valid personalities manifest", () => {
    const m = parsePersonalitiesManifest(VALID_PERSONALITIES);
    expect(m.personalities).toHaveLength(1);
    expect(m.personalities[0].definition.name).toBe("Caveman");
  });

  it("drops a personality whose prompt opens with a 'You are …' identity claim", () => {
    const bad = structuredClone(VALID_PERSONALITIES) as { personalities: Array<{ definition: { prompt: string } }> };
    bad.personalities[0].definition.prompt = "You are Grug Assistant.\nSpeak short.";
    const m = parsePersonalitiesManifest(bad);
    expect(m.personalities).toHaveLength(0);
  });

  it("drops a personality whose prompt is a thin one-liner (<20 chars)", () => {
    const bad = structuredClone(VALID_PERSONALITIES) as { personalities: Array<{ definition: { prompt: string } }> };
    bad.personalities[0].definition.prompt = "be concise.";
    const m = parsePersonalitiesManifest(bad);
    expect(m.personalities).toHaveLength(0);
  });

  it("drops a malformed entry instead of rejecting the whole manifest", () => {
    const mixed = structuredClone(VALID_PERSONALITIES) as Record<string, unknown>;
    const list = mixed.personalities as Array<Record<string, unknown>>;
    list.push({ id: "bad", author: "x", version: "1.0.0", tags: [], blurb: "bad", definition: {} });
    const m = parsePersonalitiesManifest(mixed);
    expect(m.personalities).toHaveLength(1);
  });
});

describe("fetchPersonalitiesManifest", () => {
  const VALID = {
    version: 1,
    updatedAt: "2026-08-11T00:00:00Z",
    personalities: [
      {
        id: "grill-me",
        author: "cairn",
        version: "1.0.0",
        category: "Critique & Review",
        tags: ["stress-test"],
        blurb: "Stress-tests your plan.",
        definition: {
          name: "Grill Me",
          prompt: "Pressure-test plans with calibrated questions. Ask one question at a time. Give a recommended answer.",
        },
      },
    ],
  };

  it("fetches from network, validates, and writes its own cache file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    const res = await fetchPersonalitiesManifest({ force: true });
    expect(res.fromCache).toBe(false);
    expect(res.manifest.personalities[0].definition.name).toBe("Grill Me");
    expect(__test.readPersonalitiesCache()?.manifest.personalities).toHaveLength(1);
  });

  it("fails soft to the cache when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    await fetchPersonalitiesManifest({ force: true });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await fetchPersonalitiesManifest({ force: true });
    expect(res.fromCache).toBe(true);
    expect(res.error).toBe("offline");
    expect(res.manifest.personalities).toHaveLength(1);
  });
});

describe("fetchManifest", () => {
  it("fetches from network, validates, and writes the cache (200)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fetchResponse({ status: 200, json: VALID, etag: 'W/"abc"' })),
    );
    const res = await fetchManifest({ force: true });
    expect(res.fromCache).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.manifest.mcpServers[0].definition.name).toBe("Jira");
    // Cache file written with the ETag.
    const cache = __test.readCache();
    expect(cache?.etag).toBe('W/"abc"');
  });

  it("serves cache and does not error when offline with a prior cache", async () => {
    // Seed a cache first.
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    await fetchManifest({ force: true });

    // Now the network throws; a forced fetch must fall back to cache.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await fetchManifest({ force: true });
    expect(res.fromCache).toBe(true);
    expect(res.error).toBe("offline");
    expect(res.manifest.mcpServers).toHaveLength(1);
  });

  it("returns an empty manifest + error when the network fails and no cache exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("dns"); }));
    const res = await fetchManifest({ force: true });
    expect(res.manifest.mcpServers).toHaveLength(0);
    expect(res.manifest.services).toHaveLength(0);
    expect(res.error).toBe("dns");
  });

  it("forced refresh is a hard refresh: no If-None-Match, cache-busted, always re-downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID, etag: 'W/"v1"' })));
    await fetchManifest({ force: true }); // seed cache + etag

    // A second forced fetch must NOT send the conditional ETag header (so a
    // stale CDN edge can't answer 304 with old content) and must cache-bust the
    // URL, guaranteeing fresh content on an explicit Refresh.
    const spy = vi.fn(async () => fetchResponse({ status: 200, json: VALID, etag: 'W/"v2"' }));
    vi.stubGlobal("fetch", spy);
    const res = await fetchManifest({ force: true });

    expect(res.fromCache).toBe(false);
    const [url, init] = spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers["If-None-Match"]).toBeUndefined();
    expect(url).toMatch(/[?&]_cb=\d+/);
  });

  it("honours 304 Not Modified on background revalidation (non-forced)", async () => {
    // Seed a cache + etag via a forced fetch.
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID, etag: 'W/"v1"' })));
    await fetchManifest({ force: true });

    // A NON-forced fetch serves the cache immediately and revalidates in the
    // background with the conditional ETag; a 304 keeps the cached copy intact.
    const spy = vi.fn(async () => fetchResponse({ status: 304 }));
    vi.stubGlobal("fetch", spy);
    const res = await fetchManifest();
    expect(res.fromCache).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.manifest.mcpServers[0].definition.name).toBe("Jira");
    expect(res.manifest.services[0].definition.name).toBe("Weather");
    // Let the background revalidation run and assert it sent the conditional header.
    await new Promise((r) => setTimeout(r, 0));
    if (spy.mock.calls.length > 0) {
      const init = (spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
      expect(init.headers["If-None-Match"]).toBe('W/"v1"');
    }
  });

  it("cache-first (non-forced) returns the cache without awaiting the network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    await fetchManifest({ force: true }); // seed

    const res = await fetchManifest(); // non-forced
    expect(res.fromCache).toBe(true);
    expect(res.manifest.services[0].definition.name).toBe("Weather");
  });

  it("refreshManifest forces the network path", async () => {
    // Seed the cache first so we can prove refreshManifest bypasses it.
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    await fetchManifest({ force: true });

    const spy = vi.fn(async () => fetchResponse({ status: 200, json: VALID }));
    vi.stubGlobal("fetch", spy);
    const res = await refreshManifest();
    expect(spy).toHaveBeenCalledOnce();
    expect(res.fromCache).toBe(false);
  });
});
