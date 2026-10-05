/**
 * Registry tests: which channels broadcast `db:changed`, and which are hidden
 * from the Mobile Access bridge.
 *
 * A write channel (contract entry with `writes: true`) broadcasts `db:changed`
 * after it completes, so every window and paired phone re-hydrates. Flagging a
 * read as a write causes a silent re-hydration storm; forgetting the flag on a
 * write leaves other windows stale.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { IPC_CONTRACT_CHANNELS, IPC_WRITE_CHANNELS } from "../../shared/ipc/contract";
import type { IpcChannel } from "../../shared/ipc/contract";
import { isMobileChannel, MOBILE_INVOKE, MOBILE_SEND_CHANNELS } from "./mobile-access";

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
  afterEach(async () => {
    const registry = await import("./registry");
    registry.setMobileBroadcastCallback(null);
    registry.setWriteObserver(null);
  });

  const registered = async () => {
    const registry = await import("./registry");
    const { ipcMain } = await import("electron");
    vi.mocked(ipcMain.handle).mockClear();
    const broadcasts: string[] = [];
    registry.setMobileBroadcastCallback((channel) => broadcasts.push(channel));
    const observer = { begin: vi.fn(() => "token"), end: vi.fn() };
    registry.setWriteObserver(observer);
    const invoke = async (channel: IpcChannel) => {
      registry.registerContractHandle(channel, async () => ({ data: undefined as never }));
      const call = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel)!;
      await (call[1] as (e: unknown) => Promise<unknown>)({ sender: { id: 7 } });
    };
    return { invoke, broadcasts, observer };
  };

  it("broadcasts db:changed and runs the write observer after a write channel", async () => {
    const { invoke, broadcasts, observer } = await registered();
    await invoke("db:note:delete");
    expect(broadcasts).toEqual(["db:changed"]);
    expect(observer.end).toHaveBeenCalledWith("token", 7, expect.any(Number));
  });

  it("stays quiet after a read channel", async () => {
    const { invoke, broadcasts, observer } = await registered();
    await invoke("db:flow:url:fetch");
    expect(broadcasts).toEqual([]);
    expect(observer.begin).not.toHaveBeenCalled();
  });
});

describe("Mobile Access allowlist", () => {
  const sendChannels = (() => {
    const root = path.resolve(__dirname, "..");
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          for (const m of fs.readFileSync(full, "utf8").matchAll(/registerIpcOn(?:<[^>]*>)?\(\s*"([^"]+)"/g)) found.add(m[1]);
        }
      }
    };
    walk(root);
    return found;
  })();

  it("hides desktop-only invoke channels from the bridge but keeps them on ipcMain", async () => {
    const { registerContractHandle, getIpcHandler } = await import("./registry");
    const { ipcMain } = await import("electron");
    const ok = async () => ({ data: { ok: true as const } });
    registerContractHandle("plugins:openFolder", ok);
    registerContractHandle("runtime:status", ok as never);
    expect(ipcMain.handle).toHaveBeenCalledWith("plugins:openFolder", expect.any(Function));
    expect(getIpcHandler("plugins:openFolder")).toBeUndefined();
    expect(getIpcHandler("runtime:status")).toBeTypeOf("function");
  });

  it("hides desktop-only send channels from the bridge but keeps them on ipcMain", async () => {
    const { registerIpcOn, getIpcHandler } = await import("./registry");
    const { ipcMain } = await import("electron");
    registerIpcOn("app:openExternal", () => {});
    registerIpcOn("session:abort", () => {});
    expect(ipcMain.on).toHaveBeenCalledWith("app:openExternal", expect.any(Function));
    expect(getIpcHandler("app:openExternal")).toBeUndefined();
    expect(getIpcHandler("session:abort")).toBeTypeOf("function");
  });

  it("refuses channels it has never heard of", async () => {
    const { registerIpcOn, getIpcHandler } = await import("./registry");
    registerIpcOn("brand-new:channel", () => {});
    expect(isMobileChannel("brand-new:channel")).toBe(false);
    expect(getIpcHandler("brand-new:channel")).toBeUndefined();
    expect(isMobileChannel("constructor")).toBe(false);
    expect(isMobileChannel("__proto__")).toBe(false);
  });

  it.each([
    "agent:writeFile", "agent:spawn", "agent:spawnShell", "agent:input",
    "secrets:set", "secrets:delete",
    "app:reset", "app:relaunch", "app:initWorkspace", "app:saveAiSettings",
    "usage:clear", "session:permissions:set", "automation:approve", "ai:fetchModels",
    "git:commit", "git:push", "git:discard", "mobile:regeneratePin",
  ])("keeps %s desktop-only", (channel) => {
    expect(isMobileChannel(channel)).toBe(false);
  });

  it.each(IPC_CONTRACT_CHANNELS.filter((c) => /^(sync|tools|approval-grants|plugins):/.test(c)))(
    "keeps %s desktop-only", (channel) => {
      expect(isMobileChannel(channel)).toBe(false);
    },
  );

  it("lists every contract channel and only contract channels", () => {
    expect(Object.keys(MOBILE_INVOKE).sort()).toEqual([...IPC_CONTRACT_CHANNELS].sort());
  });

  it("only allows send channels that are actually registered", () => {
    expect(sendChannels.size).toBeGreaterThan(5);
    expect([...MOBILE_SEND_CHANNELS].filter((c) => !sendChannels.has(c))).toEqual([]);
  });

  it("keeps the workspace and agent chat reachable from the phone", () => {
    for (const ch of [
      "db:snapshot", "db:changes:get", "db:note:update", "db:card:update", "db:flow:node:create",
      "db:chat:threads", "app:exportNotePdf", "agent:readFile", "git:status",
      "session:prompt", "session:respond-tool",
    ]) {
      expect(isMobileChannel(ch), ch).toBe(true);
    }
  });
});
