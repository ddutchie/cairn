import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execSync, type ChildProcess } from "child_process";

import type { EmbedTask } from "../embeddings/types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Finds the Cairn userData directory by scanning known locations.
 * Mirrors the logic in `mcp/db.ts` `findDbPath()` — checks Cairn, cairn, Electron.
 * Exported so Electron-agnostic modules (e.g. `lib/config-cache.ts`, which must
 * load in the standalone MCP runtime that has no working `electron` module) can
 * resolve userData without importing `electron`.
 */
export function findUserDataDir(): string | null {
  const home = os.homedir();
  const platform = process.platform;
  let base: string;
  if (platform === "win32") {
    base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  }
  for (const name of ["cairn", "Cairn", "Electron"]) {
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Reads the port file written by the unified runtime server.
 * Returns null if the runtime isn't running or the port file doesn't exist.
 */
export function findRuntimePort(): number | null {
  const userData = findUserDataDir();
  if (!userData) return null;
  const portFile = path.join(userData, "runtime-port.json");
  if (!fs.existsSync(portFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(portFile, "utf8")) as { port?: number; pid?: number };
    if (typeof data.port !== "number" || data.port <= 0) return null;
    // If we have a pid, check the process is still alive
    if (typeof data.pid === "number") {
      try {
        process.kill(data.pid, 0);
      } catch {
        return null;
      }
    }
    return data.port;
  } catch {
    return null;
  }
}

/**
 * Tries to locate and spawn the runtime server bundle when Cairn isn't running.
 * Only works in dev mode (needs `node` on PATH + the bundle in dist-electron/).
 * Returns the port if successful, null otherwise.
 */
let spawnedRuntime: ChildProcess | null = null;

async function trySpawnRuntime(): Promise<number | null> {
  if (spawnedRuntime && !spawnedRuntime.killed) {
    // Already spawned — check if port file appeared
    return findRuntimePort();
  }

  const userData = findUserDataDir();
  if (!userData) return null;

  // Look for the runtime server bundle
  const candidates = [
    path.join(__dirname, "..", "dist-electron", "runtime-server.bundle.js"),
    path.join(__dirname, "runtime-server.bundle.js"),
    path.resolve(__dirname, "..", "..", "dist-electron", "runtime-server.bundle.js"),
  ];
  const bundle = candidates.find((c) => fs.existsSync(c));
  if (!bundle) return null;

  // Need `node` on PATH
  let nodeBin: string | null = null;
  try {
    nodeBin = execSync(
      process.platform === "win32" ? "where node" : "which node",
    )
      .toString()
      .trim()
      .split(/\r?\n/)[0];
  } catch { /* node not on PATH */ }
  if (!nodeBin || !fs.existsSync(nodeBin)) return null;

  const embeddingModelsDir = path.join(userData, "embedding-models");
  const llamaModelsDir = path.join(userData, "llama-models");
  const llamaBinDir = path.join(userData, "llama-bin");

  spawnedRuntime = spawn(
    nodeBin,
    [bundle, `--data-dir=${userData}`, `--embedding-models-dir=${embeddingModelsDir}`, `--llama-models-dir=${llamaModelsDir}`, `--llama-bin-dir=${llamaBinDir}`],
    { stdio: ["ignore", "pipe", "pipe"], detached: false, env: { ...process.env, TRANSFORMERS_CACHE: embeddingModelsDir, ELECTRON_RUN_AS_NODE: "1" } },
  );

  spawnedRuntime.stdout?.on("data", (d: Buffer) => {
    console.log("[spawned-runtime stdout]:", d.toString("utf8").trim());
  });
  spawnedRuntime.stderr?.on("data", (d: Buffer) => {
    console.error("[spawned-runtime stderr]:", d.toString("utf8").trim());
  });

  spawnedRuntime.on("exit", () => {
    spawnedRuntime = null;
  });

  // Wait up to 10s for the port file to appear
  const portFile = path.join(userData, "runtime-port.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = findRuntimePort();
      if (port) return port;
    }
    await sleep(200);
  }
  return null;
}

/**
 * Returns the runtime port, spawning the server if needed.
 * 1. Check port file (Cairn running)
 * 2. Try to spawn the runtime bundle ourselves (dev mode)
 */
async function ensureRuntimePort(): Promise<number | null> {
  // Fast path — Cairn is running, port file exists
  const existing = findRuntimePort();
  if (existing) return existing;

  // Slow path — try to spawn the runtime ourselves (dev only)
  return trySpawnRuntime();
}

/**
 * Embeds text via the unified runtime's HTTP API.
 * Used by the standalone MCP server (no Electron dependency).
 *
 * Returns null if the runtime can't be reached (embeddings not available).
 * The caller should surface a graceful error to the user.
 */
export async function embedViaRuntime(
  texts: string[],
  task: EmbedTask,
  model?: string,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const port = await ensureRuntimePort();
  if (!port) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, task, model }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { vectors: number[][]; dim: number };
    return data.vectors;
  } catch {
    return null;
  }
}

/**
 * Clean up any spawned runtime process (called on MCP server shutdown).
 */
export function disposeSpawnedRuntime(): void {
  if (spawnedRuntime) {
    try { spawnedRuntime.kill("SIGTERM"); } catch { /* ignore */ }
    spawnedRuntime = null;
  }
}
