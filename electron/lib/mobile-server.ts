import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import QRCode from "qrcode";
import { getIpcHandler, setMobileBroadcastCallback } from "../ipc/registry";
import type { DbContext } from "../ipc/handlers";

export interface MobileSettings {
  enabled: boolean;
  port: number;
  authEnabled: boolean;
  pin: string;
}

export interface MobileStatus {
  running: boolean;
  url: string;
  qrCode: string;
  pin: string;
}

const CONFIG_FILE = "mobile-config.json";
const SESSIONS_FILE = "mobile-sessions.json";

// SSE clients map: clientId -> Response + cleanup callback list
interface SseClient {
  res: http.ServerResponse;
  disconnectCallbacks: Set<() => void>;
}

export class MobileServer {
  private server: http.Server | null = null;
  private settings: MobileSettings;
  private activeSessions = new Set<string>();
  private activeUserDataPath: string;
  private sseClients = new Map<string, SseClient>();

  constructor(userDataPath: string, settings: MobileSettings) {
    this.activeUserDataPath = userDataPath;
    this.settings = settings;

    // Load sessions
    const sessionsPath = path.join(userDataPath, SESSIONS_FILE);
    if (fs.existsSync(sessionsPath)) {
      try {
        const raw = fs.readFileSync(sessionsPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.activeSessions = new Set(parsed);
        }
      } catch {
        // Ignore
      }
    }
  }

  private saveSessions(): void {
    try {
      const sessionsPath = path.join(this.activeUserDataPath, SESSIONS_FILE);
      fs.writeFileSync(sessionsPath, JSON.stringify(Array.from(this.activeSessions)), "utf-8");
    } catch (err) {
      console.error("[mobile-server] Failed to save sessions:", err);
    }
  }

  public start(ctx: DbContext): void {
    if (this.server) return;

    const outDir = path.join(__dirname, "../out");

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      let pathname = decodeURIComponent(url.pathname);

      // Alias apple-touch-icons to main icon
      if (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png") {
        pathname = "/icon.png";
      }

      // ── 1. API: PIN Authentication ──
      if (pathname === "/api/auth" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.pin === this.settings.pin) {
              const token = crypto.randomBytes(16).toString("hex");
              this.activeSessions.add(token);
              this.saveSessions();
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Set-Cookie": `cairn_session_token=${token}; Path=/; HttpOnly; Max-Age=31536000`,
              });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "Invalid PIN code" }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Malformed request" }));
          }
        });
        return;
      }

      // ── 2. Authenticate Session ──
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.cairn_session_token;
      const isAuthed = !this.settings.authEnabled || (token && this.activeSessions.has(token));
      const isFavicon = pathname === "/favicon.ico" || pathname === "/favicon.svg" || pathname === "/icon.png";

      if (!isAuthed && !isFavicon) {
        // Unauthenticated client: serve login page for GET, else 401
        if (req.method === "GET" && !pathname.startsWith("/api/")) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(loginHtml);
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
        }
        return;
      }

      // ── 3. SSE Stream ──
      if (pathname === "/api/events" && req.method === "GET") {
        const clientId = url.searchParams.get("clientId") || "anonymous_" + Math.random().toString(36).substring(2, 9);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
        });

        const disconnectCallbacks = new Set<() => void>();
        this.sseClients.set(clientId, { res, disconnectCallbacks });

        req.on("close", () => {
          this.sseClients.delete(clientId);
          // Fire cleanup/exit callbacks for this client's active agent terminal sessions
          for (const cb of disconnectCallbacks) {
            try { cb(); } catch (err) {
              console.error("[mobile-server] Disconnect cleanup error:", err);
            }
          }
        });
        return;
      }

      // ── 4. Dynamic Bridge Script ──
      if (pathname === "/mobile-bridge.js" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(getMobileBridgeScript(process.platform));
        return;
      }

      // ── 5. API: Asset Handler ──
      if (pathname.startsWith("/api/assets/") && req.method === "GET") {
        const filename = pathname.replace(/^\/api\/assets\//, "");

        // Look for the asset inside attachments or assets subfolders in workspace
        const candidates = [
          path.resolve(ctx.workspacePath, "assets", filename),
          path.resolve(ctx.workspacePath, "attachments", filename),
        ];

        let filePath: string | null = null;
        for (const candidate of candidates) {
          if (candidate.startsWith(ctx.workspacePath) && fs.existsSync(candidate)) {
            filePath = candidate;
            break;
          }
        }

        if (!filePath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mimeTypes: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          avif: "image/avif",
        };
        const mime = mimeTypes[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(fs.readFileSync(filePath));
        return;
      }

      // ── 6. API: IPC Handler Bridge ──
      if (pathname === "/api/ipc" && req.method === "POST") {
        const clientId = req.headers["x-client-id"] as string || "anonymous";
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const { channel, args = [] } = JSON.parse(body);
            const handler = getIpcHandler(channel);
            if (!handler) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Unknown IPC channel: ${channel}` }));
              return;
            }

            // Create a mock Event object with custom sender pointing to the specific SSE client connection
            const client = this.sseClients.get(clientId);
            const mockEvent = {
              sender: {
                id: clientId,
                isDestroyed: () => !this.sseClients.has(clientId),
                send: (ch: string, payload: unknown) => {
                  // Route stream/done events to this specific client's SSE response
                  if (client) {
                    try {
                      client.res.write(`data: ${JSON.stringify({ channel: ch, payload })}\n\n`);
                    } catch {
                      // Ignore
                    }
                  }
                },
                once: (evt: string, cb: () => void) => {
                  if (evt === "destroyed" && client) {
                    client.disconnectCallbacks.add(cb);
                  }
                }
              }
            };

            const result = await handler(mockEvent, ...args);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (error as Error).message }));
          }
        });
        return;
      }

      // ── 7. Dev Server Proxy / Static Next.js Files Serving ──
      const isDev = process.env.NODE_ENV === "development";

      if (isDev) {
        const proxyHeaders = { ...req.headers };
        proxyHeaders["host"] = "localhost:3000";
        proxyHeaders["origin"] = "http://localhost:3000";
        proxyHeaders["referer"] = "http://localhost:3000/";
        proxyHeaders["accept-encoding"] = "identity";

        const proxyReq = http.request(
          {
            host: "localhost",
            port: 3000,
            path: req.url,
            method: req.method,
            headers: proxyHeaders,
          },
          (proxyRes) => {
            const contentType = proxyRes.headers["content-type"] || "";

            if (contentType.includes("text/html")) {
              let content = "";
              proxyRes.on("data", (chunk) => { content += chunk; });
              proxyRes.on("end", () => {
                content = content.replace("<head>", '<head><script src="/mobile-bridge.js"></script>');
                const headers = { ...proxyRes.headers };
                delete headers["content-length"];
                delete headers["content-encoding"];
                res.writeHead(proxyRes.statusCode || 200, headers);
                res.end(content);
              });
            } else {
              res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
              proxyRes.pipe(res);
            }
          }
        );

        proxyReq.on("error", (err) => {
          console.error("[mobile-server] Dev proxy error:", err);
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Bad Gateway: Next.js dev server is not running or reachable.");
        });

        req.pipe(proxyReq);
        return;
      }

      if (req.method === "GET") {
        const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
        let filePath = path.join(outDir, safePath);

        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
          }
        } else {
          if (fs.existsSync(filePath + ".html")) {
            filePath = filePath + ".html";
          } else {
            filePath = path.join(outDir, "index.html");
          }
        }

        const relative = path.relative(outDir, filePath);
        const isSafe = relative && !relative.startsWith("..") && !path.isAbsolute(relative);

        if (!isSafe || !fs.existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".webp": "image/webp",
        };

        const mime = mimeTypes[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });

        if (ext === ".html") {
          let content = fs.readFileSync(filePath, "utf-8");
          content = content.replace("<head>", '<head><script src="/mobile-bridge.js"></script>');
          res.end(content);
        } else {
          res.end(fs.readFileSync(filePath));
        }
        return;
      }

      res.writeHead(405);
      res.end("Method Not Allowed");
    });

    if (process.env.NODE_ENV === "development") {
      this.server.on("upgrade", (req, socket, head) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const net = require("net");
        const clientSocket = net.connect(3000, "localhost");

        socket.pipe(clientSocket);
        clientSocket.pipe(socket);

        clientSocket.write(`${req.method} ${req.url || ""} HTTP/${req.httpVersion}\r\n`);
        for (const [key, value] of Object.entries(req.headers)) {
          let val = value;
          const k = key.toLowerCase();
          if (k === "host") {
            val = "localhost:3000";
          } else if (k === "origin") {
            val = "http://localhost:3000";
          } else if (k === "referer") {
            val = "http://localhost:3000/";
          }
          if (Array.isArray(val)) {
            val.forEach((v) => {
              clientSocket.write(`${key}: ${v}\r\n`);
            });
          } else if (val !== undefined) {
            clientSocket.write(`${key}: ${val}\r\n`);
          }
        }
        clientSocket.write("\r\n");
        clientSocket.write(head);

        clientSocket.on("error", (err) => {
          console.error("[mobile-server] Dev ws proxy error:", err);
          socket.end();
        });

        socket.on("error", (err) => {
          console.error("[mobile-server] Client socket error:", err);
          clientSocket.end();
        });
      });
    }

    this.server.listen(this.settings.port, "0.0.0.0", () => {
      console.log(`[mobile-server] Exposing Cairn at http://0.0.0.0:${this.settings.port}`);
    });

    setMobileBroadcastCallback((channel, payload) => this.broadcastToMobile(channel, payload));
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.activeSessions.clear();
      this.sseClients.clear();
      setMobileBroadcastCallback(null);
      console.log("[mobile-server] Stopped mobile access server.");
    }
  }

  public broadcastToMobile(channel: string, payload: unknown): void {
    const data = JSON.stringify({ channel, payload });
    for (const [clientId, client] of this.sseClients.entries()) {
      try {
        client.res.write(`data: ${data}\n\n`);
      } catch {
        console.warn(`[mobile-server] Failed to send to SSE client: ${clientId}`);
      }
    }
  }
}

let activeServer: MobileServer | null = null;

export function getMobileConfigPath(userDataPath: string): string {
  return path.join(userDataPath, CONFIG_FILE);
}

export function loadMobileSettings(userDataPath: string): MobileSettings {
  const configPath = getMobileConfigPath(userDataPath);
  let localSettings: MobileSettings = {
    enabled: false,
    port: 4242,
    authEnabled: true,
    pin: "",
  };
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      localSettings = {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
        port: typeof parsed.port === "number" ? parsed.port : 4242,
        authEnabled: typeof parsed.authEnabled === "boolean" ? parsed.authEnabled : true,
        pin: typeof parsed.pin === "string" ? parsed.pin : "",
      };
    } catch {
      // Ignore
    }
  }

  if (!localSettings.pin) {
    // Generate random 4-digit PIN
    localSettings.pin = Math.floor(1000 + Math.random() * 9000).toString();
    saveMobileSettings(userDataPath, localSettings);
  }

  return localSettings;
}

export function saveMobileSettings(userDataPath: string, newSettings: Partial<MobileSettings>): MobileSettings {
  const localSettings = loadMobileSettings(userDataPath);
  const updated = { ...localSettings, ...newSettings };
  const configPath = getMobileConfigPath(userDataPath);
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (iface) {
      for (const entry of iface) {
        if (entry.family === "IPv4" && !entry.internal) {
          return entry.address;
        }
      }
    }
  }
  return "127.0.0.1";
}

export async function getMobileStatus(userDataPath: string): Promise<MobileStatus> {
  const localSettings = loadMobileSettings(userDataPath);
  const ip = getLocalIpAddress();
  const url = `http://${ip}:${localSettings.port}`;
  let qrCode = "";
  try {
    qrCode = await QRCode.toDataURL(url);
  } catch {
    // Ignore
  }
  return {
    running: activeServer !== null,
    url,
    qrCode,
    pin: localSettings.pin,
  };
}

export function startMobileServer(userDataPath: string, ctx: DbContext): void {
  if (activeServer) return;
  const localSettings = loadMobileSettings(userDataPath);
  activeServer = new MobileServer(userDataPath, localSettings);
  activeServer.start(ctx);
}

export function stopMobileServer(): void {
  if (activeServer) {
    activeServer.stop();
    activeServer = null;
  }
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    list[parts[0].trim()] = decodeURIComponent((parts[1] || "").trim());
  });
  return list;
}

function getMobileBridgeScript(platform: string): string {
  const preloadPath = path.join(__dirname, "preload.js");
  let preloadCode = "";
  if (fs.existsSync(preloadPath)) {
    preloadCode = fs.readFileSync(preloadPath, "utf-8");
  } else {
    console.error(`[mobile-server] preload.js not found at ${preloadPath}`);
  }

  // Strip commonjs and node-only parts, inject browser-safe mocks
  preloadCode = preloadCode
    .replace('var import_electron = require("electron");', "")
    .replace('module.exports = __toCommonJS(preload_exports);', "")
    .replace('import_electron.contextBridge.exposeInMainWorld("electron", api);', "window.electron = api;")
    .replace('platform: process.platform,', `platform: "${platform}",`);

  return `(function() {
  if (typeof window === "undefined") return;

  const clientId = "client_" + Math.random().toString(36).substring(2, 11);
  const listeners = new Map();

  const import_electron = {
    ipcRenderer: {
      invoke(channel, payload) {
        return fetch("/api/ipc", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-client-id": clientId
          },
          body: JSON.stringify({ channel, args: [payload] })
        })
        .then(res => res.json())
        .then(result => {
          return result; 
        });
      },
      send(channel, payload) {
        fetch("/api/ipc", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-client-id": clientId
          },
          body: JSON.stringify({ channel, args: [payload] })
        }).catch(err => console.error("Fire-and-forget IPC error:", err));
      },
      on(channel, cb) {
        if (!listeners.has(channel)) {
          listeners.set(channel, new Set());
        }
        listeners.get(channel).add(cb);
      },
      off(channel, cb) {
        const set = listeners.get(channel);
        if (set) {
          set.delete(cb);
          if (set.size === 0) listeners.delete(channel);
        }
      }
    },
    contextBridge: {
      exposeInMainWorld(name, value) {
        window[name] = value;
      }
    }
  };

  const eventSource = new EventSource("/api/events?clientId=" + clientId);
  eventSource.onmessage = function(e) {
    try {
      const data = JSON.parse(e.data);
      const set = listeners.get(data.channel);
      if (set) {
        for (const cb of set) {
          try { cb(null, data.payload); } catch (err) { console.error(err); }
        }
      }
    } catch (err) {
      console.error("Error handling server event:", err);
    }
  };

  // ── PRELOAD CODE START ──
  ${preloadCode}
  // ── PRELOAD CODE END ──
  })();`;
}

const loginHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Cairn Mobile Access</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <style>
    :root {
      --background: #0d0d0d;
      --surface: #141414;
      --surface-2: #1e1e1e;
      --border: #2a2a2a;
      --text-primary: #f5f4f1;
      --text-secondary: #b4b3b0;
      --accent: #8b5cf6;
      --accent-hover: #7c3aed;
      --danger: #ef4444;
    }
    body {
      background-color: var(--background);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background-color: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .logo {
      width: 48px;
      height: 48px;
      margin: 0 auto 20px;
      background-color: var(--surface-2);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 8px;
    }
    p {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin: 0 0 24px;
      line-height: 1.5;
    }
    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      background-color: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 12px;
      border-radius: 8px;
      font-size: 1rem;
      letter-spacing: 0.1em;
      text-align: center;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
    }
    button {
      width: 100%;
      background-color: var(--accent);
      color: white;
      border: none;
      padding: 12px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    button:hover {
      background-color: var(--accent-hover);
    }
    .error-msg {
      color: var(--danger);
      font-size: 0.8125rem;
      margin-top: 12px;
      min-height: 1.25rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    </div>
    <h1>Enter PIN Code</h1>
    <p>Please enter the one-time PIN code shown on your Cairn desktop application to access your notes and agents.</p>
    <form id="login-form">
      <div class="input-group">
        <input type="text" id="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="••••">
      </div>
      <button type="submit">Verify PIN</button>
      <div class="error-msg" id="error-msg"></div>
    </form>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = document.getElementById('pin-input').value.trim();
      const errorEl = document.getElementById('error-msg');
      errorEl.textContent = '';
      
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          errorEl.textContent = data.error || 'Invalid PIN code';
        }
      } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
      }
    });
  </script>
</body>
</html>`;
