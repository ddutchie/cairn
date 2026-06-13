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
let server: http.Server | null = null;
let settings: MobileSettings = {
  enabled: false,
  port: 4242,
  authEnabled: true,
  pin: "",
};

// In-memory sessions
const activeSessions = new Set<string>();

// SSE clients map: clientId -> Response + cleanup callback list
interface SseClient {
  res: http.ServerResponse;
  disconnectCallbacks: Set<() => void>;
}
const sseClients = new Map<string, SseClient>();

export function getMobileConfigPath(userDataPath: string): string {
  return path.join(userDataPath, CONFIG_FILE);
}

export function loadMobileSettings(userDataPath: string): MobileSettings {
  const configPath = getMobileConfigPath(userDataPath);
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      settings = {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
        port: typeof parsed.port === "number" ? parsed.port : 4242,
        authEnabled: typeof parsed.authEnabled === "boolean" ? parsed.authEnabled : true,
        pin: typeof parsed.pin === "string" ? parsed.pin : "",
      };
    } catch {
      // Ignore
    }
  }
  
  if (!settings.pin) {
    // Generate random 4-digit PIN
    settings.pin = Math.floor(1000 + Math.random() * 9000).toString();
    saveMobileSettings(userDataPath, settings);
  }
  
  return settings;
}

export function saveMobileSettings(userDataPath: string, newSettings: Partial<MobileSettings>): MobileSettings {
  settings = { ...settings, ...newSettings };
  const configPath = getMobileConfigPath(userDataPath);
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf-8");
  return settings;
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

export async function getMobileStatus(): Promise<MobileStatus> {
  const ip = getLocalIpAddress();
  const url = `http://${ip}:${settings.port}`;
  let qrCode = "";
  try {
    qrCode = await QRCode.toDataURL(url);
  } catch {
    // Ignore
  }
  return {
    running: server !== null,
    url,
    qrCode,
    pin: settings.pin,
  };
}

export function broadcastToMobile(channel: string, payload: any): void {
  const data = JSON.stringify({ channel, payload });
  for (const [clientId, client] of sseClients.entries()) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      console.warn(`[mobile-server] Failed to send to SSE client: ${clientId}`);
    }
  }
}

// Set callback in the central IPC registry
setMobileBroadcastCallback(broadcastToMobile);

function getMobileBridgeScript(platform: string): string {
  return `(function() {
  if (typeof window === "undefined") return;

  const clientId = "client_" + Math.random().toString(36).substring(2, 11);
  const listeners = new Map();

  function getEventName(path) {
    const pathStr = path.join(".");
    const EVENT_MAP = {
      "onDbChanged": "db:changed",
      "onAiWriteStarted": "note:aiWriteStarted",
      "onAiWriteEnded": "note:aiWriteEnded",
      "onMcpUnreadCount": "mcp:unread-count",
      "onMigrationProgress": "app:migrationProgress",
      "chat.onToken": "chat:token",
      "chat.onDone": "chat:done",
      "chat.onToolCall": "chat:tool-call",
      "chat.onToolCallDone": "chat:tool-call-done",
      "chat.onUsage": "chat:usage",
      "agent.onData": "agent:data",
      "agent.onExit": "agent:exit",
      "piAgent.onToken": "pi-agent:token",
      "piAgent.onTool": "pi-agent:tool",
      "piAgent.onDone": "pi-agent:done",
      "piAgent.onError": "pi-agent:error",
      "piAgent.onToolsReady": "pi-agent:tools-ready",
      "piAgent.onStep": "pi-agent:step",
      "piAgent.onUsage": "pi-agent:usage",
      "piAgent.onRetry": "pi-agent:retry",
      "piAgent.onCompact": "pi-agent:compact",
      "piAgent.onCompactResult": "pi-agent:compact-result",
      "piAgent.onSubagent": "pi-agent:subagent",
      "piAgent.onPlanNote": "pi-agent:plan-note",
      "piAgent.onNoteUpdated": "pi-agent:note-updated",
      "piAgent.onModeChange": "pi-agent:mode-change",
      "piAgent.onAskQuestions": "pi-agent:ask-questions",
      "llama.models.onProgress": "llama:download-progress",
      "llama.binary.onProgress": "llama:binary-progress"
    };
    return EVENT_MAP[pathStr] || pathStr;
  }

  function addListener(eventName, callback) {
    if (!listeners.has(eventName)) {
      listeners.set(eventName, new Set());
    }
    listeners.get(eventName).add(callback);
  }

  function removeListener(eventName, callback) {
    const set = listeners.get(eventName);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        listeners.delete(eventName);
      }
    }
  }

  function triggerListeners(eventName, payload) {
    const set = listeners.get(eventName);
    if (set) {
      for (const cb of set) {
        try { cb(payload); } catch (e) { console.error(e); }
      }
    }
  }

  const eventSource = new EventSource("/api/events?clientId=" + clientId);
  eventSource.onmessage = function(e) {
    try {
      const data = JSON.parse(e.data);
      triggerListeners(data.channel, data.payload);
    } catch (err) {
      console.error("Error handling server event:", err);
    }
  };

  function createIpcProxy(path = []) {
    return new Proxy(() => {}, {
      get(target, prop) {
        if (prop === "then") return undefined;
        if (path.length === 0 && prop === "platform") return "${platform}";
        return createIpcProxy([...path, prop]);
      },
      apply(target, thisArg, args) {
        const lastKey = path[path.length - 1];
        if (typeof lastKey === "string" && lastKey.startsWith("on") && lastKey[2] === lastKey[2]?.toUpperCase()) {
          const callback = args[0];
          const eventName = getEventName(path);
          addListener(eventName, callback);
          return () => removeListener(eventName, callback);
        }
        
        let channelName = path.join(":");
        const channelMap = {
          "snapshot": "db:snapshot",
          "hasData": "db:hasData",
          "workspace:list": "db:workspace:list",
          "workspace:create": "db:workspace:create",
          "workspace:update": "db:workspace:update",
          "project:list": "db:project:list",
          "project:create": "db:project:create",
          "project:update": "db:project:update",
          "project:delete": "db:project:delete",
          "note:list": "db:note:list",
          "note:create": "db:note:create",
          "note:update": "db:note:update",
          "note:delete": "db:note:delete",
          "note:moveToFolder": "db:note:moveToFolder",
          "column:list": "db:column:list",
          "column:create": "db:column:create",
          "column:update": "db:column:update",
          "column:delete": "db:column:delete",
          "card:list": "db:card:list",
          "card:create": "db:card:create",
          "card:update": "db:card:update",
          "card:delete": "db:card:delete",
          "card:archiveDone": "db:cards:archive-done",
          "card:addBlocker": "db:card:addBlocker",
          "card:removeBlocker": "db:card:removeBlocker",
          "card:ready": "db:card:ready",
          "flow:get": "db:flow:get",
          "flow:node:create": "db:flow:node:create",
          "flow:node:update": "db:flow:node:update",
          "flow:node:delete": "db:flow:node:delete",
          "flow:node:summarize": "db:flow:node:summarize",
          "flow:edge:create": "db:flow:edge:create",
          "flow:edge:delete": "db:flow:edge:delete",
          "flow:url:fetch": "db:flow:url:fetch",
          "tag:list": "db:tag:list",
          "tag:create": "db:tag:create",
          "tag:update": "db:tag:update",
          "tag:delete": "db:tag:delete",
          "chat:threads": "db:chat:threads",
          "chat:messages": "db:chat:messages",
          "chat:upsertThread": "db:chat:upsertThread",
          "chat:addMessage": "db:chat:addMessage",
          "chat:deleteThread": "db:chat:deleteThread",
          "chat:clearThreadMessages": "db:chat:clearThreadMessages",
          "chat:compactThread": "chat:compactThread",
          "chat:stream": "chat:stream",
          "chat:abort": "chat:abort",
          "graph:get": "db:graph:get",
          "graph:neighbors": "db:graph:neighbors",
          "graph:recompute": "db:graph:recompute",
          "ai:generatePrd": "ai:generatePrd",
          "ai:localLLMStatus": "ai:localLLMStatus",
          "mcpServerPath": "app:mcpServerPath",
          "latestChangelog": "app:latestChangelog",
          "revealNote": "app:revealNote",
          "exportNotePdf": "app:exportNotePdf",
          "openExternal": "app:openExternal",
          "uploadAsset": "app:uploadAsset",
          "revealAssets": "app:revealAssets",
          "selectWorkspaceFolder": "app:selectWorkspaceFolder",
          "getWorkspacePath": "app:getWorkspacePath",
          "needsWorkspaceSetup": "app:needsWorkspaceSetup",
          "setTheme": "app:setTheme",
          "initWorkspace": "app:initWorkspace",
          "relaunch": "app:relaunch",
          "resetAllData": "app:reset",
          "checkMigrations": "app:checkMigrations",
          "runMigration": "app:runMigration",
          "updater:install": "updater:install",
          "markMcpNotificationsRead": "mcp:markNotificationsRead",
          "mcpQuery": "db:mcpQuery",
          "piAgent:listSessions": "db:piSession:list",
          "piAgent:createSession": "db:piSession:create",
          "piAgent:deleteSession": "db:piSession:delete",
          "piAgent:getMessages": "db:piSession:messages",
          "piAgent:saveMessages": "db:piSession:saveMessages",
          "piAgent:prompt": "pi-agent:prompt",
          "piAgent:abort": "pi-agent:abort",
          "piAgent:clear": "pi-agent:clear",
          "piAgent:destroy": "pi-agent:destroy",
          "piAgent:compactNow": "pi-agent:compact-now",
          "piAgent:approvePlan": "pi-agent:approve-plan",
          "piAgent:restoreContext": "pi-agent:restore-context",
          "piAgent:previewPrompt": "pi-agent:preview-prompt"
        };
        
        const mappedChannel = channelMap[channelName] || channelName;
        
        return fetch("/api/ipc", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-client-id": clientId
          },
          body: JSON.stringify({ channel: mappedChannel, args })
        })
        .then(res => res.json())
        .then(result => {
          if (result && result.error) {
            throw new Error(result.error);
          }
          return result.data;
        });
      }
    });
  }

  window.electron = createIpcProxy([]);
})();`;
}

const loginHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cairn Mobile Access</title>
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

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    list[parts[0].trim()] = decodeURIComponent((parts[1] || "").trim());
  });
  return list;
}

export function startMobileServer(userDataPath: string, ctx: DbContext): void {
  if (server) return;
  
  loadMobileSettings(userDataPath);
  
  const outDir = path.join(__dirname, "../out");

  server = http.createServer((req, res) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    
    // ── 1. API: PIN Authentication ──
    if (pathname === "/api/auth" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.pin === settings.pin) {
            const token = crypto.randomBytes(16).toString("hex");
            activeSessions.add(token);
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
    const isAuthed = !settings.authEnabled || (token && activeSessions.has(token));

    if (!isAuthed) {
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
      sseClients.set(clientId, { res, disconnectCallbacks });
      
      req.on("close", () => {
        sseClients.delete(clientId);
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
          const client = sseClients.get(clientId);
          const mockEvent = {
            sender: {
              id: clientId,
              isDestroyed: () => !sseClients.has(clientId),
              send: (ch: string, payload: any) => {
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    // ── 7. Static Next.js Files Serving ──
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
          // SPA Fallback: serve root index.html
          filePath = path.join(outDir, "index.html");
        }
      }

      // Check directory traversal constraint
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
        // Dynamically inject the mobile bridge script inside the HTML file
        let content = fs.readFileSync(filePath, "utf-8");
        content = content.replace("<head>", '<head><script src="/mobile-bridge.js"></script>');
        res.end(content);
      } else {
        res.end(fs.readFileSync(filePath));
      }
      return;
    }

    // Default fallback
    res.writeHead(405);
    res.end("Method Not Allowed");
  });

  server.listen(settings.port, "0.0.0.0", () => {
    console.log(`[mobile-server] Exposing Cairn at http://0.0.0.0:${settings.port}`);
  });
}

export function stopMobileServer(): void {
  if (server) {
    server.close();
    server = null;
    activeSessions.clear();
    sseClients.clear();
    console.log("[mobile-server] Stopped mobile access server.");
  }
}
