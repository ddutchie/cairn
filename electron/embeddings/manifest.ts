import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

import { NOMIC_MODEL_ID, NOMIC_DIM } from "./types";
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
  [NOMIC_MODEL_ID]: {
    id: NOMIC_MODEL_ID,
    name: "Nomic Embed Text v1.5 (int8 quantised)",
    repo: "nomic-ai/nomic-embed-text-v1.5",
    dim: NOMIC_DIM,
    maxTokens: 8192,
    sizeBytes: 91_000_000,
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
