import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Readable } from "stream";

import { EmbeddingsAdapter, SUPPORTED_EMBEDDING_MODELS } from "./adapters/embeddings";
import { LlamaAdapter, SUPPORTED_LLM_MODELS } from "./adapters/llama";
import { migrateManifest } from "./model-manager";
import { EmbedRequest, EMBED_DIM } from "../embeddings/types";
import type { EmbedTask } from "../embeddings/types";

interface StdoutEvent {
  kind: "listening" | "ready" | "progress" | "error" | "log" |
    "llm:list" | "llm:status" | "embed:list" | "embed:status" |
    "binary-progress";
  port?: number;
  model?: string | null;
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  speed?: string;
  msg?: string;
  data?: unknown;
}

function emit(ev: StdoutEvent): void {
  process.stdout.write(JSON.stringify(ev) + "\n");
}

function parseArgs(argv: string[]): {
  port?: number;
  modelsDir: string;
  embeddingModelsDir: string;
  llamaModelsDir: string;
  llamaBinDir: string;
  dataDir: string;
} {
  let port: number | undefined;
  let modelsDir = path.join(os.homedir(), ".cache", "huggingface");
  let embeddingModelsDir = "";
  let llamaModelsDir = "";
  let llamaBinDir = "";
  let dataDir = "";
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (Number.isFinite(n) && n > 0) port = n;
    } else if (arg.startsWith("--models-dir=")) {
      modelsDir = arg.slice("--models-dir=".length);
    } else if (arg.startsWith("--embedding-models-dir=")) {
      embeddingModelsDir = arg.slice("--embedding-models-dir=".length);
    } else if (arg.startsWith("--llama-models-dir=")) {
      llamaModelsDir = arg.slice("--llama-models-dir=".length);
    } else if (arg.startsWith("--llama-bin-dir=")) {
      llamaBinDir = arg.slice("--llama-bin-dir=".length);
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    }
  }
  if (!embeddingModelsDir) embeddingModelsDir = path.join(modelsDir, "embedding-models");
  if (!llamaModelsDir) llamaModelsDir = path.join(modelsDir, "llama-models");
  if (!llamaBinDir) llamaBinDir = path.join(modelsDir, "llama-bin");
  return { port, modelsDir, embeddingModelsDir, llamaModelsDir, llamaBinDir, dataDir };
}

const MAX_BODY_BYTES = 10_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
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

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);

  const embeddingsAdapter = new EmbeddingsAdapter({
    modelsDir: args.embeddingModelsDir,
    binDir: "",
    defaultModelId: null,
    onProgress: (ev) => {
      if (ev.type === "load") {
        emit({
          kind: "progress",
          model: ev.modelId,
          status: ev.status,
          file: ev.file,
          progress: ev.progress,
          loaded: ev.loaded,
          total: ev.total,
        });
      } else if (ev.type === "ready") {
        emit({ kind: "ready", model: ev.modelId });
      }
    },
  });

  const llamaAdapter = new LlamaAdapter({
    modelsDir: args.llamaModelsDir,
    binDir: args.llamaBinDir,
    defaultModelId: null,
    onProgress: (ev) => {
      if (ev.type === "download") {
        emit({
          kind: "progress",
          model: ev.modelId,
          status: ev.status,
          progress: ev.progress,
        });
      }
    },
  });

  // Migrate legacy manifest entries — adds verifiedAt timestamps and verifies existing files.
  migrateManifest(
    path.join(args.embeddingModelsDir, "manifest.json"),
    Object.values(SUPPORTED_EMBEDDING_MODELS).map((m) => ({
      id: m.id,
      filePath: path.join(args.embeddingModelsDir, m.id, m.meta.filename),
      sha256: m.meta.sha256,
    })),
  );
  migrateManifest(
    path.join(args.llamaModelsDir, "manifest.json"),
    Object.values(SUPPORTED_LLM_MODELS).map((m) => ({
      id: m.id,
      filePath: path.join(args.llamaModelsDir, m.meta.filename),
      sha256: m.meta.sha256,
    })),
  );

  const server = http.createServer(async (req, res) => {
    if (!req.url) { sendJson(res, 400, { error: "no url" }); return; }

    // ── Unified health ──
    if (req.method === "GET" && req.url === "/health") {
      const [embedHealth, llmHealth] = await Promise.all([
        embeddingsAdapter.health(),
        llamaAdapter.health(),
      ]);
      sendJson(res, 200, {
        status: "ok",
        embeddings: { healthy: embedHealth.healthy, model: embedHealth.model, loaded: embedHealth.loaded },
        llm: { healthy: llmHealth.healthy, model: llmHealth.model, loaded: llmHealth.loaded, port: llamaAdapter.status().port },
      });
      return;
    }

    // ── Embeddings endpoints (in-process) ──
    if (req.method === "POST" && req.url === "/v1/embed") {
      try {
        const body = await readBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(body); }
        catch { throw new HttpError(400, "invalid JSON body"); }
        const reqParsed = EmbedRequest.safeParse(parsed);
        if (!reqParsed.success) throw new HttpError(400, `invalid embed request: ${reqParsed.error.message}`);
        const { texts, task, model } = reqParsed.data;
        const vectors = await embeddingsAdapter.embed(texts, task as EmbedTask, model);
        sendJson(res, 200, { vectors, dim: EMBED_DIM, model: model ?? embeddingsAdapter.getDefaultModelId() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ kind: "error", msg });
        const errAny = e as { statusCode?: number };
        const status = e instanceof HttpError ? e.status : errAny.statusCode ?? 500;
        sendJson(res, status, { error: msg });
      }
      return;
    }

    // ── Embeddings model management ──
    if (req.method === "GET" && req.url === "/v1/embeddings/models") {
      sendJson(res, 200, { models: embeddingsAdapter.listModels() });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings/models/install") {
      try {
        const body = await readBody(req);
        const { modelId } = JSON.parse(body) as { modelId: string };
        if (!modelId) { sendJson(res, 400, { error: "modelId is required" }); return; }
        await embeddingsAdapter.installModel(modelId);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings/models/remove") {
      try {
        const body = await readBody(req);
        const { modelId } = JSON.parse(body) as { modelId: string };
        if (!modelId) { sendJson(res, 400, { error: "modelId is required" }); return; }
        embeddingsAdapter.removeModel(modelId);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/embeddings/models/setDefault") {
      try {
        const body = await readBody(req);
        const { modelId } = JSON.parse(body) as { modelId: string };
        if (!modelId) { sendJson(res, 400, { error: "modelId is required" }); return; }
        embeddingsAdapter.setDefaultModelId(modelId);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // ── LLM model management ──
    if (req.method === "GET" && req.url === "/v1/llm/models") {
      sendJson(res, 200, { models: llamaAdapter.listModels() });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/models/install") {
      try {
        const body = await readBody(req);
        const { modelId, useMirror } = JSON.parse(body) as { modelId: string; useMirror?: boolean };
        await llamaAdapter.installModel(modelId, useMirror);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/models/remove") {
      try {
        const body = await readBody(req);
        const { modelId } = JSON.parse(body) as { modelId: string };
        llamaAdapter.removeModel(modelId);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/server/start") {
      try {
        const body = await readBody(req);
        const { modelId, contextLimit } = JSON.parse(body) as { modelId: string; contextLimit?: number };
        const { port } = await llamaAdapter.start(modelId, { contextLimit });
        sendJson(res, 200, { port });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/server/stop") {
      await llamaAdapter.stop();
      sendJson(res, 200, { success: true });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/llm/server/status") {
      sendJson(res, 200, {
        ...llamaAdapter.status(),
        defaultModelId: llamaAdapter.getDefaultModelId(),
        binaryInstalled: llamaAdapter.isBinaryInstalled(),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/binary/check-update") {
      try {
        const result = await llamaAdapter.checkBinaryUpdate();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/binary/install") {
      try {
        await llamaAdapter.installBinary((progress, speed, status, error) => {
          emit({ kind: "binary-progress", progress, speed, status, msg: error });
        });
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/models/clearInactive") {
      try {
        llamaAdapter.clearInactiveModels();
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/llm/server/setDefault") {
      try {
        const body = await readBody(req);
        const { modelId } = JSON.parse(body) as { modelId: string };
        llamaAdapter.setDefaultModelId(modelId);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // ── LLM chat completions proxy ──
    if (req.method === "POST" && req.url === "/v1/llm/chat/completions") {
      try {
        const body = await readBody(req);
        const llmPort = llamaAdapter.status().port;
        if (!llmPort) throw new HttpError(503, "LLM server is not running");
        // Proxy to llama-server's OpenAI-compatible endpoint
        const proxyRes = await fetch(`http://127.0.0.1:${llmPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        // Pipe the response directly to support streaming (stream: true)
        res.writeHead(proxyRes.status, { "Content-Type": "application/json" });
        if (proxyRes.body) {
          Readable.fromWeb(proxyRes.body).pipe(res);
        } else {
          res.end();
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  const listenPort = args.port ?? 0;
  server.listen(listenPort, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : listenPort;
    emit({ kind: "listening", port: actualPort });
    // Write port file for MCP server discovery (no Electron dependency needed)
    if (args.dataDir) {
      const portFile = path.join(args.dataDir, "runtime-port.json");
      try {
        fs.writeFileSync(portFile, JSON.stringify({ port: actualPort, pid: process.pid }), "utf8");
      } catch { /* ignore */ }
    }
  });

  const shutdown = (sig: string) => {
    emit({ kind: "log", msg: `received ${sig}, shutting down` });
    // Clean up port file
    if (args.dataDir) {
      const portFile = path.join(args.dataDir, "runtime-port.json");
      try { fs.unlinkSync(portFile); } catch { /* ignore */ }
    }
    Promise.allSettled([embeddingsAdapter.dispose(), llamaAdapter.dispose()])
      .finally(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  process.on("uncaughtException", (err) => {
    emit({ kind: "error", msg: `uncaughtException: ${err.stack ?? err.message ?? String(err)}` });
    try { console.error("[cairn-runtime] FATAL uncaughtException:", err); } catch { /* ignore */ }
    setTimeout(() => process.exit(1), 100).unref();
  });
  process.on("unhandledRejection", (reason) => {
    emit({
      kind: "error",
      msg: `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    });
    try { console.error("[cairn-runtime] FATAL unhandledRejection:", reason); } catch { /* ignore */ }
    setTimeout(() => process.exit(1), 100).unref();
  });
  run();
}

export { run };
