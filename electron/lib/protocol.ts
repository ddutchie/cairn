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
import { resolveWithinRoot } from "../ipc/path-safety";

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
  // Cache for workspace-wide filename lookups (cleared on workspace change)
  const fileCache = new Map<string, string>();

  session.defaultSession.protocol.handle("asset", (request) => {
    const url = new URL(request.url);
    let filename = decodeURIComponent(url.hostname + url.pathname);
    if (filename.endsWith("/")) {
      filename = filename.slice(0, -1);
    }
    if (!_workspacePath) return new Response("No workspace", { status: 503 });

    // Try locations in priority order:
    // 1. <ws>/assets/<filename>  (legacy Cairn SHA-hashed images)
    // 2. <ws>/attachments/<filename>  (Obsidian default attachment folder)
    // 3. Recursive search of workspace root (Obsidian vault-root images)

    const candidates = [
      path.resolve(_workspacePath, "assets", filename),
      path.resolve(_workspacePath, "attachments", filename),
    ];

    let filePath: string | null = null;
    const isWithinWorkspace = (p: string): boolean => {
      // Canonical containment check (sep-aware). Use resolveWithinRoot helper where possible.
      const rel = path.relative(path.resolve(_workspacePath!), path.resolve(p));
      // resolveWithinRoot returns null on escape via .. or absolute segments
      const viaHelper = resolveWithinRoot(_workspacePath!, rel);
      if (viaHelper !== null) return true;
      const root = path.resolve(_workspacePath!);
      const resolved = path.resolve(p);
      return resolved === root || resolved.startsWith(root + path.sep);
    };
    for (const candidate of candidates) {
      if (!isWithinWorkspace(candidate)) continue;
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }

    // Fallback: search workspace recursively (for Obsidian vault-root images)
    if (!filePath) {
      const cached = fileCache.get(filename);
      if (cached && fs.existsSync(cached) && isWithinWorkspace(cached)) {
        filePath = cached;
      } else {
        const found = findFileRecursive(_workspacePath, filename);
        if (found && isWithinWorkspace(found)) {
          filePath = found;
          fileCache.set(filename, found);
        }
      }
    }

    if (!filePath) return new Response("Not found", { status: 404 });
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

/**
 * Recursively search for a file by name within a directory.
 * Skips dot-prefixed directories and common non-content dirs.
 */
function findFileRecursive(dir: string, filename: string, depth = 0): string | null {
  if (depth > 5) return null; // prevent deep recursion
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const fp = path.join(dir, entry);
      const stat = fs.lstatSync(fp);
      if (stat.isFile() && entry === filename) return fp;
      if (stat.isDirectory() && entry !== "node_modules") {
        const found = findFileRecursive(fp, filename, depth + 1);
        if (found) return found;
      }
    }
  } catch { /* unreadable dir */ }
  return null;
}

export function setupProtocol(outDir: string): void {
  if (!isDev) {
    session.defaultSession.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      let filePath = url.pathname.replace(/^\/\.\//, "").replace(/^\//, "");
      if (!filePath) filePath = "index.html";
      const fullPath = path.join(outDir, filePath);
      // H1: path-traversal guard for app:// — must stay within outDir (sep-aware).
      const resolved = path.resolve(fullPath);
      const root = path.resolve(outDir);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return new Response("Not found", { status: 404 });
      }
      // Defense-in-depth: also via resolveWithinRoot helper
      const rel = path.relative(root, resolved);
      if (resolveWithinRoot(root, rel) === null && resolved !== root) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(resolved).href);
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
          // Loopback LLM endpoints (fetched from the renderer) need both spellings
          // — CSP matches origins literally. Scope the expansion to connect-src;
          // script/default only need the dev server (localhost:3000).
          "connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
          "worker-src blob: 'self'",
          "frame-src blob: https:",
        ].join("; ")
      : [
          "default-src 'self' app:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' app:",
          "style-src 'self' 'unsafe-inline' app:",
          "style-src-elem 'self' 'unsafe-inline' app:",
          "img-src 'self' data: blob: app: asset: https:",
          "font-src 'self' data: app:",
          // Allow loopback LLM endpoints over plain http (local servers like
          // Ollama / LM Studio). Both spellings must be listed — CSP matches the
          // origin string literally, so localhost and 127.0.0.1 are distinct.
          "connect-src 'self' app: http://localhost:* http://127.0.0.1:* https:",
          "worker-src blob: 'self' app:",
          "frame-src blob: https:",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}
