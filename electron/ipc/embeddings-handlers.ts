import type { BrowserWindow } from "electron";

import { registerContractHandle, sendIpcEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import {
  reindexNotes,
  reindexTasks,
  searchAdjacent,
  recomputeProjections,
  type ReindexResult,
  type ProjectionResult,
} from "../embeddings/service";
import { computeSemanticRelationships } from "../db/graph-queries";
import { getEmbeddingsSettingsCached, saveCachedConfig } from "../lib/config-cache";
import { getNoteProjections } from "../db/queries";
import * as client from "../embeddings/client";
import * as manifest from "../embeddings/manifest";
import { EMBED_MODEL_ID } from "../embeddings/types";
import { reclaimFreeSpace } from "../lib/db-hygiene";
import { errMsg } from "../host-shared/errors";
import type { EmbeddingDownloadProgress } from "../../shared/types/embeddings";

interface LockSlot {
  current: Promise<unknown> | null;
  label: string;
  setFlag: (v: boolean) => void;
  setLast: (done: number, total: number) => void;
}

const reindexSlot: LockSlot = {
  current: null,
  label: "Reindex",
  setFlag: client.setReindexInProgress,
  setLast: client.setLastReindexProgress,
};
const recomputeSlot: LockSlot = {
  current: null,
  label: "Recompute projections",
  setFlag: client.setRecomputeInProgress,
  setLast: client.setLastRecomputeProgress,
};

async function withLock<T>(
  slot: LockSlot,
  win: BrowserWindow | null,
  fn: (onProgress: (done: number, total: number) => void) => Promise<T>,
): Promise<T> {
  if (slot.current) {
    const msg = `${slot.label} already in progress — ignoring duplicate call`;
    console.warn(`[embeddings] ${msg}`);
    broadcastProgress(win, { modelId: "", status: "duplicate", error: msg });
    throw new Error(msg);
  }
  slot.setFlag(true);
  slot.setLast(0, 0);
  broadcastProgress(win, { modelId: "", status: "progress", loaded: 0, total: 0, progress: 0 });
  const p = (async () => {
    return fn((done, total) => {
      slot.setLast(done, total);
      broadcastProgress(win, {
        modelId: "",
        status: "progress",
        loaded: done,
        total,
        progress: total > 0 ? Math.round((done / total) * 100) : 0,
      });
    });
  })();
  slot.current = p;
  let failed: unknown = null;
  try {
    return await p as T;
  } catch (e) {
    failed = e;
    throw e;
  } finally {
    slot.setFlag(false);
    if (failed) {
      broadcastProgress(win, {
        modelId: "",
        status: "error",
        error: errMsg(failed),
      });
    } else {
      broadcastProgress(win, { modelId: "", status: "done", progress: 100, loaded: 1, total: 1 });
    }
    if (slot.current === p) slot.current = null;
  }
}

/**
 * Resolve the active embeddings model id and self-heal the persisted cache
 * when it diverges from a model still in `SUPPORTED_EMBEDDING_MODELS`.
 *
 * Self-heal matters: the renderer reads `embeddings.modelId` from the cache
 * and ships it on every reindex / recompute call. If the cached id is stale
 * (e.g. nomic after the v2.1.4 model swap), the renderer would keep forwarding
 * a model the embeddings server can no longer load — even though the
 * server-side default had been correctly reset by `pruneOrphanedModels()`.
 * Writing the corrected value back to the cache stops the renderer from ever
 * seeing the stale id again.
 *
 * `explicit` (caller-supplied arg, e.g. from a UI settings page) wins if it's
 * supported; otherwise the cached value is tried; then the stored default;
 * finally `EMBED_MODEL_ID`.
 */
function resolveModelId(explicit?: string | null): string {
  const settings = getEmbeddingsSettingsCached();
  const modelId = client.resolveEmbeddingModelId(
    explicit,
    settings.modelId,
    client.getDefaultModelId(),
  );
  if (settings.modelId !== modelId) {
    console.log(
      `[embeddings] self-healing stale cached modelId: ` +
        `${settings.modelId ?? "(none)"} → ${modelId}`,
    );
    saveCachedConfig("embeddings", { modelId });
    manifest.writeDefaultModelId(modelId);
  }
  return modelId;
}

export function registerEmbeddingsHandlers(ctx: DbContext): void {
  registerContractHandle("embeddings:needsReindex", () => handle(async () => {
    const settings = getEmbeddingsSettingsCached();
    if (!settings.enabled) return { needed: false, reason: null };
    // Self-heal so a stale cached modelId can't mask a real mismatch.
    const model = resolveModelId(settings.modelId);
    // Check for any row whose model doesn't match the current configured model.
    // Using WHERE model != ? returns a row only if a mismatch exists, regardless
    // of how many distinct models are stored (handles partial reindex states).
    // Check BOTH note and task embeddings so a model change forces both to reindex.
    const noteRow = ctx.db.prepare(
      "SELECT 1 FROM note_embeddings WHERE model != ? LIMIT 1",
    ).get(model) as { 1?: number } | undefined;
    const taskRow = ctx.db.prepare(
      "SELECT 1 FROM task_embeddings WHERE model != ? LIMIT 1",
    ).get(model) as { 1?: number } | undefined;
    if (noteRow || taskRow) {
      return { needed: true, reason: "model_changed" as const };
    }
    return { needed: false, reason: null };
  }));

  registerContractHandle("db:embeddings:reindex", (_e, args) => handle(async () => {
    const model = resolveModelId(args.model);
    const result = await withLock(
      reindexSlot,
      ctx.getWin(),
      async (onProgress) => {
        const r = await reindexNotes(ctx.db, args.workspaceId, args.noteIds, model, undefined, onProgress);
        // On a full pass (no specific noteIds), also (re)embed all task cards so
        // semantic task search stays current. Runs INSIDE the lock so it completes
        // before the "done" status broadcasts. Best-effort; failures don't block notes.
        if (!args.noteIds) {
          try {
            await reindexTasks(ctx.db, args.workspaceId, undefined, model);
          } catch (e) {
            console.warn("[embeddings] task reindex during full pass failed:", e instanceof Error ? e.message : e);
          }
        }
        return r;
      },
    ) as ReindexResult;
    if (result.total > 0) {
      try {
        computeSemanticRelationships(ctx.db, args.workspaceId, args.noteIds);
      } catch (e) {
        console.warn("[embeddings] semantic recompute after reindex failed:", e instanceof Error ? e.message : e);
      }
    }
    // Reindexing DELETEs + re-inserts vector rows — drain the resulting free
    // pages so the file doesn't balloon (incremental vacuum, cheap).
    reclaimFreeSpace(ctx.db);
    return result;
  }));

  registerContractHandle("db:embeddings:search", (_e, args) => handle(async () => {
    const model = resolveModelId(args.model);
    const exclude = [
      ...(args.excludeIds ?? []),
      ...(args.queryNoteId ? [args.queryNoteId] : []),
    ];
    return searchAdjacent(
      ctx.db,
      args.workspaceId,
      args.queryText,
      args.k ?? 5,
      exclude,
      model,
    );
  }));

  registerContractHandle("db:embeddings:recomputeProjections", (_e, args) => handle(async () => {
    const model = resolveModelId(args.model);
    const result = await withLock(
      recomputeSlot,
      ctx.getWin(),
      (onProgress) => recomputeProjections(ctx.db, args.workspaceId, model, undefined, onProgress),
    ) as ProjectionResult;
    reclaimFreeSpace(ctx.db);
    return result;
  }));

  registerContractHandle("embeddings:status", () => handle(() => client.getStatus()));

  registerContractHandle("embeddings:projections", (_e, args) => handle(() => {
    const { rows, anyStale } = getNoteProjections(ctx.db, args.workspaceId);
    const model = resolveModelId();
    return { rows, anyStale, model };
  }));

  registerContractHandle("embeddings:stop", () => handle(() => client.stopWorker({ force: true })));

  registerContractHandle("embeddings:models:list", () => handle(() => manifest.getEmbeddingModelsManifest()));

  registerContractHandle("embeddings:models:install", (_e, args) => handle(async () => {
    const modelId = args.modelId ?? EMBED_MODEL_ID;
    manifest.setEmbeddingModelStatus(modelId, "downloading", { progress: 0 });
    broadcastProgress(ctx.getWin(), { modelId, status: "downloading", progress: 0 });
    const off = client.onProgress((ev) => {
      if (ev.modelId !== modelId) return;
      if (ev.kind === "ready") {
        manifest.setEmbeddingModelStatus(modelId, "installed", { progress: 100 });
        broadcastProgress(ctx.getWin(), { modelId, status: "installed", progress: 100 });
        return;
      }
      manifest.setEmbeddingModelStatus(modelId, "downloading", {
        progress: ev.progress,
        error: undefined,
      });
      broadcastProgress(ctx.getWin(), {
        modelId,
        status: ev.status,
        file: ev.file,
        progress: ev.progress,
        loaded: ev.loaded,
        total: ev.total,
      });
    });
    try {
      await client.embed(["warm up"], "search_query", modelId);
      manifest.setEmbeddingModelStatus(modelId, "installed", { progress: 100 });
      broadcastProgress(ctx.getWin(), { modelId, status: "installed", progress: 100 });
    } catch (e) {
      const msg = errMsg(e);
      const isInstalled = manifest.getEmbeddingModelsManifest().find((m) => m.id === modelId)?.status === "installed";
      if (isInstalled) {
        console.warn("[embeddings] install pipeline failed but files present; marking installed anyway:", msg);
        manifest.setEmbeddingModelStatus(modelId, "installed", { progress: 100 });
        broadcastProgress(ctx.getWin(), { modelId, status: "installed", progress: 100 });
      } else {
        manifest.setEmbeddingModelStatus(modelId, "not_downloaded", { progress: 0, error: msg });
        broadcastProgress(ctx.getWin(), { modelId, status: "error", error: msg });
        throw e;
      }
    } finally {
      off();
    }
    return { ok: true as const };
  }));

  registerContractHandle("embeddings:models:remove", (_e, args) => handle(() => {
    manifest.removeEmbeddingModel(args.modelId);
    return { ok: true as const };
  }));

  registerContractHandle("embeddings:models:setDefault", (_e, args) => handle(() => {
    manifest.writeDefaultModelId(args.modelId);
    return { ok: true as const };
  }));
}

type ProgressBroadcast = EmbeddingDownloadProgress;

function broadcastProgress(win: BrowserWindow | null, payload: ProgressBroadcast): void {
  if (win && !win.isDestroyed()) {
    sendIpcEvent(win.webContents, "embeddings:download-progress", payload);
  }
}
