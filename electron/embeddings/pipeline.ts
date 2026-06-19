import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";
import type { NomicTask } from "./types";
import { NOMIC_MODEL_ID, NOMIC_DIM } from "./types";
import { withNomicPrefix } from "./nomic";

env.allowLocalModels = false;
env.useBrowserCache = false;

export interface EmbedProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export type ProgressCallback = (p: EmbedProgress) => void;

let _extractor: Promise<FeatureExtractionPipeline> | null = null;
let _loadedModelId: string | null = null;

export function setCacheDir(dir: string): void {
  env.cacheDir = dir;
}

export function isLoaded(): boolean {
  return _extractor !== null && _loadedModelId !== null;
}

export function loadedModelId(): string | null {
  return _loadedModelId;
}

export async function loadPipeline(
  modelId: string = NOMIC_MODEL_ID,
  onProgress?: ProgressCallback,
): Promise<FeatureExtractionPipeline> {
  if (_extractor && _loadedModelId === modelId) return _extractor;
  _extractor = pipeline("feature-extraction", modelId, {
    quantized: true,
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
  }).catch((err) => {
    if (_loadedModelId === modelId) {
      _extractor = null;
      _loadedModelId = null;
    }
    throw err;
  });
  _loadedModelId = modelId;
  return _extractor;
}

export async function embed(
  texts: string[],
  task: NomicTask,
  modelId: string = NOMIC_MODEL_ID,
): Promise<number[][]> {
  const pipe = await loadPipeline(modelId);
  const prefixed = texts.map((t) => withNomicPrefix(task, t));
  const output = (await pipe(prefixed, { pooling: "mean", normalize: true })) as {
    tolist: () => unknown[];
  };
  const vectors = output.tolist() as number[][];
  for (const v of vectors) {
    if (v.length !== NOMIC_DIM) {
      throw new Error(`embed: expected dim ${NOMIC_DIM}, got ${v.length}`);
    }
  }
  return vectors;
}

export function resetPipeline(): void {
  _extractor = null;
  _loadedModelId = null;
}
