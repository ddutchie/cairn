import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_CONTRACT_CHANNELS, IPC_SEND_CHANNELS } from "../../shared/ipc/contract";
import type { registerContractHandle } from "./registry";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function electronSources(dir = path.join(ROOT, "electron")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return electronSources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

describe("typed IPC contract", () => {
  const sources = electronSources().map((p) => fs.readFileSync(p, "utf8")).join("\n");
  // preload.ts composes the electron/preload/<domain>.ts slices.
  const preloadDir = path.join(ROOT, "electron/preload");
  const preloadFiles = fs.readdirSync(preloadDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const preload = [read("electron/preload.ts"), ...preloadFiles.map((f) => read(`electron/preload/${f}`))].join("\n");

  // electron/sync/ is shared-tsconfig-scoped, so it receives registerContractHandle
  // as an injected, contract-typed `register` parameter (see registerSyncHandlers).
  const syncHandlers = read("electron/sync/sync-handlers.ts");

  it.each(IPC_CONTRACT_CHANNELS)("%s is registered with registerContractHandle, not the untyped API", (channel) => {
    const call = (fn: string) => new RegExp(`\\b${fn}(<[^>]*>)?\\(\\s*"${channel}"`);
    if (channel.startsWith("sync:")) expect(syncHandlers).toMatch(call("register"));
    else expect(sources).toMatch(call("registerContractHandle"));
    expect(sources).not.toMatch(call("registerIpcHandle"));
    // preload invokes every contract channel, and an invoke never reaches an ipcMain.on listener.
    expect(sources).not.toMatch(call("registerIpcOn"));
  });

  it.each(IPC_CONTRACT_CHANNELS)("%s is called through invokeContract in preload", (channel) => {
    expect(preload).toMatch(new RegExp(`\\binvokeContract\\(\\s*"${channel}"`));
    expect(preload).not.toMatch(new RegExp(`\\binvoke(<[^>]*>)?\\(\\s*"${channel}"`));
  });

  it.each(IPC_SEND_CHANNELS)("%s is sent through sendContract and has a registerIpcOn listener", (channel) => {
    expect(preload).toMatch(new RegExp(`\\bsendContract\\(\\s*"${channel}"`));
    expect(sources).toMatch(new RegExp(`\\bregisterIpcOn(<[^>]*>)?\\(\\s*"${channel}"`));
  });

  it("builds preload only from the typed helpers in preload/ipc.ts", () => {
    expect(preload).not.toMatch(/(?<![.\w])invoke(<[^>]*>)?\(/);
    // ipcRenderer appears only in preload/ipc.ts: one invoke, on/off, one send.
    const outside = preloadFiles.filter((f) => f !== "ipc.ts" && /\bipcRenderer\b/.test(read(`electron/preload/${f}`)));
    expect(outside).toEqual([]);
    expect(read("electron/preload.ts")).not.toMatch(/\bipcRenderer\b/);
    const helpers = read("electron/preload/ipc.ts");
    expect(helpers.match(/ipcRenderer\.invoke\(/g)).toHaveLength(1);
    expect(helpers.match(/ipcRenderer\.send\(/g)).toHaveLength(1);
  });

  it("keeps the untyped ipcMain.handle path private to the registry", () => {
    const outside = electronSources()
      .filter((p) => !p.endsWith(path.join("ipc", "registry.ts")))
      .filter((p) => /\bregisterIpcHandle\s*[<(]|\bipcMain\.handle\(/.test(fs.readFileSync(p, "utf8")))
      .map((p) => path.relative(ROOT, p));
    expect(outside).toEqual([]);
    expect(read("electron/ipc/registry.ts")).not.toMatch(/export function registerIpcHandle\b/);
  });

  it("rejects mismatched handler signatures at compile time", () => {
    // The real registerContractHandle parameter, so a signature change is caught here too.
    type Handler<C extends (typeof IPC_CONTRACT_CHANNELS)[number]> = Parameters<typeof registerContractHandle<C>>[1];
    // @ts-expect-error — chat:popIn takes { sessionId }, not a number
    const badArgs: Handler<"chat:popIn"> = async (_e, _p: number) => ({ data: { ok: true } });
    // @ts-expect-error — chat:requestPopIn returns a PopoutAck, not a string
    const badResult: Handler<"chat:requestPopIn"> = async () => ({ data: "nope" });
    expect([badArgs, badResult]).toHaveLength(2);
  });
});
