/**
 * Registry tests: which channels broadcast `db:changed`, and which are hidden
 * from the Mobile Access bridge.
 *
 * A write channel (contract entry with `writes: true`) broadcasts `db:changed`
 * after it completes, so every window and paired phone re-hydrates. Flagging a
 * read as a write causes a silent re-hydration storm; forgetting the flag on a
 * write leaves other windows stale.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { IPC_CONTRACT_CHANNELS, IPC_WRITE_CHANNELS } from "../../shared/ipc/contract";
import type { IpcChannel } from "../../shared/ipc/contract";

// registry.ts imports `electron` at module load; stub the bits it touches.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const isWrite = (c: string) => IPC_WRITE_CHANNELS.has(c as IpcChannel);

describe("contract write flags", () => {
  it("flags data-changing channels as writes", () => {
    for (const c of [
      "db:note:create",
      "db:note:update",
      "db:note:delete",
      "db:note:moveToFolder",
      "db:note:moveToProject",
      "db:card:addBlocker",
      "db:card:removeBlocker",
      "db:cards:archive-done",
      "db:chat:upsertThread",
      "db:chat:deleteThread",
      "db:chat:clearThreadMessages",
      "db:project:updateSettings",
      "db:graph:recompute",
      "db:embeddings:reindex",
      "db:embeddings:recomputeProjections",
      "db:flow:node:update",
      "db:flow:node:delete",
      "db:flow:edge:delete",
    ]) {
      expect(isWrite(c), c).toBe(true);
    }
  });

  it("leaves reads unflagged, including polled reads with non-verb names", () => {
    for (const c of [
      "db:workspace:list",
      "db:project:list",
      "db:card:ready",
      "db:flow:get",
      "db:graph:get",
      "db:graph:neighbors",
      "db:chat:threads",
      "db:session:list",
      "db:embeddings:search",
      "db:snapshot",
      "db:hasData",
      "db:automation:runningCount",
      "db:automation:recentRuns",
      "db:automation:runs",
      "db:automation:runLog",
      "db:notification:count",
      "db:session:todos",
      "db:chat:sessionMessages",
    ]) {
      expect(IPC_CONTRACT_CHANNELS, c).toContain(c);
      expect(isWrite(c), c).toBe(false);
    }
  });

  it("does not flag db:flow:url:fetch, a pure URL-metadata read (regression)", () => {
    // Once misclassified as a write, which re-hydrated every window on each URL preview.
    expect(isWrite("db:flow:url:fetch")).toBe(false);
  });

  it("flags every db:* channel named with a write verb", () => {
    // Catches a new write channel added without `writes: true`.
    const writeVerb = /^(create|update|delete|set|clear|upsert|remove|add|merge|move|archive|mark|recompute|reindex|runNow|sync|summarize)([A-Z-]|$)/;
    const unflagged = IPC_CONTRACT_CHANNELS.filter(
      (c) => c.startsWith("db:") && writeVerb.test(c.slice(c.lastIndexOf(":") + 1)) && !isWrite(c),
    );
    expect(unflagged).toEqual([]);
  });

  it("only flags db:* channels", () => {
    expect([...IPC_WRITE_CHANNELS].filter((c) => !c.startsWith("db:"))).toEqual([]);
  });
});

describe("write broadcast", () => {
  const registered = async () => {
    const registry = await import("./registry");
    const { ipcMain } = await import("electron");
    const broadcasts: string[] = [];
    registry.setMobileBroadcastCallback((channel) => broadcasts.push(channel));
    const observer = { begin: vi.fn(() => "token"), end: vi.fn() };
    registry.setWriteObserver(observer);
    const invoke = async (channel: IpcChannel) => {
      registry.registerContractHandle(channel, async () => ({ data: undefined as never }));
      const call = vi.mocked(ipcMain.handle).mock.calls.filter(([c]) => c === channel).at(-1)!;
      await (call[1] as (e: unknown) => Promise<unknown>)({ sender: { id: 7 } });
    };
    return { invoke, broadcasts, observer, registry };
  };

  it("broadcasts db:changed and runs the write observer after a write channel", async () => {
    const { invoke, broadcasts, observer, registry } = await registered();
    await invoke("db:note:delete");
    expect(broadcasts).toEqual(["db:changed"]);
    expect(observer.end).toHaveBeenCalledWith("token", 7, expect.any(Number));
    registry.setMobileBroadcastCallback(null);
    registry.setWriteObserver(null);
  });

  it("stays quiet after a read channel", async () => {
    const { invoke, broadcasts, observer, registry } = await registered();
    await invoke("db:flow:url:fetch");
    expect(broadcasts).toEqual([]);
    expect(observer.begin).not.toHaveBeenCalled();
    registry.setMobileBroadcastCallback(null);
    registry.setWriteObserver(null);
  });
});

describe("local-only channels", () => {
  it("are registered for the desktop window but hidden from the Mobile Access bridge", async () => {
    const { registerContractHandle, getIpcHandler } = await import("./registry");
    const { ipcMain } = await import("electron");
    const ok = async () => ({ data: { ok: true as const } });
    registerContractHandle("plugins:openFolder", ok, { localOnly: true });
    registerContractHandle("runtime:stop", ok);
    expect(ipcMain.handle).toHaveBeenCalledWith("plugins:openFolder", expect.any(Function));
    expect(getIpcHandler("plugins:openFolder")).toBeUndefined();
    expect(getIpcHandler("runtime:stop")).toBeTypeOf("function");
  });

  it("registers every plugins:* channel as local-only", () => {
    const src = fs.readFileSync(path.join(__dirname, "ui-plugin-handlers.ts"), "utf8");
    const calls = src.match(/registerContractHandle\("plugins:[^"]+"/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect((src.match(/, LOCAL_ONLY\);/g) ?? []).length).toBe(calls.length);
  });
});
