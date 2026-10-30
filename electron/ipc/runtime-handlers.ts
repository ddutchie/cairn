import { registerContractHandle, sendIpcEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as runtime from "../runtime/client";
import { BrowserWindow } from "electron";
import { errMsg } from "../host-shared/errors";
import { ENGINE_COMMANDS, executeEngineCommand, previewEnginePrompt } from "./engine-commands";

let progressForwarderSetUp = false;

function ensureProgressForwarder(getWin: () => BrowserWindow | null): void {
  if (progressForwarderSetUp) return;
  progressForwarderSetUp = true;
  runtime.onProgress((ev) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (ev.kind === "progress") {
      sendIpcEvent(win.webContents, "runtime:download-progress", {
        modelId: ev.modelId,
        status: ev.status,
        file: ev.file,
        progress: ev.progress,
        loaded: ev.loaded,
        total: ev.total,
      });
    } else if (ev.kind === "ready") {
      sendIpcEvent(win.webContents, "runtime:download-progress", {
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
  // ── Command execution (engine commands runtime) ────────────────────────
  // List registry commands (name + description) so host UIs can render their
  // palettes from the same namespace plugins register into.
  registerContractHandle("commands:list", () => handle(async () => ENGINE_COMMANDS.map((c) => ({ ...c }))));

  // Generic executor for slash commands (/plan, /compact, /goal, …); returns {kind, text}.
  registerContractHandle("commands:execute", (_e, req) => handle(async () => executeEngineCommand(ctx, req)));

  // ── Runtime health & lifecycle ─────────────────────────────
  registerContractHandle("runtime:status", () => handle(async () => {
    return runtime.getRuntimeStatus();
  }));

  registerContractHandle("runtime:stop", () => handle(async () => {
    await runtime.stopRuntime({ force: true });
    return { ok: true as const };
  }));

  // ── System-prompt introspection ──────────────────────────────────────
  registerContractHandle("runtime:systemPrompt:preview", (_e, req) => handle(async () => previewEnginePrompt(ctx, req?.cwd ?? "")));

  // ── Coding-agent prompt preview ──────────────────────────────────────
  // The coding loop's system prompt is NOT a engine section — it is the plain
  // string built by buildAgentSystemPrompt (identity + Mandatory Cairn
  // workflow: board tracking, PRD checklists, session summaries). The 3.0
  // engine cutover moved it out of the assembled engine prompt, so the preview
  // above no longer shows it. Return it here so Settings can display it.
  registerContractHandle("runtime:codingPrompt:preview", (_e, req) => handle(async () => {
    try {
      const { buildAgentSystemPrompt } = await import("../lib/coding-session-prompt");
      const cwd = req?.cwd ?? ctx.workspacePath ?? process.cwd();
      const text = buildAgentSystemPrompt({
        projectName: req?.projectName ?? "Project",
        cwd,
        taskTitle: req?.taskTitle,
        mode: "execute",
        role: "default",
      });
      return { text };
    } catch (err) {
      return { text: "", error: errMsg(err) };
    }
  }));

  // ── Tool inventory (per-surface) ─────────────────────────────────────
  // What the model can call differs per surface; computed from the engine's own toolsets.
  registerContractHandle("runtime:tools:inventory", () => handle(async () => {
    try {
      const { buildInventory } = await import("../lib/tool-inventory");
      return { surfaces: await buildInventory() };
    } catch (err) {
      return { surfaces: null, error: errMsg(err) };
    }
  }));

  // ── Embedding model management (via unified runtime) ────────
  registerContractHandle("runtime:embeddings:status", () => handle(() => {
    return runtime.getEmbeddingsStatus();
  }));

  registerContractHandle("runtime:embeddings:ensureStarted", () => handle(async () => {
    await runtime.ensureStarted();
    return { ok: true as const };
  }));

  registerContractHandle("runtime:embeddings:models", () => handle(async () => {
    return { models: await runtime.listEmbeddingModels() };
  }));

  registerContractHandle("runtime:embeddings:install", (_e, { modelId }) => handle(async () => {
    await runtime.installEmbeddingModel(modelId);
    return { ok: true as const };
  }));

  registerContractHandle("runtime:embeddings:remove", (_e, { modelId }) => handle(async () => {
    await runtime.removeEmbeddingModel(modelId);
    return { ok: true as const };
  }));

  registerContractHandle("runtime:embeddings:setDefault", (_e, { modelId }) => handle(async () => {
    await runtime.setDefaultEmbeddingModel(modelId);
    return { ok: true as const };
  }));

}
