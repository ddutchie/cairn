/**
 * session:prompt from a Mobile Access caller: the phone may start a turn but
 * not choose its approval policy, approval mode, connection or working
 * directory, and must not rewrite the desktop's cached connection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "../db/schema";
import { MOBILE_CALLER } from "./mobile-caller";

const listeners = new Map<string, (event: unknown, req: unknown) => Promise<void> | void>();
const broadcasts: Array<{ channel: string; payload: unknown }> = [];
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cairn-test", isReady: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  dialog: {},
}));
vi.mock("./registry", () => ({
  registerIpcOn: (channel: string, fn: (event: unknown, req: unknown) => void) => listeners.set(channel, fn),
  registerContractHandle: vi.fn(),
  broadcastEvent: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
  broadcastIpcEvent: vi.fn(),
  sendIpcEvent: vi.fn(),
}));
const runChatPrompt = vi.fn();
vi.mock("./chat", () => ({ runChatPrompt: (...a: unknown[]) => runChatPrompt(...a) }));
vi.mock("../cordis/agent-host", () => ({ getAgentHost: () => ({ isTurnRunning: () => false }) }));
const cacheLlmConnection = vi.fn();
const REF = "secret-ref:llm/openai";
vi.mock("../lib/config-cache", () => ({
  cacheLlmConnection: (...a: unknown[]) => cacheLlmConnection(...a),
  getCachedConfig: () => ({
    aiConfig: { provider: "openai", baseUrl: "https://api.openai.com", apiKey: REF, model: "gpt-5", chatApprovalPolicy: "safe" },
    agentConfig: { baseUrl: "https://api.openai.com", apiKey: REF, model: "gpt-5", mode: "interactive" },
  }),
}));

const mobileEvent = { [MOBILE_CALLER]: true, sender: { id: "client_x", send: vi.fn(), isDestroyed: () => false } };

async function setup() {
  listeners.clear();
  broadcasts.length = 0;
  runChatPrompt.mockClear();
  cacheLlmConnection.mockClear();
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  const { registerSessionRuntimeHandlers } = await import("./session-runtime-handlers");
  registerSessionRuntimeHandlers({ db, workspacePath: "/ws", getWin: () => null } as never);
  return listeners.get("session:prompt")!;
}

describe("session:prompt from Mobile Access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("drops a phone-chosen approval policy and pins the connection for chat turns", async () => {
    const prompt = await setup();
    await prompt(mobileEvent, {
      sessionId: "chat-t1", prompt: "hi", profile: "chat", cwd: "/",
      approvalPolicy: "allow-all",
      config: { baseUrl: "https://evil.example", apiKey: REF, model: "m", mode: "auto", autoApprove: true },
    });
    expect(runChatPrompt).toHaveBeenCalledTimes(1);
    const chatReq = runChatPrompt.mock.calls[0][2] as { approvalPolicy?: unknown; config: Record<string, unknown> };
    expect(chatReq.approvalPolicy).toBeUndefined();
    expect(chatReq.config).toEqual({ baseUrl: "https://api.openai.com", apiKey: REF, provider: "openai", model: "m" });
  });

  it("keeps the desktop's own choices for desktop chat turns", async () => {
    const prompt = await setup();
    await prompt({ sender: { id: 1 } }, {
      sessionId: "chat-t2", prompt: "hi", profile: "chat", cwd: "/", approvalPolicy: "allow-all",
      config: { baseUrl: "http://localhost:1234", apiKey: "", model: "m" },
    });
    const chatReq = runChatPrompt.mock.calls[0][2] as { approvalPolicy?: unknown; config: Record<string, unknown> };
    expect(chatReq.approvalPolicy).toBe("allow-all");
    expect(chatReq.config.baseUrl).toBe("http://localhost:1234");
  });

  it("refuses a coding turn for a session with no stored working directory", async () => {
    const prompt = await setup();
    await prompt(mobileEvent, { sessionId: "code-1", prompt: "rm -rf", profile: "coding", cwd: "/" });
    expect(runChatPrompt).not.toHaveBeenCalled();
    expect(cacheLlmConnection).not.toHaveBeenCalled();
    expect(broadcasts).toContainEqual({ channel: "session:busy", payload: expect.objectContaining({ sessionId: "code-1", reason: "mobile-refused" }) });
  });
});
