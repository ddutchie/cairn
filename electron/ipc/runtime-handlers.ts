import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as runtime from "../runtime/client";
import { BrowserWindow } from "electron";

let progressForwarderSetUp = false;

function ensureProgressForwarder(getWin: () => BrowserWindow | null): void {
  if (progressForwarderSetUp) return;
  progressForwarderSetUp = true;
  runtime.onProgress((ev) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (ev.kind === "progress") {
      win.webContents.send("runtime:download-progress", {
        modelId: ev.modelId,
        status: ev.status,
        file: ev.file,
        progress: ev.progress,
        loaded: ev.loaded,
        total: ev.total,
      });
    } else if (ev.kind === "ready") {
      win.webContents.send("runtime:download-progress", {
        modelId: ev.modelId,
        status: "ready",
        progress: 100,
      });
    } else if (ev.kind === "binary-progress") {
      win.webContents.send("runtime:binary-progress", {
        progress: ev.progress,
        speed: ev.speed,
        status: ev.status,
        error: ev.error,
      });
    }
  });
}

export function registerRuntimeHandlers(ctx: DbContext): void {
  ensureProgressForwarder(ctx.getWin);
  // ── Runtime health & lifecycle ─────────────────────────────
  registerIpcHandle("runtime:status", () => handle(async () => {
    return runtime.getRuntimeStatus();
  }));

  registerIpcHandle("runtime:stop", () => handle(async () => {
    await runtime.stopRuntime({ force: true });
    return { ok: true };
  }));

  // ── Embedding model management (via unified runtime) ────────
  registerIpcHandle("runtime:embeddings:status", () => handle(() => {
    return runtime.getEmbeddingsStatus();
  }));

  registerIpcHandle("runtime:embeddings:ensureStarted", () => handle(async () => {
    await runtime.ensureStarted();
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:models", () => handle(async () => {
    return { models: await runtime.listEmbeddingModels() };
  }));

  registerIpcHandle("runtime:embeddings:install", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.installEmbeddingModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:remove", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.removeEmbeddingModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:embeddings:setDefault", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.setDefaultEmbeddingModel(modelId);
    return { ok: true };
  }));

  // ── LLM model management (via unified runtime) ─────────────
  registerIpcHandle("runtime:llm:models", () => handle(async () => {
    return { models: await runtime.listLLMModels() };
  }));

  registerIpcHandle("runtime:llm:install", (_e, { modelId, useMirror }: { modelId: string; useMirror?: boolean }) => handle(async () => {
    await runtime.installLLMModel(modelId, useMirror);
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:remove", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.removeLLMModel(modelId);
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:start", (_e, { modelId, contextLimit }: { modelId: string; contextLimit?: number }) => handle(async () => {
    const port = await runtime.startLLMServer(modelId, contextLimit);
    return { port };
  }));

  registerIpcHandle("runtime:llm:stop", () => handle(async () => {
    await runtime.stopLLMServer();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:status", () => handle(async () => {
    return runtime.getLLMStatus();
  }));

  registerIpcHandle("runtime:llm:checkUpdate", () => handle(async () => {
    return runtime.checkLLMBinaryUpdate();
  }));

  registerIpcHandle("runtime:llm:binary:install", () => handle(async () => {
    await runtime.installLLMBinary();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:clearInactive", () => handle(async () => {
    await runtime.clearInactiveLLMModels();
    return { ok: true };
  }));

  registerIpcHandle("runtime:llm:server:setDefault", (_e, { modelId }: { modelId: string }) => handle(async () => {
    await runtime.setDefaultLLMModel(modelId);
    return { ok: true };
  }));
}
