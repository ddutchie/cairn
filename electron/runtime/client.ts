import { app } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { spawn, type ChildProcess, execSync } from "child_process";

import { findFreePort } from "../embeddings/port";
import { EMBED_MODEL_ID, EMBED_DIM } from "../embeddings/types";
import type { EmbedTask, EmbeddingsStatus } from "../embeddings/types";
import type { AdapterModelEntry } from "./adapters/types";

const USER_DATA = app.getPath("userData");
const EMBEDDING_MODELS_DIR = path.join(USER_DATA, "embedding-models");
const LLM_MODELS_DIR = path.join(USER_DATA, "llama-models");
const LLM_BIN_DIR = path.join(USER_DATA, "llama-bin");
const LOCAL_BIN_DIR = path.join(USER_DATA, "runtime-bin");
const LOCAL_BIN_PATH = path.join(
  LOCAL_BIN_DIR,
  process.platform === "win32" ? "cairn-runtime.exe" : "cairn-runtime",
);

function resolveDevServerScript(): string | null {
  const candidates = [
    path.join(__dirname, "runtime-server.bundle.js"),
    path.join(__dirname, "..", "dist-electron", "runtime-server.bundle.js"),
    // In packaged apps the bundle is inside app.asar, but Electron can read it
    // directly when spawned with ELECTRON_RUN_AS_NODE.
    path.join(app.getAppPath(), "dist-electron", "runtime-server.bundle.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveBinaryPath(): string | null {
  if (fs.existsSync(LOCAL_BIN_PATH)) return LOCAL_BIN_PATH;
  if (app.isPackaged) {
    // First, check for a compiled native binary in unpacked resources
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist-runtime",
      process.platform === "win32" ? "cairn-runtime.exe" : "cairn-runtime",
    );
    if (fs.existsSync(unpacked)) return unpacked;
    // Fall back to the JS bundle — works with ELECTRON_RUN_AS_NODE=1
    const script = resolveDevServerScript();
    if (script) return script;
  }
  if (!app.isPackaged) {
    const script = resolveDevServerScript();
    if (script) return script;
  }
  return null;
}

function resolveNodeRunner(): string | null {
  if (!app.isPackaged) {
    try {
      const nodeBin = execSync(
        process.platform === "win32" ? "where node" : "which node",
      )
        .toString()
        .trim()
        .split(/\r?\n/)[0];
      if (nodeBin && fs.existsSync(nodeBin)) return nodeBin;
    } catch {
      // ignore — not on PATH
    }
  }
  return null;
}

function isScriptPath(p: string): boolean {
  return p.endsWith(".js");
}

interface StdoutEvent {
  kind: "listening" | "ready" | "progress" | "error" | "log" | "binary-progress";
  port?: number;
  model?: string | null;
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  speed?: string;
  msg?: string;
}

type ProgressListener = (
  ev:
    | {
        kind: "progress";
        modelId: string;
        status: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      }
    | { kind: "ready"; modelId: string }
    | { kind: "binary-progress"; progress: number; speed: string; status: string; error?: string },
) => void;

let runtimeProcess: ChildProcess | null = null;
let runtimePort: number | null = null;
let isReady = false;
let bootError = "";
const progressListeners = new Set<ProgressListener>();

let startPromise: Promise<number> | null = null;
let inFlightRequests = 0;

// Embeddings-specific tracking (for status API)
let reindexInProgress = false;
let recomputeInProgress = false;
let lastReindexDone = 0;
let lastReindexTotal = 0;
let lastRecomputeDone = 0;
let lastRecomputeTotal = 0;

export function setReindexInProgress(v: boolean): void {
  reindexInProgress = v;
  if (v) { lastReindexDone = 0; lastReindexTotal = 0; }
}
export function setRecomputeInProgress(v: boolean): void {
  recomputeInProgress = v;
  if (v) { lastRecomputeDone = 0; lastRecomputeTotal = 0; }
}
export function setLastReindexProgress(done: number, total: number): void {
  lastReindexDone = done;
  lastReindexTotal = total;
}
export function setLastRecomputeProgress(done: number, total: number): void {
  lastRecomputeDone = done;
  lastRecomputeTotal = total;
}

function emitProgress(ev: StdoutEvent): void {
  if (ev.kind === "binary-progress") {
    for (const l of progressListeners) {
      l({
        kind: "binary-progress",
        progress: ev.progress ?? 0,
        speed: ev.speed ?? "0 KB/s",
        status: ev.status ?? "unknown",
        error: ev.msg,
      });
    }
    return;
  }
  if (ev.kind !== "progress" && ev.kind !== "ready") return;
  const modelId = ev.model ?? EMBED_MODEL_ID;
  for (const l of progressListeners) {
    if (ev.kind === "ready") {
      l({ kind: "ready", modelId });
    } else {
      l({
        kind: "progress",
        modelId,
        status: ev.status ?? "unknown",
        file: ev.file,
        progress: ev.progress,
        loaded: ev.loaded,
        total: ev.total,
      });
    }
  }
}

function parseStdoutLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: StdoutEvent;
  try {
    ev = JSON.parse(trimmed) as StdoutEvent;
  } catch {
    console.log("[runtime stdout]:", trimmed);
    return;
  }
  switch (ev.kind) {
    case "listening":
      if (typeof ev.port === "number") runtimePort = ev.port;
      break;
    case "ready":
      isReady = true;
      bootError = "";
      if (ev.model) emitProgress(ev);
      break;
    case "progress":
      emitProgress(ev);
      break;
    case "binary-progress":
      emitProgress(ev);
      break;
    case "error":
      bootError = ev.msg ?? "unknown error";
      break;
    case "log":
      console.log("[runtime]:", ev.msg ?? "");
      break;
  }
}

async function spawnRuntime(): Promise<number> {
  const port = await findFreePort();
  const binaryPath = resolveBinaryPath();
  if (!binaryPath) {
    throw new Error(
      "Runtime binary not found. Run `npm run compile` or run in dev mode.",
    );
  }
  const isScript = isScriptPath(binaryPath);
  const nodeRunner = isScript ? resolveNodeRunner() : null;
  const args: string[] = [];
  if (isScript) {
    args.push("--max-old-space-size=512");
    args.push(binaryPath);
  }
  args.push(
    `--port=${port}`,
    `--embedding-models-dir=${EMBEDDING_MODELS_DIR}`,
    `--llama-models-dir=${LLM_MODELS_DIR}`,
    `--llama-bin-dir=${LLM_BIN_DIR}`,
    `--data-dir=${USER_DATA}`,
  );

  const cmd = nodeRunner ?? (isScript ? process.execPath : binaryPath);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TRANSFORMERS_CACHE: EMBEDDING_MODELS_DIR,
  };
  if (isScript && !nodeRunner) childEnv.ELECTRON_RUN_AS_NODE = "1";

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: childEnv,
  });

  child.stdout?.setEncoding("utf8");
  let stdoutBuf = "";
  child.stdout?.on("data", (data: string) => {
    stdoutBuf += data;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) parseStdoutLine(line);
  });

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    stderrBuf += data;
    console.error("[runtime stderr]:", data.trim());
  });

  child.on("exit", (code, signal) => {
    console.log(
      `[runtime-client] process exited code=${code} signal=${signal} ` +
        `inFlight=${inFlightRequests} ready=${isReady} bootError="${bootError}"`,
    );
    if (!signal && code !== 0) {
      console.log("[runtime-client] last 1KB stderr:\n" + stderrBuf.slice(-1024));
    }
    runtimeProcess = null;
    runtimePort = null;
    isReady = false;
    startPromise = null;
  });

  runtimeProcess = child;
  return port;
}

async function checkHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

export async function ensureStarted(): Promise<number> {
  if (startPromise) return startPromise;
  if (runtimeProcess && runtimePort) {
    for (let i = 0; i < 5; i++) {
      if (await checkHealth(runtimePort, 1500)) return runtimePort;
      if (!runtimeProcess) break;
    }
    await stopRuntime({ force: true });
  }
  startPromise = (async () => {
    const port = await spawnRuntime();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (runtimeProcess?.killed || runtimeProcess?.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
      if (await checkHealth(port)) {
        isReady = true;
        bootError = "";
        return port;
      }
    }
    await stopRuntime();
    throw new Error(
      `runtime failed to start within 120s.${bootError ? ` Last error: ${bootError}` : ""}`,
    );
  })().catch((e) => {
    startPromise = null;
    throw e;
  });
  return startPromise;
}

export async function stopRuntime(opts?: { force?: boolean }): Promise<void> {
  if (!runtimeProcess) return;
  if (!opts?.force && inFlightRequests > 0) return;
  const proc = runtimeProcess;
  runtimeProcess = null;
  runtimePort = null;
  isReady = false;
  startPromise = null;
  try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      resolve();
    }, 2000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

export async function dispose(): Promise<void> {
  await stopRuntime({ force: true });
  progressListeners.clear();
}

export function onProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

// ── HTTP helpers ──────────────────────────────────────────────

async function runtimeFetch<T>(path: string, opts?: { method?: string; body?: unknown; timeout?: number }): Promise<T> {
  const port = await ensureStarted();
  inFlightRequests++;
  try {
    const url = `http://127.0.0.1:${port}${path}`;
    const method = opts?.method ?? "GET";
    const body = opts?.body ? JSON.stringify(opts.body) : undefined;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(url, {
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : undefined,
        timeout: opts?.timeout ?? 600_000,
      }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => {
          resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("runtime request timed out")); });
      if (body) req.write(body);
      req.end();
    });
    if (res.status !== 200) {
      throw new Error(`runtime ${path} http ${res.status}: ${res.body}`);
    }
    return JSON.parse(res.body) as T;
  } finally {
    inFlightRequests--;
  }
}

// ── Embeddings API ────────────────────────────────────────────

export async function embed(
  texts: string[],
  task: EmbedTask,
  model = EMBED_MODEL_ID,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await runtimeFetch<{ vectors: number[][]; dim: number; model: string }>(
    "/v1/embed",
    { method: "POST", body: { texts, task, model } },
  );
  if (res.dim !== EMBED_DIM) {
    throw new Error(`embed: expected dim ${EMBED_DIM}, got ${res.dim}`);
  }
  return res.vectors;
}

export async function listEmbeddingModels(): Promise<AdapterModelEntry[]> {
  const res = await runtimeFetch<{ models: AdapterModelEntry[] }>("/v1/embeddings/models");
  return res.models;
}

export async function installEmbeddingModel(modelId: string): Promise<void> {
  await runtimeFetch("/v1/embeddings/models/install", { method: "POST", body: { modelId } });
}

export async function removeEmbeddingModel(modelId: string): Promise<void> {
  await runtimeFetch("/v1/embeddings/models/remove", { method: "POST", body: { modelId } });
}

export async function setDefaultEmbeddingModel(modelId: string): Promise<void> {
  await runtimeFetch("/v1/embeddings/models/setDefault", { method: "POST", body: { modelId } });
}

// ── LLM API ───────────────────────────────────────────────────

export async function listLLMModels(): Promise<AdapterModelEntry[]> {
  const res = await runtimeFetch<{ models: AdapterModelEntry[] }>("/v1/llm/models");
  return res.models;
}

export async function installLLMModel(modelId: string, useMirror?: boolean): Promise<void> {
  await runtimeFetch("/v1/llm/models/install", { method: "POST", body: { modelId, useMirror } });
}

export async function removeLLMModel(modelId: string): Promise<void> {
  await runtimeFetch("/v1/llm/models/remove", { method: "POST", body: { modelId } });
}

export async function startLLMServer(modelId: string, contextLimit?: number): Promise<number> {
  const res = await runtimeFetch<{ port: number }>("/v1/llm/server/start", {
    method: "POST",
    body: { modelId, contextLimit },
    timeout: 120_000,
  });
  return res.port;
}

export async function stopLLMServer(): Promise<void> {
  await runtimeFetch("/v1/llm/server/stop", { method: "POST" });
}

export async function getLLMStatus(): Promise<{
  running: boolean;
  port: number | null;
  activeModelId: string | null;
  defaultModelId: string | null;
  binaryInstalled: boolean;
}> {
  const res = await runtimeFetch<{ kind: string; running: boolean; port: number | null; model: string | null; error: string | null; defaultModelId: string | null; binaryInstalled: boolean }>(
    "/v1/llm/server/status",
  );
  return {
    running: res.running,
    port: res.port,
    activeModelId: res.model,
    defaultModelId: res.defaultModelId ?? null,
    binaryInstalled: res.binaryInstalled ?? false,
  };
}

export async function checkLLMBinaryUpdate(): Promise<{
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
}> {
  return runtimeFetch("/v1/llm/binary/check-update", { method: "POST" });
}

export async function installLLMBinary(): Promise<void> {
  await runtimeFetch("/v1/llm/binary/install", { method: "POST", timeout: 600_000 });
}

export async function clearInactiveLLMModels(): Promise<void> {
  await runtimeFetch("/v1/llm/models/clearInactive", { method: "POST" });
}

export async function setDefaultLLMModel(modelId: string): Promise<void> {
  await runtimeFetch("/v1/llm/server/setDefault", { method: "POST", body: { modelId } });
}

// ── Unified status ────────────────────────────────────────────

export async function getRuntimeStatus(): Promise<{
  embeddings: { healthy: boolean; model: string | null; loaded: boolean };
  llm: { healthy: boolean; model: string | null; loaded: boolean; port: number | null };
}> {
  return runtimeFetch("/health");
}

export function getEmbeddingsStatus(): EmbeddingsStatus {
  const running = runtimeProcess !== null && !runtimeProcess.killed && runtimeProcess.exitCode === null;
  return {
    running,
    port: running ? runtimePort : null,
    activeModelId: null,
    defaultModelId: EMBED_MODEL_ID,
    installed: resolveBinaryPath() !== null,
    error: bootError || null,
    reindexInProgress,
    recomputeInProgress,
    lastReindexDone,
    lastReindexTotal,
    lastRecomputeDone,
    lastRecomputeTotal,
  };
}

export function isReadyForInference(): boolean {
  return isReady && runtimeProcess !== null && runtimePort !== null;
}

export function stopRuntimeSync(): void {
  if (runtimeProcess) {
    try { runtimeProcess.kill("SIGKILL"); } catch { /* ignore */ }
    runtimeProcess = null;
    runtimePort = null;
    isReady = false;
    startPromise = null;
  }
}

export const MODELS_DIRECTORY = EMBEDDING_MODELS_DIR;
export const BINARY_DIRECTORY = LOCAL_BIN_DIR;
