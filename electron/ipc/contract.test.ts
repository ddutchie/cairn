import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CONTRACT_CHANNELS, type IpcArgs, type IpcReturn } from "../../shared/ipc/contract";
import type { IpcResult } from "./result-helpers";

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
  const preload = read("electron/preload.ts");

  it.each(IPC_CONTRACT_CHANNELS)("%s is registered with registerContractHandle, not the untyped API", (channel) => {
    expect(sources).toContain(`registerContractHandle("${channel}"`);
    expect(sources).not.toContain(`registerIpcHandle("${channel}"`);
  });

  it.each(IPC_CONTRACT_CHANNELS)("%s is called through invokeContract in preload", (channel) => {
    expect(preload).toContain(`invokeContract("${channel}"`);
    expect(preload).not.toMatch(new RegExp(`\\binvoke(<[^>]*>)?\\("${channel}"`));
  });

  it("rejects mismatched handler signatures at compile time", () => {
    type Handler<C extends (typeof IPC_CONTRACT_CHANNELS)[number]> =
      (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => Promise<IpcResult<IpcReturn<C>>>;
    // @ts-expect-error — chat:popIn takes { sessionId }, not a number
    const badArgs: Handler<"chat:popIn"> = async (_e, _p: number) => ({ data: { ok: true } });
    // @ts-expect-error — chat:requestPopIn returns a PopoutAck, not a string
    const badResult: Handler<"chat:requestPopIn"> = async () => ({ data: "nope" });
    expect([badArgs, badResult]).toHaveLength(2);
  });
});
