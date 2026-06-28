import { describe, it, expect } from "vitest";
import { startLoopbackListener } from "./oauth-loopback";

/** Perform a GET against the loopback listener and return the status code. */
async function get(url: string): Promise<number> {
  const res = await fetch(url, { redirect: "manual" });
  return res.status;
}

describe("startLoopbackListener", () => {
  it("binds to a random 127.0.0.1 port and reports its redirect URI", async () => {
    const l = await startLoopbackListener();
    try {
      expect(l.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    } finally {
      l.close();
    }
  });

  it("resolves waitForCallback with code/state from the callback request", async () => {
    const l = await startLoopbackListener();
    const status = await get(`${l.redirectUri}?code=the-code&state=the-state`);
    expect(status).toBe(200);
    await expect(l.waitForCallback).resolves.toEqual({ code: "the-code", state: "the-state" });
  });

  it("404s any path other than /callback without resolving", async () => {
    const l = await startLoopbackListener();
    const base = l.redirectUri.replace("/callback", "");
    try {
      expect(await get(`${base}/other`)).toBe(404);
    } finally {
      l.close();
    }
  });

  it("rejects a callback missing code/state with a 400", async () => {
    const l = await startLoopbackListener();
    const status = await get(`${l.redirectUri}?code=only`);
    expect(status).toBe(400);
    await expect(l.waitForCallback).rejects.toThrow(/code\/state/);
  });

  it("rejects waitForCallback when closed before completion", async () => {
    const l = await startLoopbackListener();
    l.close();
    await expect(l.waitForCallback).rejects.toThrow(/closed before completion/);
  });

  it("uses a fresh port for each listener", async () => {
    const a = await startLoopbackListener();
    const b = await startLoopbackListener();
    try {
      expect(a.redirectUri).not.toBe(b.redirectUri);
    } finally {
      a.close();
      b.close();
    }
  });
});
