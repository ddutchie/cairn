import { describe, it, expect } from "vitest";
import { parseManifest, parseProvidersManifest, parseAutomationsManifest, parseChatThemesManifest } from "./registry-schema";

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

// ── providers manifest ──────────────────────────────────────────────────────

function providersWith(providerDefinition: Record<string, unknown>) {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    providers: [
      {
        id: "openrouter",
        author: "cairn",
        version: "1.0.0",
        tags: [],
        blurb: "test",
        definition: providerDefinition,
      },
    ],
  };
}

describe("parseProvidersManifest", () => {
  it("accepts a valid provider entry", () => {
    const m = parseProvidersManifest(
      providersWith({
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api",
        defaultModel: "openai/gpt-4o-mini",
        needsApiKey: true,
        apiKeyUrl: "https://openrouter.ai/keys",
      })
    );
    expect(m.providers).toHaveLength(1);
    expect(m.providers[0].definition.baseUrl).toBe("https://openrouter.ai/api");
    expect(m.providers[0].definition.needsApiKey).toBe(true);
  });

  it("drops a provider with a non-https baseUrl (no plaintext origins)", () => {
    const m = parseProvidersManifest(
      providersWith({ name: "Evil", baseUrl: "http://insecure.example.com", needsApiKey: false })
    );
    expect(m.providers).toHaveLength(0);
  });

  it("drops a provider with an unsafe apiKeyUrl", () => {
    const m = parseProvidersManifest(
      providersWith({
        name: "Evil",
        baseUrl: "https://ok.example.com",
        needsApiKey: true,
        apiKeyUrl: "javascript:alert(1)",
      })
    );
    expect(m.providers).toHaveLength(0);
  });

  it("keeps a provider's credits descriptor and its declared shape", () => {
    const m = parseProvidersManifest(
      providersWith({
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        needsApiKey: true,
        credits: { url: "https://api.deepseek.com/user/balance", shape: "deepseek" },
      })
    );
    expect(m.providers).toHaveLength(1);
    expect(m.providers[0].definition.credits).toEqual({
      url: "https://api.deepseek.com/user/balance",
      shape: "deepseek",
    });
  });

  it("drops a provider whose credits url is not https", () => {
    const m = parseProvidersManifest(
      providersWith({
        name: "Evil",
        baseUrl: "https://ok.example.com",
        needsApiKey: true,
        credits: { url: "http://insecure.example.com/balance", shape: "openrouter" },
      })
    );
    expect(m.providers).toHaveLength(0);
  });

  it("keeps good entries while dropping malformed ones", () => {
    const m = parseProvidersManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      providers: [
        { id: "a", author: "x", version: "1", tags: [], blurb: "", definition: { name: "Good", baseUrl: "https://a.example.com", needsApiKey: false } },
        { id: "b", author: "x", version: "1", tags: [], blurb: "", definition: { name: "Bad", baseUrl: "not-a-url", needsApiKey: false } },
      ],
    });
    expect(m.providers).toHaveLength(1);
    expect(m.providers[0].id).toBe("a");
  });
});

describe("parseAutomationsManifest", () => {
  it("parses a valid automation recipe", () => {
    const m = parseAutomationsManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      automations: [
        {
          id: "weekly-review",
          author: "cairn",
          version: "1.0.0",
          category: "Automation",
          tags: ["review"],
          blurb: "Weekly review",
          definition: {
            name: "Weekly review",
            instructions: "Summarise the week and draft a review note.",
            schedule: { kind: "cron", expr: "0 9 * * 1" },
          },
        },
      ],
    });
    expect(m.automations).toHaveLength(1);
    expect(m.automations[0].id).toBe("weekly-review");
    expect(m.automations[0].definition.schedule.kind).toBe("cron");
  });

  it("drops entries with an invalid schedule or missing instructions", () => {
    const m = parseAutomationsManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      automations: [
        { id: "good", author: "x", version: "1", tags: [], blurb: "", definition: { name: "Good", instructions: "Do a useful thing here.", schedule: { kind: "every", expr: "every 24 hours" } } },
        { id: "bad-sched", author: "x", version: "1", tags: [], blurb: "", definition: { name: "Bad", instructions: "Do a useful thing here.", schedule: { kind: "hourly" } } },
        { id: "no-inst", author: "x", version: "1", tags: [], blurb: "", definition: { name: "Bad2", schedule: { kind: "once", expr: "2026-09-01T09:00" } } },
      ],
    });
    expect(m.automations.map((a) => a.id)).toEqual(["good"]);
  });

  it("parses a recipe's required connectors", () => {
    const m = parseAutomationsManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      automations: [
        {
          id: "linear-digest",
          author: "cairn",
          version: "1.0.0",
          category: "Automation",
          tags: ["linear"],
          blurb: "Weekly Linear digest",
          definition: {
            name: "Linear digest",
            instructions: "Summarise this week's Linear issues into a note.",
            schedule: { kind: "cron", expr: "0 9 * * 1" },
            requires: [{ kind: "mcp", name: "Linear" }],
          },
        },
      ],
    });
    expect(m.automations).toHaveLength(1);
    expect(m.automations[0].definition.requires).toEqual([{ kind: "mcp", name: "Linear" }]);
  });

  it("drops a recipe with a malformed requirement (never blanks the catalog)", () => {
    const m = parseAutomationsManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      automations: [
        { id: "ok", author: "x", version: "1", tags: [], blurb: "", definition: { name: "OK", instructions: "Do a useful thing here.", schedule: { kind: "every", expr: "every 24 hours" } } },
        {
          id: "bad-req",
          author: "x",
          version: "1",
          tags: [],
          blurb: "",
          definition: {
            name: "Bad",
            instructions: "Do a useful thing here.",
            schedule: { kind: "every", expr: "every 24 hours" },
            requires: [{ kind: "ftp", name: "" }],
          },
        },
      ],
    });
    expect(m.automations.map((a) => a.id)).toEqual(["ok"]);
  });
});

describe("registry-schema pre-registered-client flags", () => {
  it("parses requiresClientId on an MCP entry", () => {
    const m = parseManifest({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      mcpServers: [
        {
          id: "slack",
          author: "cairn",
          version: "1.0.0",
          tags: [],
          blurb: "",
          definition: {
            name: "Slack",
            transport: "http",
            baseUrl: "https://mcp.slack.com/mcp",
            authMode: "oauth",
            requiresClientId: true,
            enabled: true,
          },
        },
      ],
      services: [],
    });
    expect(m.mcpServers).toHaveLength(1);
    expect(m.mcpServers[0].definition.requiresClientId).toBe(true);
  });

  it("parses a service oauth redirectUri (pre-registered client)", () => {
    const m = parseManifest(
      manifestWith({
        name: "S",
        apiUrl: "https://api.example.com",
        method: "GET",
        toolDefinition: '{"name":"op","parameters":{"type":"object","properties":{}}}',
        authMode: "oauth",
        oauth: { clientId: "123.456", redirectUri: "http://127.0.0.1:48123/callback" },
        enabled: true,
      })
    );
    expect(m.services).toHaveLength(1);
    expect(m.services[0].definition.oauth?.clientId).toBe("123.456");
    expect(m.services[0].definition.oauth?.redirectUri).toBe("http://127.0.0.1:48123/callback");
  });
});

describe("registry-schema chat themes manifest", () => {
  const validTheme = {
    id: "ocean",
    author: "cairn",
    version: "1.0.0",
    tags: ["chat", "theme"],
    blurb: "Deep teal gradient.",
    definition: {
      name: "Ocean",
      description: "Teal→blue gradient.",
      font: "sans",
      fontWeight: "regular",
      tracking: 0,
      lineHeight: 1,
      bgType: "gradient",
      pattern: "none",
      bubbleStyle: "glass",
      radius: "md",
      shadow: "subtle",
      dark: {
        bg: "#071318",
        stops: ["#071318", "#0a1f33"],
        userBubble: "#2dd4bf",
        userBubbleFg: "#04231f",
        aiBubble: "rgba(20,52,66,0.75)",
        aiText: "#9be7dd",
      },
      light: {
        bg: "#eefaf9",
        stops: ["#eefaf9", "#e6f1fc"],
        userBubble: "#0a7568",
        userBubbleFg: "#ffffff",
        aiBubble: "rgba(255,255,255,0.85)",
        aiText: "#0a3d36",
      },
    },
  };

  function manifestWith(themes: unknown[]) {
    return { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", themes };
  }

  it("parses a valid themes manifest", () => {
    const m = parseChatThemesManifest(manifestWith([validTheme]));
    expect(m.themes).toHaveLength(1);
    expect(m.themes[0].id).toBe("ocean");
    expect(m.themes[0].definition.font).toBe("sans");
    expect(m.themes[0].definition.fontWeight).toBe("regular");
    expect(m.themes[0].definition.pattern).toBe("none");
    expect(m.themes[0].definition.radius).toBe("md");
    expect(m.themes[0].definition.dark.stops).toEqual(["#071318", "#0a1f33"]);
  });

  it("drops a malformed entry without blanking the catalog", () => {
    const bad = { ...validTheme, definition: { ...validTheme.definition, font: "comic-sans" } };
    const m = parseChatThemesManifest(manifestWith([bad, validTheme]));
    expect(m.themes).toHaveLength(1);
    expect(m.themes[0].id).toBe("ocean");
  });

  it("rejects an invalid envelope", () => {
    expect(() => parseChatThemesManifest({ version: "x" })).toThrow();
  });

  it("enforces dark+light presence", () => {
    const missingLight = {
      ...validTheme,
      definition: { ...validTheme.definition, light: undefined },
    };
    const m = parseChatThemesManifest(manifestWith([missingLight]));
    expect(m.themes).toHaveLength(0);
  });
});
