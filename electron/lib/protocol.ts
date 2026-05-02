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

import { session, net } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";

const isDev = !require("electron").app.isPackaged;

// workspacePath is set once registerAssetProtocol() is called from main.ts
let _workspacePath: string | null = null;

export function registerAssetProtocol(workspacePath: string): void {
  _workspacePath = workspacePath;
  session.defaultSession.protocol.handle("asset", (request) => {
    const url = new URL(request.url);
    // url.hostname is the filename, e.g. asset://abc123.png → hostname="abc123.png"
    // url.pathname may be "/" — the actual filename is in hostname for asset:// URLs
    const filename = decodeURIComponent(url.hostname + url.pathname.replace(/^\//, ""));
    if (!_workspacePath) return new Response("No workspace", { status: 503 });
    const assetDir = path.join(_workspacePath, "assets");
    const filePath = path.join(assetDir, filename);
    // Prevent path traversal
    if (!filePath.startsWith(assetDir + path.sep) && filePath !== assetDir) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fs.existsSync(filePath)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).href);
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
          "img-src 'self' data: blob: asset:",
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
          "img-src 'self' data: blob: app: asset:",
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
