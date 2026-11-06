import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, writesDuring } from "./ipc";

describe("writesDuring", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electron: {} };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("waits for the writes started inside it", async () => {
    let finish = () => {};
    let settled = false;
    const done = writesDuring(() => ipc(() => new Promise<void>((resolve) => { finish = resolve; })))
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await done;
    expect(settled).toBe(true);
  });

  it("rejects when a write fails", async () => {
    await expect(writesDuring(() => {
      ipc(() => Promise.resolve());
      ipc(() => Promise.reject(new Error("disk full")));
    })).rejects.toThrow("disk full");
  });

  it("ignores writes started outside it", async () => {
    await writesDuring(() => {});
    ipc(() => Promise.reject(new Error("unrelated")));
    await expect(writesDuring(() => ipc(() => Promise.resolve()))).resolves.toBeUndefined();
  });
});
