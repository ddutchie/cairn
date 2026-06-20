import type { BrowserWindow } from "electron";

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import {
  reindexNotes,
  searchAdjacent,
  recomputeProjections,
  type ReindexResult,
  type ProjectionResult,
} from "../embeddings/service";
import { computeSemanticRelationships } from "../db/graph-queries";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";
import { getNoteProjections } from "../db/queries";
import * as client from "../embeddings/client";
import * as manifest from "../embeddings/manifest";
import { EMBED_MODEL_ID } from "../embeddings/types";

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
        error: failed instanceof Error ? failed.message : String(failed),
      });
    } else {
      broadcastProgress(win, { modelId: "", status: "done", progress: 100, loaded: 1, total: 1 });
    }
    if (slot.current === p) slot.current = null;
  }
}

export function registerEmbeddingsHandlers(ctx: DbContext): void {
  registerIpcHandle("embeddings:needsReindex", () => handle(async () => {
    const settings = getEmbeddingsSettingsCached();
    if (!settings.enabled) return { needed: false, reason: null };
    const model = settings.modelId ?? client.getDefaultModelId() ?? EMBED_MODEL_ID;
    const row = ctx.db.prepare(
      "SELECT DISTINCT model FROM note_embeddings LIMIT 1",
    ).get() as { model?: string } | undefined;
    if (!row) return { needed: false, reason: null };
    if (row.model !== model) {
      return { needed: true, reason: "model_changed" as const };
    }
    return { needed: false, reason: null };
  }));

  registerIpcHandle("db:embeddings:reindex", (_e, args: {
    workspaceId: string;
    noteIds?: string[];
    model?: string;
  }) => handle(async () => {
    const model = args.model ?? client.getDefaultModelId() ?? EMBED_MODEL_ID;
    const result = await withLock(
      reindexSlot,
      ctx.getWin(),
      (onProgress) => reindexNotes(ctx.db, args.workspaceId, args.noteIds, model, undefined, onProgress),
    ) as ReindexResult;
    if (result.total > 0) {
      try {
        computeSemanticRelationships(ctx.db, args.workspaceId, args.noteIds);
      } catch (e) {
        console.warn("[embeddings] semantic recompute after reindex failed:", e instanceof Error ? e.message : e);
      }
    }
    return result;
  }));

  registerIpcHandle("db:embeddings:search", (_e, args: {
    workspaceId: string;
    queryText: string;
    queryNoteId?: string;
    k?: number;
    excludeIds?: string[];
    model?: string;
  }) => handle(async () => {
    const model = args.model ?? client.getDefaultModelId() ?? EMBED_MODEL_ID;
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

  registerIpcHandle("db:embeddings:recomputeProjections", (_e, args: {
    workspaceId: string;
    model?: string;
  }) => handle(async () => {
    const model = args.model ?? client.getDefaultModelId() ?? EMBED_MODEL_ID;
    return withLock(
      recomputeSlot,
      ctx.getWin(),
      (onProgress) => recomputeProjections(ctx.db, args.workspaceId, model, undefined, onProgress),
    ) as Promise<ProjectionResult>;
  }));

  registerIpcHandle("embeddings:status", () => handle(() => client.getStatus()));

  registerIpcHandle("embeddings:projections", (_e, args: { workspaceId: string }) => handle(() => {
    const { rows, anyStale } = getNoteProjections(ctx.db, args.workspaceId);
    const settings = getEmbeddingsSettingsCached();
    const model = settings.modelId ?? client.getDefaultModelId() ?? EMBED_MODEL_ID;
    return { rows, anyStale, model };
  }));

  registerIpcHandle("embeddings:stop", () => handle(() => client.stopWorker({ force: true })));

  registerIpcHandle("embeddings:models:list", () => handle(() => manifest.getEmbeddingModelsManifest()));

  registerIpcHandle("embeddings:models:install", (_e, args: { modelId: string }) => handle(async () => {
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
      const msg = e instanceof Error ? e.message : String(e);
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
    return { ok: true };
  }));

  registerIpcHandle("embeddings:models:remove", (_e, args: { modelId: string }) => handle(() => {
    manifest.removeEmbeddingModel(args.modelId);
    return { ok: true };
  }));

  registerIpcHandle("embeddings:models:setDefault", (_e, args: { modelId: string }) => handle(() => {
    manifest.writeDefaultModelId(args.modelId);
    return { ok: true };
  }));
}

interface ProgressBroadcast {
  modelId: string;
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  error?: string;
}

function broadcastProgress(win: BrowserWindow | null, payload: ProgressBroadcast): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send("embeddings:download-progress", payload);
  }
}
