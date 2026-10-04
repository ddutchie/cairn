/**
 * JSON helpers for Cairn's small `node:http` servers (MCP, runtime,
 * embeddings, mobile). Dependency-free so the standalone server bundles can
 * import it.
 */

import type * as http from "http";

/** Rejected by {@link readBody} when the body exceeds its limit. */
export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor() {
    super("payload too large");
  }
}

/** Read the whole request body as UTF-8, destroying the request past `maxBytes`. */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Write `body` as a JSON response with a correct Content-Length. `undefined`
 * (e.g. a void IPC handler) is sent as `null` so clients can always parse it.
 */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body) ?? "null";
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
