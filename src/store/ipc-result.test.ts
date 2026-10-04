import { afterEach, describe, expect, it } from "vitest";
import { ipcResult } from "./ipc";

const w = globalThis as unknown as { window?: { electron?: unknown } };
afterEach(() => { delete w.window; });

describe("ipcResult", () => {
  it("wraps the value preload already unwrapped", async () => {
    w.window = { electron: { project: { merge: () => Promise.resolve({ counts: { notes: 2, cards: 1 } }) } } };
    const r = await ipcResult((e) => (e as unknown as { project: { merge: () => Promise<{ counts: { notes: number } }> } }).project.merge());
    expect(r).toEqual({ data: { counts: { notes: 2, cards: 1 } } });
  });

  it("turns a rejection into { error }", async () => {
    w.window = { electron: { card: { addBlocker: () => Promise.reject(new Error("Circular dependency detected")) } } };
    const r = await ipcResult((e) => (e as unknown as { card: { addBlocker: () => Promise<unknown> } }).card.addBlocker());
    expect(r).toEqual({ error: "Circular dependency detected" });
  });

  it("reports Electron being unavailable", async () => {
    expect(await ipcResult(() => Promise.resolve(1))).toEqual({ error: "Not in Electron" });
  });
});
