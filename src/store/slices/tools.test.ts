/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tools slice over `toolsClient`: optimistic deletes roll back and toast on a
 * failed IPC call, saves reject to the caller (the forms show the error), and
 * the slice is a no-op without the desktop bridge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolsSlice } from "./tools";
import type { McpServerConfig } from "@/types";

const server = (id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id,
  workspaceId: "ws-1",
  name: id,
  transport: "http",
  baseUrl: "https://example.test/mcp",
  enabled: true,
  source: "manual",
  createdAt: "",
  updatedAt: "",
  ...extra,
});

function setup(tools?: Record<string, any>) {
  const win = new EventTarget() as any;
  if (tools) win.electron = { tools };
  vi.stubGlobal("window", win);
  const errors: string[] = [];
  win.addEventListener("cairn:ipc-error", (e: CustomEvent) => errors.push(e.detail.message));

  let state: any = { activeWorkspaceId: "ws-1", activeProjectId: "proj-1" };
  const set = (u: any) => { state = { ...state, ...(typeof u === "function" ? u(state) : u) }; };
  state = { ...state, ...createToolsSlice(set, () => state, {} as any) };
  return { get: () => state, set, errors };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tools slice", () => {
  it("rolls back a failed MCP server delete and reports it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { get, set, errors } = setup({ deleteMcpServer: vi.fn().mockRejectedValue(new Error("locked")) });
    set({ mcpServers: [server("a"), server("b")] });

    await get().deleteMcpServer("a");

    expect(get().mcpServers.map((m: McpServerConfig) => m.id)).toEqual(["a", "b"]);
    expect(errors).toEqual(["Couldn't delete the MCP server: locked"]);
  });

  it("re-fetches attachments and reports when attaching fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listAttachments = vi.fn().mockResolvedValue([]);
    const { get, errors } = setup({ setAttachment: vi.fn().mockRejectedValue(new Error("nope")), listAttachments });

    await get().setToolAttachment("proj-1", "mcp", "a", true);

    expect(listAttachments).toHaveBeenCalledWith("proj-1");
    expect(errors).toEqual(["Couldn't attach the tool: nope"]);
  });

  it("propagates save failures to the caller without toasting", async () => {
    const { get, errors } = setup({ saveMcpServer: vi.fn().mockRejectedValue(new Error("Refusing to store a plaintext credential")) });

    await expect(get().saveMcpServer(server("a"))).rejects.toThrow("plaintext credential");
    expect(errors).toEqual([]);
  });

  it("upserts the saved server returned by main", async () => {
    const saved = server("a", { name: "Renamed" });
    const { get, set } = setup({ saveMcpServer: vi.fn().mockResolvedValue(saved) });
    set({ mcpServers: [server("a")] });

    await get().saveMcpServer({ id: "a", name: "Renamed" });

    expect(get().mcpServers).toEqual([saved]);
  });

  it("does nothing without the desktop bridge", async () => {
    const { get, set } = setup();
    set({ mcpServers: [server("a")] });

    await get().deleteMcpServer("a");
    await get().fetchTools("ws-1");

    expect(get().mcpServers).toHaveLength(1);
  });
});
