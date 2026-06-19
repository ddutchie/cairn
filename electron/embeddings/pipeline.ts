import { AutoTokenizer, env, type PreTrainedTokenizer } from "@xenova/transformers";
import * as ort from "onnxruntime-node";
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

interface LoadedPipeline {
  tokenizer: PreTrainedTokenizer;
  session: ort.InferenceSession;
  modelId: string;
}

let _pipeline: LoadedPipeline | null = null;
let _pipelinePromise: Promise<LoadedPipeline> | null = null;
let _pipelinePromiseModelId: string | null = null;

export function setCacheDir(dir: string): void {
  env.cacheDir = dir;
}

export function isLoaded(): boolean {
  return _pipeline !== null;
}

export function loadedModelId(): string | null {
  return _pipeline?.modelId ?? null;
}

export async function loadPipeline(
  modelId: string = NOMIC_MODEL_ID,
  onProgress?: ProgressCallback,
): Promise<LoadedPipeline> {
  if (_pipeline && _pipeline.modelId === modelId) return _pipeline;
  if (_pipelinePromise && _pipelinePromiseModelId === modelId) return _pipelinePromise;

  _pipelinePromiseModelId = modelId;

  _pipelinePromise = (async () => {
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

    const modelPath = `${env.cacheDir || ""}/${modelId}/onnx/model_quantized.onnx`;
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: false,
      enableMemPattern: false,
    });

    _pipeline = { tokenizer, session, modelId };
    onProgress?.({ status: "ready" });
    return _pipeline;
  })().catch((err) => {
    _pipelinePromise = null;
    _pipelinePromiseModelId = null;
    throw err;
  });

  return _pipelinePromise;
}

export async function embed(
  texts: string[],
  task: NomicTask,
  modelId: string = NOMIC_MODEL_ID,
): Promise<number[][]> {
  const pipe = await loadPipeline(modelId);
  const prefixed = texts.map((t) => withNomicPrefix(task, t));

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
    if (v.length !== NOMIC_DIM) {
      throw new Error(`embed: expected dim ${NOMIC_DIM}, got ${v.length}`);
    }
  }
  return vectors;
}

export function resetPipeline(): void {
  _pipeline = null;
  _pipelinePromise = null;
  _pipelinePromiseModelId = null;
}
