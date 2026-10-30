import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cairn-test" }, BrowserWindow: { getAllWindows: () => [] } }));

const { engineProfile, routeFromConfig } = await import("./engine-bridge");

const cfg = { baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "k", maxSteps: 20 };

describe("engineProfile", () => {
  it("maps the legacy approval modes", () => {
    expect(engineProfile("interactive", undefined)).toMatchObject({ id: "coding", mode: "ask", externalAlwaysAsks: false });
    expect(engineProfile("custom", undefined).mode).toBe("ask");
    expect(engineProfile("plan", undefined).mode).toBe("plan");
    expect(engineProfile("discuss", undefined).mode).toBe("plan");
    expect(engineProfile(undefined, undefined).mode).toBe("ask");
  });
  it("legacy auto allows everything except external calls", () => {
    expect(engineProfile("auto", undefined)).toMatchObject({ mode: "yolo", externalAlwaysAsks: true });
  });
  it("names the automation-dev persona", () => {
    expect(engineProfile("interactive", "automation-dev").id).toBe("automation-dev");
  });
});

describe("routeFromConfig", () => {
  it("defaults to chat completions and carries the model facts", () => {
    expect(routeFromConfig({ ...cfg, contextWindow: 64_000, maxTokens: 4096 } as never)).toMatchObject({ api: "openai-completions", model: "gpt-x", apiKey: "k", contextWindow: 64_000, maxTokens: 4096, reasoning: false });
  });
  it("honours an explicit wire protocol", () => {
    expect(routeFromConfig({ ...cfg, apiMode: "responses" } as never).api).toBe("openai-responses");
    expect(routeFromConfig({ ...cfg, apiMode: "anthropic-messages" } as never).api).toBe("anthropic-messages");
  });
  it("marks the route reasoning-capable when an effort is chosen", () => {
    expect(routeFromConfig({ ...cfg, reasoningEffort: "high" } as never).reasoning).toBe(true);
    expect(routeFromConfig({ ...cfg, reasoningEffort: "off" } as never).reasoning).toBe(false);
  });
  it("leaves keyless local servers without an apiKey", () => {
    expect(routeFromConfig({ ...cfg, apiKey: "" } as never).apiKey).toBeUndefined();
  });
});
