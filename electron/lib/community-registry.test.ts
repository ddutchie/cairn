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
import { parseManifest, fetchManifest, refreshManifest, __test } from "./community-registry";

const VALID = {
  version: 1,
  updatedAt: "2026-07-24T00:00:00Z",
  mcpServers: [
    {
      author: "cairn",
      version: "1.0.0",
      tags: ["issues"],
      blurb: "Jira.",
      logo: "jira",
      brandColor: "#0052cc",
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    const m = parseManifest(VALID);
    expect(m.mcpServers).toHaveLength(1);
    expect(m.services[0].definition.name).toBe("Weather");
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

  it("honours 304 Not Modified by serving the cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID, etag: 'W/"v1"' })));
    await fetchManifest({ force: true });

    const spy = vi.fn(async () => fetchResponse({ status: 304 }));
    vi.stubGlobal("fetch", spy);
    const res = await fetchManifest({ force: true });
    expect(res.fromCache).toBe(true);
    // Sent the conditional header.
    const headers = (spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers["If-None-Match"]).toBe('W/"v1"');
  });

  it("cache-first (non-forced) returns the cache without awaiting the network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fetchResponse({ status: 200, json: VALID })));
    await fetchManifest({ force: true }); // seed

    const res = await fetchManifest(); // non-forced
    expect(res.fromCache).toBe(true);
    expect(res.manifest.services[0].definition.name).toBe("Weather");
  });

  it("refreshManifest forces the network path", async () => {
    const spy = vi.fn(async () => fetchResponse({ status: 200, json: VALID }));
    vi.stubGlobal("fetch", spy);
    const res = await refreshManifest();
    expect(spy).toHaveBeenCalledOnce();
    expect(res.fromCache).toBe(false);
  });
});
