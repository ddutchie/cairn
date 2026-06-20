import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

import { EMBED_MODEL_ID, EMBED_DIM } from "./types";
import type { EmbeddingModelManifestEntry } from "./types";

export const MODELS_DIR = path.join(app.getPath("userData"), "embedding-models");
const MANIFEST_PATH = path.join(MODELS_DIR, "manifest.json");
const DEFAULT_MODEL_PATH = path.join(MODELS_DIR, "default-model.json");

export interface SupportedEmbeddingModel {
  id: string;
  name: string;
  repo: string;
  dim: number;
  maxTokens: number;
  sizeBytes: number;
}

export const SUPPORTED_EMBEDDING_MODELS: Record<string, SupportedEmbeddingModel> = {
  [EMBED_MODEL_ID]: {
    id: EMBED_MODEL_ID,
    name: "BGE Small English v1.5 (int8 quantised)",
    repo: "Xenova/bge-small-en-v1.5",
    dim: EMBED_DIM,
    maxTokens: 512,
    sizeBytes: 33_000_000,
  },
};

function readManifestFile(): Record<string, Partial<EmbeddingModelManifestEntry>> {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeManifestFile(data: Record<string, Partial<EmbeddingModelManifestEntry>>): void {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2), "utf8");
}

function modelFilesPresent(modelId: string): boolean {
  if (!fs.existsSync(MODELS_DIR)) return false;
  const [org, name] = modelId.split("/");
  if (!org || !name) return false;
  const nested = path.join(MODELS_DIR, org, name);
  if (!fs.existsSync(nested)) return false;
  const hasConfig = fs.existsSync(path.join(nested, "config.json"));
  const onnxDir = path.join(nested, "onnx");
  const hasOnnx = fs.existsSync(onnxDir)
    && fs.readdirSync(onnxDir).some((f) => f.endsWith(".onnx"));
  return hasConfig && hasOnnx;
}

export function getEmbeddingModelsManifest(): EmbeddingModelManifestEntry[] {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  pruneOrphanedModels();
  const manifest = readManifestFile();
  let updated = false;
  const result: EmbeddingModelManifestEntry[] = [];
  for (const [id, def] of Object.entries(SUPPORTED_EMBEDDING_MODELS)) {
    const diskHas = modelFilesPresent(id);
    const stored = manifest[id] ?? {};
    let status: EmbeddingModelManifestEntry["status"];
    if (stored.status === "downloading" && diskHas) {
      status = "installed";
    } else if (stored.status === "downloading") {
      status = stored.status;
    } else if (diskHas) {
      status = "installed";
    } else {
      status = "not_downloaded";
    }
    const entry: EmbeddingModelManifestEntry = {
      id,
      name: def.name,
      repo: def.repo,
      dim: def.dim,
      maxTokens: def.maxTokens,
      sizeBytes: def.sizeBytes,
      status,
      downloadProgress:
        status === "installed"
          ? 100
          : status === "downloading"
            ? Math.max(0, Math.min(100, stored.downloadProgress ?? 0))
            : 0,
      downloadSpeed: status === "downloading" ? stored.downloadSpeed : undefined,
      error: stored.error,
    };
    result.push(entry);
    if (stored.status !== entry.status) {
      manifest[id] = { status: entry.status };
      updated = true;
    }
  }
  if (updated) writeManifestFile(manifest);
  return result;
}

export function setEmbeddingModelStatus(
  modelId: string,
  status: EmbeddingModelManifestEntry["status"],
  patch?: { progress?: number; speed?: string; error?: string },
): void {
  const manifest = readManifestFile();
  manifest[modelId] = {
    ...manifest[modelId],
    status,
    downloadProgress: patch?.progress,
    downloadSpeed: patch?.speed,
    error: patch?.error,
  };
  writeManifestFile(manifest);
}

export function removeEmbeddingModel(modelId: string): void {
  if (!fs.existsSync(MODELS_DIR)) return;
  const [org, name] = modelId.split("/");
  if (!org || !name) return;
  const nested = path.join(MODELS_DIR, org, name);
  if (fs.existsSync(nested)) {
    try {
      fs.rmSync(nested, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  const orgDir = path.join(MODELS_DIR, org);
  if (fs.existsSync(orgDir)) {
    try {
      const remaining = fs.readdirSync(orgDir);
      if (remaining.length === 0) fs.rmSync(orgDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  setEmbeddingModelStatus(modelId, "not_downloaded", { progress: 0 });
}

export function readDefaultModelId(): string | null {
  if (!fs.existsSync(DEFAULT_MODEL_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(DEFAULT_MODEL_PATH, "utf8"));
    if (typeof data.defaultModelId === "string" && data.defaultModelId) return data.defaultModelId;
  } catch {
    // ignore
  }
  return null;
}

export function writeDefaultModelId(modelId: string): void {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(DEFAULT_MODEL_PATH, JSON.stringify({ defaultModelId: modelId }), "utf8");
}

/**
 * Remove model directories and manifest entries for models no longer in
 * SUPPORTED_EMBEDDING_MODELS. This handles the case where a model swap
 * (e.g. Nomic → bge-small) leaves the old model's ~131 MB of files
 * orphaned on disk. Called automatically by getEmbeddingModelsManifest().
 */
function pruneOrphanedModels(): void {
  if (!fs.existsSync(MODELS_DIR)) return;
  const manifest = readManifestFile();
  let updated = false;

  // Find org/name directories on disk that aren't in SUPPORTED_EMBEDDING_MODELS
  for (const org of fs.readdirSync(MODELS_DIR)) {
    if (org.startsWith(".") || org.endsWith(".json")) continue;
    const orgDir = path.join(MODELS_DIR, org);
    // Use lstatSync to avoid following symlinks — a symlinked org dir could
    // point outside MODELS_DIR, and fs.rmSync(recursive) would follow it.
    let orgStat: fs.Stats;
    try {
      orgStat = fs.lstatSync(orgDir);
    } catch {
      continue;
    }
    if (!orgStat.isDirectory() || orgStat.isSymbolicLink()) continue;
    for (const name of fs.readdirSync(orgDir)) {
      if (name.startsWith(".")) continue;
      const modelId = `${org}/${name}`;
      if (SUPPORTED_EMBEDDING_MODELS[modelId]) continue;
      const modelDir = path.join(orgDir, name);
      // Validate resolved path stays within MODELS_DIR to prevent accidental
      // deletion of directories outside the cache root via path traversal.
      const resolved = path.resolve(modelDir);
      if (!resolved.startsWith(MODELS_DIR + path.sep) && resolved !== MODELS_DIR) {
        console.warn(`[embeddings] skipping orphan prune for ${modelId}: resolved path outside MODELS_DIR`);
        continue;
      }
      try {
        const sizeMB = getDirSizeMB(modelDir);
        fs.rmSync(modelDir, { recursive: true, force: true });
        console.log(`[embeddings] pruned orphaned model: ${modelId} (${sizeMB} MB)`);
        updated = true;
      } catch (e) {
        console.warn(`[embeddings] failed to prune orphaned model ${modelId}:`, e);
      }
    }
    // Remove empty org dir
    try {
      if (fs.existsSync(orgDir) && fs.readdirSync(orgDir).length === 0) {
        fs.rmSync(orgDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  // Clean stale manifest entries
  for (const key of Object.keys(manifest)) {
    if (!SUPPORTED_EMBEDDING_MODELS[key]) {
      delete manifest[key];
      updated = true;
    }
  }

  if (updated) writeManifestFile(manifest);

  // Reset default model ID if it's no longer supported (e.g. after a model swap)
  const defaultId = readDefaultModelId();
  if (defaultId && !SUPPORTED_EMBEDDING_MODELS[defaultId]) {
    writeDefaultModelId(EMBED_MODEL_ID);
    console.log(`[embeddings] reset default model from ${defaultId} to ${EMBED_MODEL_ID}`);
  }
}

function getDirSizeMB(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSizeMB(full);
      } else {
        total += fs.statSync(full).size;
      }
    }
  } catch { /* ignore */ }
  return Math.round(total / 1024 / 1024);
}
