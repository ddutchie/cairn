import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cairn-test" }, BrowserWindow: { getAllWindows: () => [] } }));

const { chatEngineProfile, chatSystemPrompt, engineProfile, readEnginePermissions, routeFromConfig, setEnginePermission } = await import("./engine-bridge");
const { decide } = await import("../agent/policy");
const { presetRules } = await import("../agent/rules");

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

describe("chat approval policy as engine policy", () => {
  const state = (policy: "safe" | "external" | "allow-all") => {
    const { profile, rules } = chatEngineProfile(policy);
    return { mode: profile.mode, deniedTools: [], rules: [...presetRules("cairn-data"), ...rules], workspaceRoot: "/ws", recent: [], doomAcked: new Set<string>() };
  };
  const cairnWrite = { name: "create_task", risk: { class: "WRITE_CAIRN" as const } };
  const del = { name: "delete", risk: { class: "WRITE_LOCAL" as const } };
  const connector = { name: "mcp__x__y", risk: { class: "EXTERNAL" as const } };

  it("safe: Cairn writes run, deletes and connectors ask", () => {
    expect(decide(cairnWrite, "a", state("safe")).kind).toBe("allow");
    expect(decide(del, "b", state("safe")).kind).toBe("ask");
    expect(decide(connector, "c", state("safe")).kind).toBe("ask");
  });
  it("external: deletes run too, connectors still ask", () => {
    expect(decide(del, "b", state("external")).kind).toBe("allow");
    expect(decide(connector, "c", state("external")).kind).toBe("ask");
  });
  it("allow-all: nothing asks", () => {
    expect(decide(del, "b", state("allow-all")).kind).toBe("allow");
    expect(decide(connector, "c", state("allow-all")).kind).toBe("allow");
  });
  it("a user grant still beats the connector ask", () => {
    const st = state("safe");
    st.rules.push({ id: "g", effect: "allow", scope: "workspace", source: "grant", match: { tool: "mcp__x__y" } });
    expect(decide(connector, "c", st).kind).toBe("allow");
  });
  it("only tells the model about approvals when something can ask", () => {
    const req = { message: "hi", threadId: "t" } as never;
    expect(chatSystemPrompt(req, "safe")).toContain("Tool approvals");
    expect(chatSystemPrompt(req, "safe")).toContain("destructive operations");
    expect(chatSystemPrompt(req, "external")).not.toContain("destructive operations");
    expect(chatSystemPrompt(req, "allow-all")).not.toContain("Tool approvals");
  });
});

describe("permission presets", () => {
  it("start from the legacy approval mode and switch per session", () => {
    expect(readEnginePermissions("p1", "auto").currentValue).toBe("yolo");
    expect(readEnginePermissions("p1", "interactive").currentValue).toBe("ask");
    expect(setEnginePermission("p1", "yolo", "interactive").currentValue).toBe("yolo");
    expect(readEnginePermissions("p1", "interactive").currentValue).toBe("yolo");
    expect(readEnginePermissions("p2", "interactive").currentValue).toBe("ask");
  });
  it("rejects a preset it does not offer", () => {
    expect(() => setEnginePermission("p1", "nope", undefined)).toThrow(/Unknown permission preset/);
  });
});
