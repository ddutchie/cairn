import { afterEach, describe, expect, it } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { PayloadTooLargeError, readBody, sendJson } from "./http-json";

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  return new Promise((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)),
  );
}

describe("http-json", () => {
  it("echoes a JSON body with content-type, length and extra headers", async () => {
    const url = await serve(async (req, res) => {
      const body = JSON.parse(await readBody(req, 1024));
      sendJson(res, 201, { got: body }, { "X-Extra": "1" });
    });
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ a: "é" }) });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-extra")).toBe("1");
    const text = await res.text();
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(text));
    expect(JSON.parse(text)).toEqual({ got: { a: "é" } });
  });

  it("sends undefined as null", async () => {
    const url = await serve((_req, res) => sendJson(res, 200, undefined));
    expect(await (await fetch(url)).json()).toBeNull();
  });

  it("rejects bodies over the limit with a 413 error", async () => {
    let caught: unknown;
    const url = await serve(async (req, res) => {
      try { await readBody(req, 8); } catch (e) { caught = e; }
      res.end();
    });
    await fetch(url, { method: "POST", body: "x".repeat(64) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    expect((caught as PayloadTooLargeError).statusCode).toBe(413);
  });
});
