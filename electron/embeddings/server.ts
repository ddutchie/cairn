import * as http from "http";
import * as path from "path";
import * as os from "os";

import { embed, loadPipeline, setCacheDir, isLoaded, loadedModelId, type EmbedProgress } from "./pipeline";
import { EmbedRequest, NOMIC_MODEL_ID, NOMIC_DIM } from "./types";

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

function emit(ev: StdoutEvent): void {
  process.stdout.write(JSON.stringify(ev) + "\n");
}

function parseArgs(argv: string[]): { port?: number; cacheDir: string; model: string } {
  let port: number | undefined;
  let cacheDir = path.join(os.homedir(), ".cache", "huggingface");
  let model = NOMIC_MODEL_ID;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (Number.isFinite(n) && n > 0) port = n;
    } else if (arg.startsWith("--cache-dir=")) {
      cacheDir = arg.slice("--cache-dir=".length);
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }
  return { port, cacheDir, model };
}

const MAX_EMBED_BODY_BYTES = 1_000_000; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_EMBED_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function ensurePipelineLoaded(model: string): Promise<void> {
  if (isLoaded() && loadedModelId() === model) return;
  emit({ kind: "log", msg: `loading pipeline: ${model}` });
  await loadPipeline(model, (p: EmbedProgress) => {
    emit({
      kind: "progress",
      status: p.status,
      file: p.file,
      progress: p.progress,
      loaded: p.loaded,
      total: p.total,
      model,
    });
  });
  emit({ kind: "ready", model });
}

let pipelineLoadPromise: Promise<void> | null = null;
function loadOnce(model: string): Promise<void> {
  if (!pipelineLoadPromise) {
    pipelineLoadPromise = ensurePipelineLoaded(model).catch((e) => {
      emit({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
      pipelineLoadPromise = null;
      throw e;
    });
  }
  return pipelineLoadPromise;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function handleEmbed(
  body: string,
  res: http.ServerResponse,
  configuredModel: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const reqParsed = EmbedRequest.safeParse({
    ...(parsed as Record<string, unknown>),
    model: (parsed as { model?: unknown })?.model ?? configuredModel,
  });
  if (!reqParsed.success) throw new HttpError(400, `invalid embed request: ${reqParsed.error.message}`);
  const req = reqParsed.data;
  await loadOnce(req.model ?? configuredModel);
  const vectors = await embed(req.texts, req.task, req.model ?? configuredModel);
  sendJson(res, 200, { vectors, dim: NOMIC_DIM, model: req.model ?? configuredModel });
}

function buildServer(configuredModel: string): http.Server {
  return http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "no url" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        status: "ok",
        model: loadedModelId(),
        loaded: isLoaded(),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/embed") {
      try {
        const body = await readBody(req);
        await handleEmbed(body, res, configuredModel);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ kind: "error", msg });
        const errAny = e as { statusCode?: number };
        const status = e instanceof HttpError ? e.status : errAny.statusCode ?? 500;
        sendJson(res, status, { error: msg });
      }
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
}

function run(): void {
  const { port: fixedPort, cacheDir, model } = parseArgs(process.argv);
  setCacheDir(cacheDir);

  const server = buildServer(model);
  const listenPort = fixedPort ?? 0;
  server.listen(listenPort, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : listenPort;
    emit({ kind: "listening", port: actualPort });
  });

  const shutdown = (sig: string) => {
    emit({ kind: "log", msg: `received ${sig}, shutting down` });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  process.on("uncaughtException", (err) => {
    emit({ kind: "error", msg: `uncaughtException: ${err.stack ?? err.message ?? String(err)}` });
    try { console.error("[embeddings-server] FATAL uncaughtException:", err); } catch { /* ignore */ }
    setTimeout(() => process.exit(1), 100).unref();
  });
  process.on("unhandledRejection", (reason) => {
    emit({
      kind: "error",
      msg: `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    });
    try { console.error("[embeddings-server] FATAL unhandledRejection:", reason); } catch { /* ignore */ }
    setTimeout(() => process.exit(1), 100).unref();
  });
  run();
}

export { run };
