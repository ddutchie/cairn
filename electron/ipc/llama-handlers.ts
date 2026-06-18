/**
 * Cairn — IPC handlers for the on-device Llama server (`llama:*` channels).
 *
 * These use `require()` for `../lib/llama-server` so the heavy llama.cpp wrapper
 * module isn't loaded into the Electron process unless the user actually invokes
 * a llama tool. The eslint-disable covers the intentional dynamic requires.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";

export function registerLlamaHandlers(ctx: DbContext): void {
  registerIpcHandle("llama:models:list", () => handle(() => {
    const { listModels } = require("../lib/llama-server");
    return listModels();
  }));

  registerIpcHandle("llama:models:install", (_e, { modelId, useMirror }) => handle(async () => {
    const { installModel } = require("../lib/llama-server");
    return await installModel(modelId, ctx.getWin, useMirror);
  }));

  registerIpcHandle("llama:binary:install", () => handle(async () => {
    const { installLlamaBinary } = require("../lib/llama-server");
    return await installLlamaBinary(ctx.getWin);
  }));

  registerIpcHandle("llama:binary:check-update", () => handle(async () => {
    const { checkLlamaUpdates } = require("../lib/llama-server");
    return await checkLlamaUpdates();
  }));

  registerIpcHandle("llama:models:remove", (_e, { modelId }) => handle(() => {
    const { removeModel } = require("../lib/llama-server");
    return removeModel(modelId);
  }));

  registerIpcHandle("llama:models:clearInactive", () => handle(() => {
    const { clearInactiveModels } = require("../lib/llama-server");
    return clearInactiveModels();
  }));

  registerIpcHandle("llama:server:start", (_e, { modelId, contextLimit }: { modelId: string; contextLimit?: number }) => handle(async () => {
    const { startServer } = require("../lib/llama-server");
    const port = await startServer(modelId, contextLimit);
    return { port };
  }));

  registerIpcHandle("llama:server:setDefault", (_e, { modelId }) => handle(() => {
    const { setDefaultModelId } = require("../lib/llama-server");
    setDefaultModelId(modelId);
    return { success: true };
  }));

  registerIpcHandle("llama:server:stop", () => handle(async () => {
    const { stopServer } = require("../lib/llama-server");
    return await stopServer();
  }));

  registerIpcHandle("llama:server:status", () => handle(async () => {
    const { getServerStatus } = require("../lib/llama-server");
    return await getServerStatus();
  }));
}
