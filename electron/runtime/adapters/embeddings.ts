import * as fs from "fs";
import * as path from "path";

import { AutoTokenizer, env, type PreTrainedTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";

import type {
  AdapterConfig,
  AdapterHealth,
  AdapterModelEntry,
  AdapterStatus,
  ModelManagingAdapter,
} from "./types";
import type { EmbedTask } from "../../embeddings/types";
import { EMBED_MODEL_ID, EMBED_DIM } from "../../embeddings/types";
import { withTaskPrefix } from "../../embeddings/prefix";
import { verifyModel, verifyOnDisk } from "../model-manager";

export interface EmbedProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

type ProgressCallback = (p: EmbedProgress) => void;

interface LoadedPipeline {
  tokenizer: PreTrainedTokenizer;
  session: ort.InferenceSession;
  modelId: string;
}

export const SUPPORTED_EMBEDDING_MODELS: Record<
  string,
  Omit<AdapterModelEntry, "status" | "downloadProgress" | "downloadSpeed" | "error" | "meta"> & {
    meta: { dim: number; maxTokens: number; filename: string; sha256: string };
  }
> = {
  [EMBED_MODEL_ID]: {
    id: EMBED_MODEL_ID,
    name: "BGE Small EN v1.5 (int8)",
    repo: "Xenova/bge-small-en-v1.5",
    sizeBytes: 34_014_426,
    meta: { dim: EMBED_DIM, maxTokens: 512, filename: "onnx/model_quantized.onnx", sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
  },
};

export function isSupportedEmbeddingModel(modelId: string): boolean {
  return modelId in SUPPORTED_EMBEDDING_MODELS;
}

env.allowLocalModels = false;
env.useBrowserCache = false;

export class EmbeddingsAdapter implements ModelManagingAdapter {
  readonly id = "onnx";
  readonly kind = "embedding" as const;

  private config: AdapterConfig;
  private manifestPath: string;
  private defaultModelPath: string;
  private _pipeline: LoadedPipeline | null = null;
  private _pipelinePromise: Promise<LoadedPipeline> | null = null;
  private _pipelinePromiseModelId: string | null = null;
  private _cacheDir: string;

  constructor(config: AdapterConfig) {
    this.config = config;
    this._cacheDir = config.modelsDir;
    this.manifestPath = path.join(config.modelsDir, "manifest.json");
    this.defaultModelPath = path.join(config.modelsDir, "default-model.json");
    env.cacheDir = this._cacheDir;
  }

  // ── Model management ──────────────────────────────────────────

  listModels(): AdapterModelEntry[] {
    const manifest = this.readManifest();
    const result: AdapterModelEntry[] = [];
    for (const [id, def] of Object.entries(SUPPORTED_EMBEDDING_MODELS)) {
      const entry = manifest[id] ?? { status: "not_downloaded" as const, downloadProgress: 0 };
      // Check if files exist and verify checksum
      let status = entry.status;
      if (this.modelFilesPresent(id)) {
        if (status !== "installed") {
          // Files exist but manifest not marked — verify and update
          const onnxPath = path.join(this._cacheDir, id, def.meta.filename);
          status = verifyOnDisk(this.manifestPath, id, onnxPath, def.meta.sha256) ? "installed" : "not_downloaded";
        }
      } else if (status === "installed") {
        // Manifest says installed but files missing
        status = "not_downloaded";
        this.updateManifestEntry(id, { status: "not_downloaded", downloadProgress: 0 });
      }
      result.push({
        id,
        name: def.name,
        repo: def.repo,
        sizeBytes: def.sizeBytes,
        status,
        downloadProgress: status === "installed" ? 100 : entry.downloadProgress,
        downloadSpeed: entry.downloadSpeed,
        error: entry.error,
        meta: def.meta,
      });
    }
    return result;
  }

  isModelInstalled(modelId: string): boolean {
    const def = SUPPORTED_EMBEDDING_MODELS[modelId];
    if (!def) return false;
    if (!this.modelFilesPresent(modelId)) return false;
    // Verify checksum of the main ONNX file if defined
    const onnxPath = path.join(this._cacheDir, modelId, def.meta.filename);
    return verifyOnDisk(this.manifestPath, modelId, onnxPath, def.meta.sha256);
  }

  /** Check if the model's required files are present on disk. */
  private modelFilesPresent(modelId: string): boolean {
    const tokenizerPath = path.join(this._cacheDir, modelId, "tokenizer.json");
    const onnxDir = path.join(this._cacheDir, modelId, "onnx");
    return fs.existsSync(tokenizerPath) && fs.existsSync(onnxDir) && fs.readdirSync(onnxDir).some((f) => f.endsWith(".onnx"));
  }

  async installModel(modelId: string): Promise<void> {
    if (!SUPPORTED_EMBEDDING_MODELS[modelId]) {
      throw new Error(`Model ${modelId} is not supported.`);
    }
    // Warming up the pipeline triggers HF Hub download with progress callbacks.
    this.updateManifestEntry(modelId, { status: "downloading", downloadProgress: 0, error: undefined });
    try {
      await this.loadPipeline(modelId, (p) => {
        this.config.onProgress?.({
          type: "load",
          modelId,
          status: p.status,
          file: p.file,
          progress: p.progress,
          loaded: p.loaded,
          total: p.total,
        });
      });
      // Verify SHA256 of the main ONNX file after download
      const def = SUPPORTED_EMBEDDING_MODELS[modelId];
      const onnxPath = path.join(this._cacheDir, modelId, def.meta.filename);
      if (def.meta.sha256 && fs.existsSync(onnxPath)) {
        if (!verifyModel(onnxPath, def.meta.sha256)) {
          this.updateManifestEntry(modelId, {
            status: "error",
            error: `SHA256 checksum verification failed for ${modelId}. The downloaded ONNX file may be corrupted.`,
          });
          throw new Error(`SHA256 checksum verification failed for ${modelId}.`);
        }
      }
      this.updateManifestEntry(modelId, { status: "installed", downloadProgress: 100, downloadSpeed: undefined, verifiedAt: new Date().toISOString() });
      this.config.onProgress?.({ type: "ready", modelId });
    } catch (err) {
      this.updateManifestEntry(modelId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  removeModel(modelId: string): void {
    if (!SUPPORTED_EMBEDDING_MODELS[modelId]) return;
    const modelDir = path.join(this._cacheDir, modelId);
    if (fs.existsSync(modelDir)) {
      fs.rmSync(modelDir, { recursive: true, force: true });
    }
    this.updateManifestEntry(modelId, { status: "not_downloaded", downloadProgress: 0, downloadSpeed: undefined, error: undefined });
    if (this.getDefaultModelId() === modelId) {
      this.setDefaultModelId(EMBED_MODEL_ID);
    }
    if (this._pipeline?.modelId === modelId) {
      this.resetPipeline();
    }
  }

  getDefaultModelId(): string | null {
    if (fs.existsSync(this.defaultModelPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.defaultModelPath, "utf8"));
        return data.defaultModelId || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  setDefaultModelId(modelId: string): void {
    try {
      fs.mkdirSync(path.dirname(this.defaultModelPath), { recursive: true });
      fs.writeFileSync(this.defaultModelPath, JSON.stringify({ defaultModelId: modelId }), "utf8");
    } catch (e) {
      console.error("[embeddings-adapter] Failed to save default model:", e);
    }
  }

  // ── Pipeline lifecycle ────────────────────────────────────────

  async start(modelId: string): Promise<{ port: number }> {
    // Embeddings adapter runs in-process — no port needed, but we return 0 for interface compliance.
    // The runtime server handles HTTP; the adapter just loads the model.
    if (this._pipeline?.modelId === modelId) return { port: 0 };
    await this.loadPipeline(modelId, (p) => {
      this.config.onProgress?.({
        type: "load",
        modelId,
        status: p.status,
        file: p.file,
        progress: p.progress,
        loaded: p.loaded,
        total: p.total,
      });
    });
    this.config.onProgress?.({ type: "ready", modelId });
    return { port: 0 };
  }

  async stop(): Promise<void> {
    this.resetPipeline();
  }

  async health(): Promise<AdapterHealth> {
    return {
      healthy: this._pipeline !== null,
      model: this._pipeline?.modelId ?? null,
      loaded: this._pipeline !== null,
    };
  }

  status(): AdapterStatus {
    return {
      kind: this.kind,
      running: this._pipeline !== null,
      model: this._pipeline?.modelId ?? null,
      port: null,
      error: null,
    };
  }

  async dispose(): Promise<void> {
    this.resetPipeline();
  }

  // ── Embedding inference ───────────────────────────────────────

  async embed(
    texts: string[],
    task: EmbedTask,
    modelId?: string,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const resolved = modelId ?? this._pipeline?.modelId ?? this.getDefaultModelId() ?? EMBED_MODEL_ID;
    const pipe = await this.loadPipeline(resolved);
    const prefixed = texts.map((t) => withTaskPrefix(task, t));

    const encoded = await pipe.tokenizer(prefixed, { padding: true, truncation: true });
    const batchSize = encoded.input_ids.dims[0];
    const seqLen = encoded.input_ids.dims[1];
    const total = batchSize * seqLen;

    const inputIdsData = new BigInt64Array(total);
    const attentionData = new BigInt64Array(total);
    const tokenTypeData = new BigInt64Array(total);
    for (let i = 0; i < total; i++) {
      inputIdsData[i] = encoded.input_ids.data[i];
      attentionData[i] = encoded.attention_mask.data[i];
      if (encoded.token_type_ids) tokenTypeData[i] = encoded.token_type_ids.data[i];
    }

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", inputIdsData, [batchSize, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionData, [batchSize, seqLen]),
      token_type_ids: new ort.Tensor("int64", tokenTypeData, [batchSize, seqLen]),
    };

    const output = await pipe.session.run(feeds);
    const lastHidden = output.last_hidden_state;
    const dims = lastHidden.dims;
    const hidden = dims[2];
    const data = lastHidden.data as Float32Array;

    const vectors: number[][] = [];
    for (let b = 0; b < dims[0]; b++) {
      const sumVec = new Float32Array(hidden);
      let count = 0;
      for (let s = 0; s < dims[1]; s++) {
        if (attentionData[b * seqLen + s] === 0n) continue;
        const offset = (b * dims[1] + s) * hidden;
        for (let h = 0; h < hidden; h++) sumVec[h] += data[offset + h];
        count++;
      }
      if (count > 0) for (let h = 0; h < hidden; h++) sumVec[h] /= count;
      let norm = 0;
      for (let h = 0; h < hidden; h++) norm += sumVec[h] * sumVec[h];
      norm = Math.sqrt(norm);
      if (norm < 1e-9) norm = 1e-9;
      for (let h = 0; h < hidden; h++) sumVec[h] /= norm;
      vectors.push(Array.from(sumVec));
    }

    for (const v of vectors) {
      if (v.length !== EMBED_DIM) {
        throw new Error(`embed: expected dim ${EMBED_DIM}, got ${v.length}`);
      }
    }
    return vectors;
  }

  // ── Pipeline loading (ported from pipeline.ts) ────────────────

  async loadPipeline(
    modelId: string = EMBED_MODEL_ID,
    onProgress?: ProgressCallback,
  ): Promise<LoadedPipeline> {
    if (this._pipeline && this._pipeline.modelId === modelId) return this._pipeline;
    if (this._pipelinePromise && this._pipelinePromiseModelId === modelId) return this._pipelinePromise;

    this._pipelinePromiseModelId = modelId;

    this._pipelinePromise = (async () => {
      onProgress?.({ status: "initiate" });

      const tokenizer = await AutoTokenizer.from_pretrained(modelId, {
        progress_callback: onProgress
          ? (data: unknown) => {
              if (data && typeof data === "object") {
                const d = data as Record<string, unknown>;
                onProgress({
                  status: typeof d.status === "string" ? d.status : "unknown",
                  file: typeof d.file === "string" ? d.file : undefined,
                  progress: typeof d.progress === "number" ? d.progress : undefined,
                  loaded: typeof d.loaded === "number" ? d.loaded : undefined,
                  total: typeof d.total === "number" ? d.total : undefined,
                });
              }
            }
          : undefined,
      });

      const modelPath = `${this._cacheDir}/${modelId}/onnx/model_quantized.onnx`;
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: false,
        enableMemPattern: false,
      });

      this._pipeline = { tokenizer, session, modelId };
      onProgress?.({ status: "ready" });
      return this._pipeline;
    })().catch((err) => {
      this._pipelinePromise = null;
      this._pipelinePromiseModelId = null;
      throw err;
    });

    return this._pipelinePromise;
  }

  resetPipeline(): void {
    this._pipeline = null;
    this._pipelinePromise = null;
    this._pipelinePromiseModelId = null;
  }

  // ── Manifest helpers ─────────────────────────────────────────

  private readManifest(): Record<string, { status: "not_downloaded" | "downloading" | "installed" | "error"; downloadProgress: number; downloadSpeed?: string; error?: string }> {
    if (!fs.existsSync(this.manifestPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
    } catch {
      return {};
    }
  }

  private writeManifest(manifest: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    } catch (e) {
      console.error("[embeddings-adapter] Failed to write manifest:", e);
    }
  }

  private updateManifestEntry(modelId: string, patch: Record<string, unknown>): void {
    const manifest = this.readManifest();
    (manifest as Record<string, unknown>)[modelId] = { ...(manifest[modelId] ?? {}), ...patch };
    this.writeManifest(manifest);
  }
}
