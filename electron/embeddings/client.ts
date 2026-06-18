import { app } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

import { findFreePort } from "./port";
import { NOMIC_MODEL_ID, NOMIC_DIM } from "./types";
import type { NomicTask, EmbeddingsStatus } from "./types";
import * as manifest from "./manifest";

const MODELS_DIR = manifest.MODELS_DIR;

const LOCAL_BIN_DIR = path.join(app.getPath("userData"), "embeddings-bin");
const LOCAL_BIN_PATH = path.join(
  LOCAL_BIN_DIR,
  process.platform === "win32" ? "cairn-embeddings.exe" : "cairn-embeddings",
);

function resolveDevServerScript(): string | null {
  const candidates = [
    path.join(__dirname, "embeddings-server.bundle.js"),
    path.join(__dirname, "..", "dist-electron", "embeddings-server.bundle.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveBinaryPath(): string | null {
  if (fs.existsSync(LOCAL_BIN_PATH)) return LOCAL_BIN_PATH;
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist-embeddings",
      process.platform === "win32" ? "cairn-embeddings.exe" : "cairn-embeddings",
    );
    if (fs.existsSync(unpacked)) return unpacked;
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
      const nodeBin = require("child_process")
        .execSync(process.platform === "win32" ? "where node" : "which node")
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

export function getDefaultModelId(): string {
  return manifest.readDefaultModelId() ?? NOMIC_MODEL_ID;
}

interface StdoutEvent {
  kind: "listening" | "ready" | "progress" | "error" | "log";
  port?: number;
  model?: string | null;
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
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
    | { kind: "ready"; modelId: string },
) => void;

let workerProcess: ChildProcess | null = null;
let workerPort: number | null = null;
let workerModel: string | null = null;
let isReady = false;
let bootError = "";
const progressListeners = new Set<ProgressListener>();

let startPromise: Promise<number> | null = null;
let inFlightEmbeds = 0;
let lastStopTrace = "";

let reindexInProgress = false;
let recomputeInProgress = false;
let lastReindexDone = 0;
let lastReindexTotal = 0;
let lastRecomputeDone = 0;
let lastRecomputeTotal = 0;

export function setReindexInProgress(v: boolean): void {
  reindexInProgress = v;
  if (v) {
    lastReindexDone = 0;
    lastReindexTotal = 0;
  }
}
export function setRecomputeInProgress(v: boolean): void {
  recomputeInProgress = v;
  if (v) {
    lastRecomputeDone = 0;
    lastRecomputeTotal = 0;
  }
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
  if (ev.kind !== "progress" && ev.kind !== "ready") return;
  const modelId = ev.model ?? workerModel ?? NOMIC_MODEL_ID;
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
    console.log("[embeddings-worker stdout]:", trimmed);
    return;
  }
  switch (ev.kind) {
    case "listening":
      if (typeof ev.port === "number") workerPort = ev.port;
      break;
    case "ready":
      isReady = true;
      if (ev.model) workerModel = ev.model;
      break;
    case "progress":
      emitProgress(ev);
      break;
    case "error":
      bootError = ev.msg ?? "unknown error";
      break;
    case "log":
      console.log("[embeddings-worker]:", ev.msg ?? "");
      break;
  }
}

async function spawnWorker(model: string): Promise<number> {
  const port = await findFreePort();
  const binaryPath = resolveBinaryPath();
  if (!binaryPath) {
    throw new Error(
      "Embeddings worker binary not found. Run `node scripts/build-embeddings-binary.js` or run in dev mode after `npm run compile`.",
    );
  }
  const isScript = isScriptPath(binaryPath);
  const nodeRunner = isScript ? resolveNodeRunner() : null;
  const args: string[] = [];
  if (isScript) {
    args.push("--max-old-space-size=4096");
    if (nodeRunner) args.push(binaryPath);
    else args.push(binaryPath);
  }
  args.push(`--port=${port}`, `--cache-dir=${MODELS_DIR}`, `--model=${model}`);

  const cmd = nodeRunner ?? (isScript ? process.execPath : binaryPath);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TRANSFORMERS_CACHE: MODELS_DIR,
  };
  if (isScript && !nodeRunner) childEnv.ELECTRON_RUN_AS_NODE = "1";
  if (nodeRunner) console.log(`[embeddings-client] spawning worker via Node: ${nodeRunner}`);
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
    console.error("[embeddings-worker stderr]:", data.trim());
  });

  child.on("exit", (code, signal) => {
    console.log(
      `[embeddings-client] worker exited code=${code} signal=${signal} ` +
        `inFlight=${inFlightEmbeds} ready=${isReady} bootError="${bootError}"`,
    );
    if (!signal && code !== 0) {
      console.log("[embeddings-client] last 1KB stderr:\n" + stderrBuf.slice(-1024));
    }
    workerProcess = null;
    workerPort = null;
    isReady = false;
    startPromise = null;
  });

  workerProcess = child;
  workerModel = model;
  return port;
}

async function checkHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function ensureStarted(): Promise<number> {
  if (startPromise) return startPromise;
  if (workerProcess && workerPort) {
    for (let i = 0; i < 5; i++) {
      if (await checkHealth(workerPort, 1500)) return workerPort;
      if (!workerProcess) break;
    }
    console.warn(
      "[embeddings-client] worker alive but unhealthy, restarting. inFlightEmbeds=" +
        inFlightEmbeds +
        " lastStopTrace:\n" +
        lastStopTrace,
    );
    await stopWorker();
  }
  startPromise = (async () => {
    const port = await spawnWorker(getDefaultModelId());
    for (let i = 0; i < 600; i++) {
      if (workerProcess?.killed || workerProcess?.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
      if (await checkHealth(port)) {
        isReady = true;
        return port;
      }
    }
    await stopWorker();
    throw new Error(
      `embeddings worker failed to start within 120s.${bootError ? ` Last error: ${bootError}` : ""}`,
    );
  })().catch((e) => {
    startPromise = null;
    throw e;
  });
  return startPromise;
}

export async function stopWorker(opts?: { force?: boolean }): Promise<void> {
  if (!workerProcess) return;
  if (!opts?.force && inFlightEmbeds > 0) {
    console.warn(
      `[embeddings-client] stopWorker suppressed — ${inFlightEmbeds} in-flight embed(s). Stack:\n` +
        new Error().stack,
    );
    return;
  }
  lastStopTrace = new Error().stack ?? "(no stack)";
  const proc = workerProcess;
  workerProcess = null;
  workerPort = null;
  isReady = false;
  startPromise = null;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      resolve();
    }, 2000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function dispose(): Promise<void> {
  await stopWorker({ force: true });
  progressListeners.clear();
}

export function onProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export async function embed(
  texts: string[],
  task: NomicTask,
  model = getDefaultModelId(),
): Promise<number[][]> {
  if (texts.length === 0) return [];
  inFlightEmbeds++;
  try {
    const port = await ensureStarted();
    const body = JSON.stringify({ texts, task, model });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/embed`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 600_000,
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("embed request timed out after 600s"));
      });
      req.write(body);
      req.end();
    });
    if (res.status !== 200) {
      throw new Error(`embed http ${res.status}: ${res.body}`);
    }
    const parsed = JSON.parse(res.body) as {
      vectors: number[][];
      dim: number;
      model: string;
    };
    if (parsed.dim !== NOMIC_DIM) {
      throw new Error(`embed: expected dim ${NOMIC_DIM}, got ${parsed.dim}`);
    }
    return parsed.vectors;
  } finally {
    inFlightEmbeds--;
  }
}

export function getStatus(): EmbeddingsStatus {
  const running = workerProcess !== null && !workerProcess.killed && workerProcess.exitCode === null;
  return {
    running,
    port: running ? workerPort : null,
    activeModelId: running ? workerModel : null,
    defaultModelId: getDefaultModelId(),
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
  return isReady && workerProcess !== null && workerPort !== null;
}

export const MODELS_DIRECTORY = MODELS_DIR;
export const BINARY_DIRECTORY = LOCAL_BIN_DIR;
