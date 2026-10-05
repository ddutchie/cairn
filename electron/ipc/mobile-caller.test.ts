import { describe, it, expect, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, updateProject } from "../db/queries";
import type { CachedConfig } from "../lib/config-cache";
import type { Connection } from "./mobile-caller";
import {
  MOBILE_CALLER, isMobileCaller, pinMobileConnection, knownConnections, agentFallback,
  sanitizeMobileRequest, pinMobileArgs,
} from "./mobile-caller";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
vi.mock("./registry", () => ({
  registerContractHandle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn),
  registerIpcOn: vi.fn(),
  broadcastIpcEvent: vi.fn(),
  broadcastEvent: vi.fn(),
  sendIpcEvent: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cairn-test", isReady: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  dialog: {},
}));
vi.mock("../cordis/agent-host", () => ({ getAgentHost: () => ({}) }));

const REF = "secret-ref:llm/openai";
const AGENT_REF = "secret-ref:llm/anthropic";
const CONFIG: CachedConfig = {
  aiConfig: {
    provider: "openai",
    baseUrl: "https://api.openai.com",
    apiKey: REF,
    model: "gpt-5",
    savedProviders: [
      { id: "oai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: REF, model: "gpt-5" },
      { id: "ant", name: "Anthropic", baseUrl: "https://api.anthropic.com", apiKey: AGENT_REF, model: "claude", apiMode: "anthropic-messages" },
      { id: "local", name: "Ollama", baseUrl: "http://localhost:11434", apiKey: "", model: "llama" },
    ],
  },
  agentConfig: { baseUrl: "https://api.anthropic.com", apiKey: AGENT_REF, model: "claude", activeProviderId: "ant", mode: "interactive" },
};
const known = knownConnections(CONFIG);
const mobileEvent = { [MOBILE_CALLER]: true, sender: { id: "client_x" } };

describe("isMobileCaller", () => {
  it("recognises only the bridge's marker", () => {
    expect(isMobileCaller(mobileEvent)).toBe(true);
    expect(isMobileCaller({ sender: { id: 1 } })).toBe(false);
    expect(isMobileCaller({ mobileCaller: true })).toBe(false);
    expect(isMobileCaller(JSON.parse(JSON.stringify(mobileEvent)))).toBe(false);
    expect(isMobileCaller(undefined)).toBe(false);
  });
});

describe("pinMobileConnection", () => {
  it("keeps a saved base URL + key pair and the model", () => {
    const out = pinMobileConnection({ baseUrl: "https://api.anthropic.com/", apiKey: AGENT_REF, model: "claude-x", apiMode: "anthropic-messages" }, known, CONFIG.aiConfig);
    expect(out).toMatchObject({ baseUrl: "https://api.anthropic.com/", apiKey: AGENT_REF, model: "claude-x", apiMode: "anthropic-messages" });
  });

  it("replaces a stored key aimed at another URL with the fallback connection", () => {
    const out = pinMobileConnection({ baseUrl: "https://evil.example", apiKey: REF, model: "m", provider: "custom" }, known, CONFIG.aiConfig);
    expect(out).toEqual({ baseUrl: "https://api.openai.com", apiKey: REF, provider: "openai", model: "m" });
  });

  it("does not pair a saved URL with another saved connection's key", () => {
    const out = pinMobileConnection({ baseUrl: "https://api.anthropic.com", apiKey: REF }, known, CONFIG.aiConfig);
    expect(out.baseUrl).toBe("https://api.openai.com");
    expect(out.apiKey).toBe(REF);
  });

  it("does not let a keyless request at an unknown URL inherit a key later", () => {
    const out = pinMobileConnection<Connection>({ baseUrl: "https://evil.example" }, known, undefined);
    expect(out.baseUrl).toBeUndefined();
    expect(out.apiKey).toBeUndefined();
  });

  it("keeps a saved keyless local endpoint", () => {
    expect(pinMobileConnection({ baseUrl: "http://localhost:11434", model: "llama" }, known, CONFIG.aiConfig))
      .toMatchObject({ baseUrl: "http://localhost:11434", model: "llama" });
  });

  it("drops approval mode and auto-approve", () => {
    const out = pinMobileConnection({ baseUrl: "https://api.openai.com", apiKey: REF, mode: "auto", autoApprove: true }, known, undefined);
    expect(out).not.toHaveProperty("mode");
    expect(out).not.toHaveProperty("autoApprove");
  });
});

describe("sanitizeMobileRequest", () => {
  it("drops the approval policy, pins the connection and uses the stored cwd", () => {
    const out = sanitizeMobileRequest(
      { sessionId: "s1", cwd: "/", approvalPolicy: "allow-all", config: { baseUrl: "https://evil.example", apiKey: AGENT_REF, mode: "auto" } },
      { config: CONFIG, fallback: agentFallback(CONFIG), storedCwd: "/code/app" },
    );
    expect(out).not.toHaveProperty("approvalPolicy");
    expect(out.cwd).toBe("/code/app");
    expect(out.config).toEqual({ baseUrl: "https://api.anthropic.com", apiKey: AGENT_REF, apiMode: "anthropic-messages" });
  });
});

describe("pinMobileArgs", () => {
  it("pins a config on the first argument and leaves other arguments alone", () => {
    const [req] = pinMobileArgs([{ diff: "d", config: { baseUrl: "https://evil.example", apiKey: REF, model: "m" } }], CONFIG) as [{ diff: string; config: unknown }];
    expect(req.diff).toBe("d");
    expect(req.config).toEqual({ baseUrl: "https://api.openai.com", apiKey: REF, provider: "openai", model: "m" });
    const plain = [{ id: "n1" }];
    expect(pinMobileArgs(plain, CONFIG)).toBe(plain);
    expect(pinMobileArgs([], CONFIG)).toEqual([]);
  });
});

describe("mobile limits in session and project handlers", () => {
  const setup = async () => {
    handlers.clear();
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    createWorkspace(db, { id: "ws1", name: "Workspace" });
    createProject(db, { id: "p1", workspaceId: "ws1", name: "Project" });
    updateProject(db, "p1", { codeDirectory: "/code/app" });
    const ctx = { db, workspacePath: "", getWin: () => null };
    const { registerSessionHandlers } = await import("./session-handlers");
    const { registerDbHandlers } = await import("./db-handlers");
    registerSessionHandlers(ctx as never);
    registerDbHandlers(ctx as never);
    return handlers;
  };
  const session = (cwd: string, role?: string) => ({ id: `s-${Math.random().toString(36).slice(2)}`, projectId: "p1", taskTitle: "t", cwd, mode: "execute", spawnedAt: new Date().toISOString(), role });

  it("db:session:create only accepts the project's code directory from the phone", async () => {
    const h = await setup();
    const create = h.get("db:session:create")!;
    expect(await create(mobileEvent, session("/"))).toHaveProperty("error");
    expect(await create(mobileEvent, session("/code/app", "automation-dev"))).toHaveProperty("error");
    expect(await create(mobileEvent, session("/code/app"))).toHaveProperty("data");
    expect(await create({ sender: { id: 1 } }, session("/elsewhere"))).toHaveProperty("data");
  });

  it("db:project:update refuses a new code directory from the phone", async () => {
    const h = await setup();
    const update = h.get("db:project:update")!;
    expect(await update(mobileEvent, { id: "p1", patch: { codeDirectory: "/" } })).toHaveProperty("error");
    expect(await update(mobileEvent, { id: "p1", patch: { name: "Renamed", codeDirectory: "/code/app" } })).toHaveProperty("data");
    expect(await update({ sender: { id: 1 } }, { id: "p1", patch: { codeDirectory: "/other" } })).toHaveProperty("data");
  });
});
