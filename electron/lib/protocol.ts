/**
 * Cairn — Protocol + CSP setup
 *
 * Registers the `app://` custom scheme and sets Content-Security-Policy
 * headers for all responses. Called once after `app.whenReady()`.
 *
 * Also registers the `asset://` scheme which serves files from
 * <workspacePath>/assets/ so the renderer can display pasted images
 * without bypassing Electron's sandbox.
 */

import { session, net, app } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";

const isDev = !app.isPackaged;

// Active workspace path — updated by setAssetWorkspacePath() without
// re-registering the handler (protocol.handle may only be called once per scheme).
let _workspacePath: string | null = null;

/**
 * Update the workspace path used by the asset:// handler.
 * Call this whenever the active workspace changes (initial setup + reinitialise).
 */
export function setAssetWorkspacePath(workspacePath: string): void {
  _workspacePath = workspacePath;
}

/**
 * Register the asset:// protocol handler exactly once on app startup.
 * Uses _workspacePath at request time so setAssetWorkspacePath() updates
 * take effect immediately without re-registering.
 */
export function registerAssetProtocol(): void {
  session.defaultSession.protocol.handle("asset", (request) => {
    const url = new URL(request.url);
    const filename = decodeURIComponent(url.hostname + url.pathname.replace(/^\//, ""));
    if (!_workspacePath) return new Response("No workspace", { status: 503 });
    const assetDir = path.resolve(_workspacePath, "assets");
    const filePath = path.resolve(assetDir, filename);
    if (!filePath.startsWith(assetDir + path.sep) && filePath !== assetDir) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fs.existsSync(filePath)) return new Response("Not found", { status: 404 });
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mimeTypes: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      avif: "image/avif",
    };
    const mime = mimeTypes[ext] ?? "application/octet-stream";
    const data = fs.readFileSync(filePath);
    return new Response(data, { headers: { "Content-Type": mime } });
  });
}

export function setupProtocol(outDir: string): void {
  if (!isDev) {
    session.defaultSession.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      let filePath = url.pathname.replace(/^\/\.\//, "").replace(/^\//, "");
      if (!filePath) filePath = "index.html";
      const fullPath = path.join(outDir, filePath);
      return net.fetch(pathToFileURL(fullPath).href);
    });
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? [
          "default-src 'self' http://localhost:* ws://localhost:*",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
          "style-src 'self' 'unsafe-inline'",
          "style-src-elem 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: asset: https:",
          "font-src 'self' data: https://fonts.gstatic.com",
          "connect-src 'self' http://localhost:* ws://localhost:*",
          "worker-src blob: 'self'",
          "frame-src blob:",
        ].join("; ")
      : [
          "default-src 'self' app:",
          "script-src 'self' 'unsafe-inline' app:",
          "style-src 'self' 'unsafe-inline' app:",
          "style-src-elem 'self' 'unsafe-inline' app:",
          "img-src 'self' data: blob: app: asset: https:",
          "font-src 'self' data: app:",
          "connect-src 'self' app: http://localhost:* https:",
          "worker-src blob: 'self' app:",
          "frame-src blob:",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}
