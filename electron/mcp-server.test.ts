/**
 * MCP server smoke test
 *
 * Spawns the bundled JS (dist-mcp/mcp-server.bundle.js) as a subprocess and
 * verifies it does NOT crash with the Zod "undefined is not a constructor"
 * error that occurs when `init_zod()` runs after the MCP SDK's inline
 * types.js code.
 *
 * The Zod crash happens synchronously at module load time, so we just need
 * to check stderr for the crash pattern within a short window. If the
 * process survives module load (outputs anything to stderr, exits cleanly,
 * hits a Node version mismatch, or waits for stdin), the Zod init passed.
 */
import { describe, it, expect, onTestFailed } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import { applySchema } from "./db/schema";
import { createWorkspace, createProject } from "./db/queries";

const BUNDLE_PATH = path.resolve(__dirname, "..", "dist-mcp", "mcp-server.bundle.js");
const STARTUP_WAIT_MS = 5_000;

describe("MCP server bundle", () => {
  it.skipIf(!fs.existsSync(BUNDLE_PATH))(
    "does not crash at module load (Zod init ordering guard)",
    { timeout: 15_000 },
    async () => {
      const stderrChunks: string[] = [];

      const proc = spawn("node", [BUNDLE_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (chunk) => stderrChunks.push(chunk));

      onTestFailed(() => {
        if (!proc.killed) proc.kill();
      });

      // Wait for the process to either crash (synchronous module load error)
      // or reach its first await point (starts listening on stdin).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolve(); // survived startup window
        }, STARTUP_WAIT_MS);

        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });

        proc.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (!proc.killed) proc.kill();

      const stderr = stderrChunks.join("");

      // The Zod crash always manifests as this specific TypeError on stderr.
      // Any other stderr output (DB path, no-DB message, Node version
      // mismatch, etc.) means Zod init succeeded.
      expect(stderr).not.toContain("undefined is not a constructor");
      expect(stderr).not.toContain("TypeError: ");
    },
  );
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Live workspace re-resolution
 *
 * The desktop app can swap its workspace folder in place (onboarding's folder
 * pick, and Settings → change folder) — `reinitialise()` in main.ts opens a new
 * cairn.db and rewrites workspace-config.json without relaunching anything.
 *
 * A long-lived MCP process that resolved its db path once at startup would then
 * keep reading (and writing .md files into) the ABANDONED workspace for the rest
 * of its life, with a restart as the only cure. These tests drive the real
 * bundled server over stdio and assert it follows the config.
 * ────────────────────────────────────────────────────────────────────────── */

/** Create a schema'd workspace folder with one workspace row + one project. */
function seedWorkspace(dir: string, label: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(path.join(dir, "cairn.db"));
  applySchema(db);
  createWorkspace(db, { id: `ws-${label}`, name: `WS ${label}` });
  createProject(db, { id: `proj-${label}`, workspaceId: `ws-${label}`, name: `Project ${label}` });
  db.close();
}

/** Minimal JSON-RPC-over-stdio client for the bundled server. */
function createClient(env: NodeJS.ProcessEnv) {
  const proc = spawn("node", [BUNDLE_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  }) as ChildProcessWithoutNullStreams;

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  const stderr: string[] = [];

  proc.stderr.on("data", (c: string) => stderr.push(c));
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("{")) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      } catch { /* partial / non-JSON */ }
    }
  });

  let nextId = 1;
  function send(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15_000);
      pending.set(id, (v) => { clearTimeout(timer); resolve(v as Record<string, unknown>); });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    proc,
    stderr: () => stderr.join(""),
    async init() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1" },
      });
    },
    /** Call a tool and return its parsed JSON payload. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await send("tools/call", { name, arguments: args });
      const result = res.result as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
    kill() { if (!proc.killed) proc.kill(); },
  };
}

describe.skipIf(!fs.existsSync(BUNDLE_PATH))("MCP server — workspace binding", () => {
  it(
    "CAIRN_DB_PATH pins the server to an explicit workspace",
    { timeout: 40_000 },
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mcp-env-"));
      const ws = path.join(tmp, "explicit");
      seedWorkspace(ws, "explicit");

      // A HOME with no Cairn config at all — without the env override the server
      // would find nothing and exit(1).
      const home = path.join(tmp, "home");
      fs.mkdirSync(home, { recursive: true });

      const client = createClient({
        ...process.env,
        HOME: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        CAIRN_DB_PATH: ws,
      });
      onTestFailed(() => client.kill());

      try {
        await client.init();
        const ctx = await client.call("get_cairn_context");
        const runtime = ctx.runtime as { dbPath: string; workspacePath: string };
        expect(runtime.dbPath).toBe(path.join(ws, "cairn.db"));
        expect(runtime.workspacePath).toBe(ws);
        expect((ctx.workspaces as Array<{ name: string }>).map((w) => w.name)).toEqual(["WS explicit"]);
      } finally {
        client.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    "follows the app to a new workspace folder without restarting",
    { timeout: 40_000 },
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mcp-switch-"));
      const first = path.join(tmp, "first");
      const second = path.join(tmp, "second");
      seedWorkspace(first, "first");
      seedWorkspace(second, "second");

      // Fake macOS/Linux/Windows app-support dir containing workspace-config.json,
      // exactly as electron/workspace-config.ts writes it.
      const home = path.join(tmp, "home");
      const configDirs = [
        path.join(home, "Library", "Application Support", "Cairn"),
        path.join(home, ".config", "Cairn"),
        path.join(home, "AppData", "Roaming", "Cairn"),
      ];
      for (const d of configDirs) fs.mkdirSync(d, { recursive: true });
      const writeConfig = (workspacePath: string) => {
        for (const d of configDirs) {
          fs.writeFileSync(path.join(d, "workspace-config.json"), JSON.stringify({ workspacePath }));
        }
      };
      writeConfig(first);

      const client = createClient({
        ...process.env,
        HOME: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        CAIRN_DB_PATH: "", // ensure no override leaks in from the dev environment
      });
      onTestFailed(() => client.kill());

      try {
        await client.init();

        const before = await client.call("get_cairn_context");
        expect((before.runtime as { workspacePath: string }).workspacePath).toBe(first);
        expect((before.projects as Array<{ name: string }>).map((p) => p.name)).toEqual(["Project first"]);

        // The app swaps workspace folders in place.
        writeConfig(second);
        // The re-resolve is throttled to 1 s so a burst of tool calls doesn't
        // stat the config repeatedly — wait past that window.
        await new Promise((r) => setTimeout(r, 1_400));

        const after = await client.call("get_cairn_context");
        expect(
          (after.runtime as { workspacePath: string }).workspacePath,
          "the MCP server kept reading the abandoned workspace after the app switched folders",
        ).toBe(second);
        expect((after.projects as Array<{ name: string }>).map((p) => p.name)).toEqual(["Project second"]);
        expect((after.workspaces as Array<{ name: string }>).map((w) => w.name)).toEqual(["WS second"]);
      } finally {
        client.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
