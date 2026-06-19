import * as z from "zod";

export type NomicTask = "search_document" | "search_query" | "clustering";

export const NOMIC_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";

export const NOMIC_DIM = 768;

export const EmbedRequest = z.object({
  texts: z.array(z.string()).min(1).max(64),
  task: z.enum(["search_document", "search_query", "clustering"]),
  model: z.string().optional(),
});

export type EmbedRequestT = z.infer<typeof EmbedRequest>;

export const EmbedResponse = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number(),
  model: z.string(),
});

export type EmbedResponseT = z.infer<typeof EmbedResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  model: z.string().nullable(),
  loaded: z.boolean(),
});

export type HealthResponseT = z.infer<typeof HealthResponse>;

export interface EmbeddingRecord {
  noteId: string;
  workspaceId: string;
  model: string;
  task: NomicTask;
  contentHash: string;
  vector: number[];
  embeddedAt: string;
  dimX: number | null;
  dimY: number | null;
  projStale: number;
}

export type EmbeddedVector = {
  noteId: string;
  vector: Float32Array;
};

export interface EmbeddingModelManifestEntry {
  id: string;
  name: string;
  repo: string;
  dim: number;
  maxTokens: number;
  sizeBytes: number;
  status: "not_downloaded" | "downloading" | "installed" | "error";
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
}

export interface EmbeddingsStatus {
  running: boolean;
  port: number | null;
  activeModelId: string | null;
  defaultModelId: string | null;
  installed: boolean;
  error: string | null;
  reindexInProgress: boolean;
  recomputeInProgress: boolean;
  lastReindexDone: number;
  lastReindexTotal: number;
  lastRecomputeDone: number;
  lastRecomputeTotal: number;
}

export interface EmbeddingsConfig {
  enabled: boolean;
  modelId: string;
}

export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = {
  enabled: false,
  modelId: NOMIC_MODEL_ID,
};
